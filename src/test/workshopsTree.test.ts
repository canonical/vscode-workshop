import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { WorkshopClient } from '../api/client';
import { AVAILABLE_CONTEXT, WorkshopsTreeProvider } from '../ui/workshopsTree';

/**
 * Run `body` with `vscode.workspace.workspaceFolders` temporarily replaced and
 * `vscode.commands.executeCommand` spying on `setContext` calls, restoring both
 * afterwards. Returns the last value `setContext` was given for
 * {@link AVAILABLE_CONTEXT}.
 */
async function withStubs(
  folders: readonly vscode.WorkspaceFolder[] | undefined,
  body: (provider: WorkshopsTreeProvider) => Promise<void>,
): Promise<boolean | undefined> {
  const foldersDescriptor = Object.getOwnPropertyDescriptor(
    vscode.workspace,
    'workspaceFolders',
  );
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    configurable: true,
    get: () => folders,
  });

  const originalExecute = vscode.commands.executeCommand;
  let available: boolean | undefined;
  (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand =
    ((command: string, ...args: unknown[]) => {
      if (command === 'setContext' && args[0] === AVAILABLE_CONTEXT) {
        available = args[1] as boolean;
        return Promise.resolve(undefined);
      }
      return originalExecute(command, ...(args as []));
    }) as typeof vscode.commands.executeCommand;

  try {
    // Point the client at a socket that does not exist -> unavailable.
    const missingSocket = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'workshopd-')),
      'missing.socket',
    );
    await body(new WorkshopsTreeProvider(new WorkshopClient({ socketPath: missingSocket })));
  } finally {
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand =
      originalExecute;
    if (foldersDescriptor) {
      Object.defineProperty(vscode.workspace, 'workspaceFolders', foldersDescriptor);
    }
  }
  return available;
}

function fakeFolder(fsPath: string): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(fsPath), name: path.basename(fsPath), index: 0 };
}

suite('WorkshopsTreeProvider availability', () => {
  test('sets workshop.available=false and shows no items when daemon is unreachable', async () => {
    let items: vscode.TreeItem[] = [];
    const available = await withStubs([fakeFolder('/repo')], async (provider) => {
      items = await provider.getChildren();
    });

    assert.strictEqual(available, false);
    assert.deepStrictEqual(items, []);
  });
});
