// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { WorkshopClient } from './api/client';
import { WorkshopPoller } from './poller';
import { listProjectWorkshops, Workshop } from './api/workshops';
import { UNAVAILABLE_CONTEXT, WorkshopsTreeProvider, WorkshopItem } from './ui/workshopsTree';
import { LogsView } from './ui/logsView';
import { reopenInWorkshop } from './remote/reopen';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Workshop', { log: true });
  const client = new WorkshopClient();
  log.info(`Workshop extension activated; using daemon socket ${client.socket}`);

  const logsView = new LogsView();
  logsView.register(context);

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
    const projectPath = resolveLocalProjectPath(folder, context.globalState);
    return listProjectWorkshops(client, projectPath ?? folder.uri.fsPath);
  });

  const provider = new WorkshopsTreeProvider(poller, log);

  // If connected via Remote-SSH to a workshop, tell the tree provider which
  // workshop is active so it can highlight that item, and switch to Explorer.
  if (vscode.env.remoteName === 'ssh-remote') {
    const activeWorkshop = context.globalState.get<string>('workshop.activeWorkshopName');
    if (activeWorkshop) {
      provider.setActiveWorkshop(activeWorkshop);
      void vscode.commands.executeCommand('workbench.view.explorer');
    }
  }

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
    vscode.window.registerFileDecorationProvider(provider.decorationProvider),
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
    vscode.commands.registerCommand('workshop.reopenInWorkshop', (item: WorkshopItem) =>
      handleReopenInWorkshop(client, context, log, logsView, item),
    ),
    vscode.commands.registerCommand('workshop.reopenLocally', () => {
      void context.globalState.update('workshop.activeWorkshopName', undefined);
      const localPath = context.globalState.get<string>('workshop.localProjectPath');
      if (localPath) {
        void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(localPath), { forceReuseWindow: true });
      } else {
        void vscode.commands.executeCommand('workbench.action.remote.close');
      }
    }),
  );
}

// This method is called when your extension is deactivated
export function deactivate() { }

function handleReopenInWorkshop(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  logsView: LogsView,
  item: WorkshopItem,
): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const projectPath = resolveLocalProjectPath(folder, context.globalState);
  if (!projectPath) {
    void vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }
  void context.globalState.update('workshop.localProjectPath', projectPath);
  const logLines: string[] = [];
  reopenInWorkshop(client, projectPath, item.workshop, {
    onLog: (lines) => logLines.push(...lines),
  })
    .then(() => {
      void context.globalState.update('workshop.activeWorkshopName', item.workshop.name);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to reopen in workshop ${item.workshop.name}: ${message}`);
      const logContent = logLines.length > 0
        ? `${logLines.join('\n')}\n\n${message}`
        : message;
      // Open the workshop definition in column One, then the error log
      // beside it in column Two.
      void (async () => {
        let anchored = false;
        const defPath = item.workshop.definitionPath;
        if (defPath) {
          try {
            await vscode.window.showTextDocument(vscode.Uri.file(defPath), {
              preview: false,
              viewColumn: vscode.ViewColumn.One,
            });
            anchored = true;
          } catch {
            // Definition file not readable — skip it.
          }
        }
        if (anchored) {
          await logsView.openLog(`${item.workshop.name} — error`, logContent);
        } else {
          await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{}, {}],
          });
          await logsView.openLog(`${item.workshop.name} — error`, logContent, vscode.ViewColumn.Two);
        }
      })();
    });
}

/**
 * Resolve the local filesystem path for the project in the given workspace
 * folder. When the window is connected via Remote-SSH, `folder.uri` has scheme
 * `vscode-remote` and `fsPath` returns the path inside the container — not a
 * local path the daemon understands. In that case we fall back to the path
 * stored in `globalState` when "Reopen in Workshop" was last invoked.
 */
function resolveLocalProjectPath(
  folder: vscode.WorkspaceFolder | undefined,
  globalState: vscode.Memento,
): string | undefined {
  if (!folder) {
    return undefined;
  }
  if (folder.uri.scheme === 'file') {
    return folder.uri.fsPath;
  }
  return globalState.get<string>('workshop.localProjectPath') ?? folder.uri.fsPath;
}
