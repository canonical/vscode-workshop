import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { WorkshopClient } from '../api/client';
import { InitError, InitSpec } from '../api/init';
import { LogsView } from '../ui/logsView';
import { WizardDeps, WizardResult } from '../ui/addWorkshopWizard';
import { createWorkshopCommands } from '../workshopCommands';

class MemoryMemento implements vscode.Memento {
  private store = new Map<string, unknown>();
  keys(): readonly string[] { return [...this.store.keys()]; }
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.store.get(key) as T | undefined) ?? defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> { this.store.set(key, value); }
}

type MessageFn = (message: string, ...items: string[]) => Thenable<string | undefined>;
interface Messages { warnings: string[]; errors: string[]; infos: string[] }

/** Intercept notifications and `executeCommand` for the duration of `body`. */
async function capture(
  body: () => Promise<void>,
  infoAnswer: string | undefined = 'Not Now',
): Promise<Messages & { commands: string[] }> {
  const window = vscode.window as unknown as Record<string, unknown>;
  const commands = vscode.commands as unknown as Record<string, unknown>;
  const originals = {
    showWarningMessage: window.showWarningMessage,
    showErrorMessage: window.showErrorMessage,
    showInformationMessage: window.showInformationMessage,
    executeCommand: commands.executeCommand,
  };
  const result: Messages & { commands: string[] } = { warnings: [], errors: [], infos: [], commands: [] };
  window.showWarningMessage = ((m: string) => { result.warnings.push(m); return Promise.resolve(undefined); }) as MessageFn;
  window.showErrorMessage = ((m: string) => { result.errors.push(m); return Promise.resolve(undefined); }) as MessageFn;
  window.showInformationMessage = ((m: string) => { result.infos.push(m); return Promise.resolve(infoAnswer); }) as MessageFn;
  commands.executeCommand = ((command: string, ...args: unknown[]) => {
    result.commands.push(command);
    return (originals.executeCommand as typeof vscode.commands.executeCommand)(command, ...(args as []));
  }) as typeof vscode.commands.executeCommand;
  try {
    await body();
  } finally {
    Object.assign(window, {
      showWarningMessage: originals.showWarningMessage,
      showErrorMessage: originals.showErrorMessage,
      showInformationMessage: originals.showInformationMessage,
    });
    commands.executeCommand = originals.executeCommand;
  }
  return result;
}

suite('addWorkshop command', () => {
  let tmp: string;
  let log: vscode.LogOutputChannel;

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-add-'));
    log = vscode.window.createOutputChannel('Workshop test', { log: true });
  });

  teardown(async () => {
    log.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function result(overrides: Partial<WizardResult> = {}): WizardResult {
    return {
      folder: { name: 'proj', path: tmp },
      sdks: ['node', 'go'],
      base: 'ubuntu@24.04',
      name: 'dev',
      ...overrides,
    };
  }

  function commands(options: {
    folders?: { name: string; path: string }[];
    wizard?: (deps: WizardDeps) => Promise<WizardResult | undefined>;
    runInit?: (spec: InitSpec) => Promise<unknown>;
  }) {
    return createWorkshopCommands({
      client: new WorkshopClient({ socketPath: path.join(tmp, 'missing.socket') }),
      globalState: new MemoryMemento(),
      log,
      logsView: new LogsView(),
      workspaceFolders: () => options.folders ?? [{ name: 'proj', path: tmp }],
      wizard: options.wizard ?? (async () => { throw new Error('wizard should not run'); }),
      runInit: options.runInit ?? (async () => { throw new Error('init should not run'); }),
    });
  }

  /** Behaves like `workshop init`: writes the definition. */
  async function fakeInit(spec: InitSpec): Promise<void> {
    fs.mkdirSync(path.join(spec.folder, '.workshop'), { recursive: true });
    fs.writeFileSync(path.join(spec.folder, '.workshop', `${spec.name}.yaml`), `name: ${spec.name}\n`);
  }

  test('warns and stops when no folder is open', async () => {
    const captured = await capture(() => commands({ folders: [] }).addWorkshop());
    assert.deepStrictEqual(captured.warnings, ['Open a folder first to create a workshop.']);
    assert.deepStrictEqual(captured.errors, []);
  });

  test('is silent when the wizard is aborted', async () => {
    let wizardDeps: WizardDeps | undefined;
    const captured = await capture(() => commands({
      wizard: async (deps) => { wizardDeps = deps; return undefined; },
    }).addWorkshop());
    assert.deepStrictEqual(captured.warnings, []);
    assert.deepStrictEqual(captured.errors, []);
    assert.deepStrictEqual(captured.infos, []);
    assert.deepStrictEqual(wizardDeps?.folders, [{ name: 'proj', path: tmp }]);
  });

  test('creates the workshop, opens it, and refreshes the tree', async () => {
    const specs: InitSpec[] = [];
    const captured = await capture(() => commands({
      wizard: async () => result(),
      runInit: async (spec) => { specs.push(spec); await fakeInit(spec); },
    }).addWorkshop());

    // Channels come from the static catalogue's recommended LTS tracks.
    assert.deepStrictEqual(specs, [{
      folder: tmp,
      name: 'dev',
      base: 'ubuntu@24.04',
      sdks: [{ name: 'node', channel: '24/stable' }, { name: 'go', channel: '1.27/stable' }],
    }]);
    assert.deepStrictEqual(captured.errors, []);
    assert.ok(captured.commands.includes('workshop.poll'));
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      path.join(tmp, '.workshop', 'dev.yaml'),
    );
  });

  test('reports a creation failure with Workshop\'s reason and opens nothing', async () => {
    const reason = 'cannot init: "workshop.yaml" already exists, move it to .workshop/ first to manage multiple workshops';
    const captured = await capture(() => commands({
      wizard: async () => result(),
      runInit: async () => { throw new InitError(reason, 1, `error: ${reason}\n`); },
    }).addWorkshop());

    assert.deepStrictEqual(captured.errors, [reason]);
    assert.deepStrictEqual(captured.infos, []);
    assert.strictEqual(vscode.window.activeTextEditor, undefined);
    assert.ok(!fs.existsSync(path.join(tmp, '.workshop', 'dev.yaml')));
  });

  test('ignores a second invocation while the wizard is open', async () => {
    let runs = 0;
    let finish: (() => void) | undefined;
    const handlers = commands({
      wizard: async () => {
        runs++;
        await new Promise<void>((resolve) => { finish = resolve; });
        return undefined;
      },
    });
    await capture(async () => {
      const first = handlers.addWorkshop();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await handlers.addWorkshop(); // returns immediately
      assert.strictEqual(runs, 1);
      finish?.();
      await first;
      const third = handlers.addWorkshop(); // a new wizard may open now
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.strictEqual(runs, 2);
      finish?.();
      await third;
    });
  });
});
