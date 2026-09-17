import * as assert from 'assert';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { WorkshopClient } from '../api/client';
import { LogsView } from '../ui/logsView';
import { createWorkshopCommands } from '../workshopCommands';
import { WorkshopItem } from '../ui/workshopsTree';
import { Workshop } from '../api/workshops';

class MemoryMemento implements vscode.Memento {
  private store = new Map<string, unknown>();
  keys(): readonly string[] { return [...this.store.keys()]; }
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.store.get(key) as T | undefined) ?? defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> { this.store.set(key, value); }
}

/** Minimal daemon answering the single-workshop info lookup used on reopen. */
function startInfoDaemon(socketPath: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/projects/proj-1/workshops/web') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'sync',
        'status-code': 200,
        result: { 'project-id': 'proj-1', name: 'web', status: 'ready', hostname: 'web.proj-1.wp', base: '' },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

/** Replace `vscode.openFolder` so reopening never actually swaps the window. */
async function withStubbedOpenFolder(body: () => Promise<void>): Promise<void> {
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const original = commands.executeCommand;
  commands.executeCommand = ((command: string, ...args: unknown[]) => {
    if (command === 'vscode.openFolder') {
      return Promise.resolve(undefined);
    }
    return original(command, ...(args as []));
  }) as typeof vscode.commands.executeCommand;
  try {
    await body();
  } finally {
    commands.executeCommand = original;
  }
}

suite('createWorkshopCommands server pre-install wiring', () => {
  let socketPath: string;
  let server: http.Server;
  let log: vscode.LogOutputChannel;

  setup(async () => {
    socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'workshopd-')), 'workshop.socket');
    server = await startInfoDaemon(socketPath);
    log = vscode.window.createOutputChannel('Workshop cmd test', { log: true });
  });

  teardown(async () => {
    log.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('reopen invokes the injected preinstallServer with the resolved hostname', async () => {
    const globalState = new MemoryMemento();
    let seededHostname: string | undefined;
    let resolveSeeded: () => void;
    const seeded = new Promise<void>((resolve) => { resolveSeeded = resolve; });

    const commands = createWorkshopCommands({
      client: new WorkshopClient({ socketPath }),
      globalState,
      log,
      logsView: new LogsView(),
      preinstallServer: async (hostname) => {
        seededHostname = hostname;
        resolveSeeded();
      },
    });

    const workshop: Workshop = {
      name: 'web',
      status: 'On',
      rawStatus: 'ready',
      hostname: 'web.proj-1.wp',
      projectId: 'proj-1',
    };

    await withStubbedOpenFolder(async () => {
      commands.reopenInWorkshop(new WorkshopItem(workshop));
      await seeded;
    });

    assert.strictEqual(seededHostname, 'web.proj-1.wp');
  });
});
