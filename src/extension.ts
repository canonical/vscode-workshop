// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { WorkshopClient } from './api/client';
import { WorkshopPoller } from './poller';
import { listProjectWorkshops, Workshop } from './api/workshops';
import { UNAVAILABLE_CONTEXT, WorkshopsTreeProvider, WorkshopItem } from './ui/workshopsTree';
import { reopenInWorkshop } from './remote/reopen';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Workshop', { log: true });
  const client = new WorkshopClient();
  log.info(`Workshop extension activated; using daemon socket ${client.socket}`);

  const poller = new WorkshopPoller<Workshop[]>(() => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return Promise.resolve([]);
    }
    // When the window is connected to a remote via SSH, `folder.uri` has
    // scheme `vscode-remote`, and `fsPath` returns the path on the remote
    // machine (e.g. `/project`) — not a local path the daemon knows about.
    // Fall back to the local project path saved when "Reopen in Workshop" was
    // last invoked so the tree view keeps working from the remote window.
    const projectPath =
      folder.uri.scheme === 'file'
        ? folder.uri.fsPath
        : (context.globalState.get<string>('workshop.localProjectPath') ?? folder.uri.fsPath);
    return listProjectWorkshops(client, projectPath);
  });

  const provider = new WorkshopsTreeProvider(poller, log);

  // Start in the "not unavailable" state so the welcome stub stays hidden until
  // a request actually proves the daemon is unreachable. (The unset default
  // already hides it; this just makes the intent explicit.)
  void vscode.commands.executeCommand('setContext', UNAVAILABLE_CONTEXT, false);

  const treeView = vscode.window.createTreeView('workshop.workshops', {
    treeDataProvider: provider,
  });

  // Gate polling on view visibility so the daemon can go socket-activated
  // when the Workshop panel is closed.
  let activationHandle: vscode.Disposable | undefined;
  if (treeView.visible) {
    activationHandle = poller.activate();
  }

  context.subscriptions.push(
    log,
    poller,
    provider,
    treeView,
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        activationHandle = poller.activate();
      } else {
        activationHandle?.dispose();
        activationHandle = undefined;
      }
    }),
    vscode.commands.registerCommand('workshop.refresh', () => void poller.poll()),
    vscode.commands.registerCommand('workshop.install', () =>
      vscode.env.openExternal(vscode.Uri.parse('https://snapcraft.io/workshop')),
    ),
    vscode.commands.registerCommand('workshop.reopenInWorkshop', (item: WorkshopItem) => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const projectPath =
        folder?.uri.scheme === 'file'
          ? folder.uri.fsPath
          : (context.globalState.get<string>('workshop.localProjectPath') ?? folder?.uri.fsPath);
      if (!projectPath) {
        void vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }
      // Persist the local path so "Reopen Locally" can navigate back to it.
      void context.globalState.update('workshop.localProjectPath', projectPath);
      void reopenInWorkshop(client, projectPath, item.workshop, context.globalStorageUri.fsPath);
    }),
    vscode.commands.registerCommand('workshop.reopenLocally', () => {
      const localPath = context.globalState.get<string>('workshop.localProjectPath');
      if (localPath) {
        void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(localPath), { forceReuseWindow: true });
      } else {
        // Fallback: just close the remote connection without reopening a folder.
        void vscode.commands.executeCommand('workbench.action.remote.close');
      }
    }),
  );
}

// This method is called when your extension is deactivated
export function deactivate() { }
