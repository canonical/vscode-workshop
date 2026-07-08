// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { WorkshopClient } from './api/client';
import { WorkshopPoller } from './poller';
import { listProjectWorkshops, Workshop } from './api/workshops';
import { UNAVAILABLE_CONTEXT, WorkshopsTreeProvider, WorkshopItem } from './ui/workshopsTree';
import { LogsView } from './ui/logsView';
import { reopenInWorkshop, ReopenCallbacks } from './remote/reopen';
import { refreshAndReopen } from './remote/refresh';
import { createDefinitionWatcher } from './ui/definitionWatcher';
import { canRefresh } from './api/workshops';
import { createOpenPrompt } from './ui/openPrompt';

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

  // In a local window, activate features that only make sense when not inside a workshop.
  if (vscode.env.remoteName !== 'ssh-remote') {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const localPath = resolveLocalProjectPath(folder, context.globalState);

    // A continue/abort triggered from inside a workshop defers to the local
    // window (the extension host restarts on reopen). Resume it here.
    const pending = context.globalState.get<PendingRefresh>('workshop.pendingRefresh');
    if (pending) {
      void context.globalState.update('workshop.pendingRefresh', undefined);
      void resumePendingRefresh(client, context, log, logsView, pending);
    } else if (localPath) {
      // One-shot prompt if the project has definitions.
      // Fire-and-forget; errors are non-fatal (daemon may not be up yet).
      void listProjectWorkshops(client, localPath)
        .then((workshops) =>
          createOpenPrompt({
            workshops,
            projectPath: localPath,
            reopen: async (workshop) =>
              handleReopenInWorkshop(client, context, log, logsView, new WorkshopItem(workshop)),
          }),
        )
        .catch((err: unknown) => {
          log.debug(
            `Open prompt skipped: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }

    // Watch definition files and prompt to refresh when they change.
    context.subscriptions.push(
      createDefinitionWatcher((filePath) => {
        const workshops = poller.lastValue ?? [];
        const workshop = workshops.find((w) => w.definitionPath === filePath);
        if (!workshop || !canRefresh(workshop)) {
          return;
        }
        void vscode.window.showInformationMessage(
          `"${workshop.name}" definition changed. Refresh and reopen?`,
          'Refresh and Reopen',
        ).then((choice) => {
          if (choice === 'Refresh and Reopen') {
            void vscode.commands.executeCommand(
              'workshop.refreshAndReopen',
              new WorkshopItem(workshop),
            );
          }
        });
      }),
    );
  }

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
        activationHandle ??= poller.activate();
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
    vscode.commands.registerCommand('workshop.refreshAndReopen', (item: WorkshopItem) =>
      handleRefreshAndReopen(client, context, log, logsView, item),
    ),
    vscode.commands.registerCommand('workshop.continueRefresh', (item: WorkshopItem) =>
      handleResumeRefresh(client, context, log, logsView, item, 'continue'),
    ),
    vscode.commands.registerCommand('workshop.abortRefresh', (item: WorkshopItem) =>
      handleResumeRefresh(client, context, log, logsView, item, 'abort'),
    ),
    vscode.commands.registerCommand('workshop.openDefinition', (definitionPath: string) => {
      void vscode.window.showTextDocument(vscode.Uri.file(definitionPath), { preview: false });
    }),
  );

}

// This method is called when your extension is deactivated
export function deactivate() { }

/**
 * Open the workshop definition file in column One and the error log beside it
 * in column Two. Falls back to a two-column split when the definition file
 * isn't readable.
 */
async function showWorkshopError(
  log: vscode.LogOutputChannel,
  logsView: LogsView,
  action: string,
  workshopName: string,
  definitionPath: string | undefined,
  err: unknown,
  logLines: string[],
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  log.error(`Failed to ${action} ${workshopName}: ${message}`);
  const logContent = logLines.length > 0 ? `${logLines.join('\n')}\n\n${message}` : message;
  let anchored = false;
  if (definitionPath) {
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(definitionPath), {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      });
      anchored = true;
    } catch {
      // Definition file not readable — skip it.
    }
  }
  if (anchored) {
    await logsView.openLog(`${workshopName} — error`, logContent);
  } else {
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
      orientation: 0,
      groups: [{}, {}],
    });
    await logsView.openLog(`${workshopName} — error`, logContent, vscode.ViewColumn.Two);
  }
}

function handleRefreshAndReopen(
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
  const logLines: string[] = [];
  refreshAndReopen(client, projectPath, item.workshop, {
    onLog: (lines) => logLines.push(...lines),
  })
    .then(() => {
      void context.globalState.update('workshop.activeWorkshopName', item.workshop.name);
    })
    .catch((err: unknown) => {
      void showWorkshopError(log, logsView, 'refresh and reopen', item.workshop.name, item.workshop.definitionPath, err, logLines);
    });
}

/**
 * A continue/abort that was requested from inside a workshop and deferred to
 * the local window. Persisted in `globalState` across the window reload that
 * exits the workshop, then consumed on the next local activation.
 */
interface PendingRefresh {
  name: string;
  projectPath: string;
  mode: 'continue' | 'abort';
}

/**
 * Continue or abort a workshop paused mid-refresh.
 *
 * When invoked from inside the workshop (a Remote-SSH window), the current
 * window must first exit to the local folder — the refresh runs against the
 * local daemon and reopens the connection afterwards. Because the extension
 * host restarts on reload, the intent is persisted and resumed on the next
 * local activation.
 *
 * When invoked locally it runs immediately. A local `continue` reopens into the
 * workshop; a local `abort` just unwinds and stays local (no reopen).
 */
function handleResumeRefresh(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  logsView: LogsView,
  item: WorkshopItem,
  mode: 'continue' | 'abort',
): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const projectPath = resolveLocalProjectPath(folder, context.globalState);
  if (!projectPath) {
    void vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  if (vscode.env.remoteName === 'ssh-remote') {
    // Exit to the local window first, then resume there.
    void context.globalState.update('workshop.pendingRefresh', {
      name: item.workshop.name,
      projectPath,
      mode,
    } satisfies PendingRefresh);
    void context.globalState.update('workshop.activeWorkshopName', undefined);
    void vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(projectPath),
      { forceReuseWindow: true },
    );
    return;
  }

  runResumeRefresh(client, context, log, logsView, item.workshop, projectPath, mode, mode !== 'abort');
}

/**
 * Run a refresh in `continue`/`abort` mode. When `reopen` is true it connects
 * into the workshop afterwards and records it as active; otherwise it just runs
 * the action (a local abort stays local).
 */
function runResumeRefresh(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  logsView: LogsView,
  workshop: Workshop,
  projectPath: string,
  mode: 'continue' | 'abort',
  reopen: boolean,
): void {
  const logLines: string[] = [];
  refreshAndReopen(client, projectPath, workshop, { onLog: (lines) => logLines.push(...lines) }, mode, reopen)
    .then(() => {
      if (reopen) {
        void context.globalState.update('workshop.activeWorkshopName', workshop.name);
      }
    })
    .catch((err: unknown) => {
      void showWorkshopError(log, logsView, `${mode} refresh`, workshop.name, workshop.definitionPath, err, logLines);
    });
}

/**
 * Resume a {@link PendingRefresh} deferred from inside a workshop. Both
 * continue and abort reopen here — the user was inside the workshop, so control
 * returns there once the action settles.
 */
async function resumePendingRefresh(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  logsView: LogsView,
  pending: PendingRefresh,
): Promise<void> {
  let workshop: Workshop = { name: pending.name, status: 'Waiting' };
  try {
    const workshops = await listProjectWorkshops(client, pending.projectPath);
    workshop = workshops.find((w) => w.name === pending.name) ?? workshop;
  } catch {
    // Daemon may not be reachable yet; fall back to the minimal model.
  }
  runResumeRefresh(client, context, log, logsView, workshop, pending.projectPath, pending.mode, true);
}

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
  const callbacks: ReopenCallbacks = { onLog: (lines) => logLines.push(...lines) };
  reopenInWorkshop(client, projectPath, item.workshop, callbacks)
    .then(() => {
      void context.globalState.update('workshop.activeWorkshopName', item.workshop.name);
    })
    .catch((err: unknown) => {
      void showWorkshopError(log, logsView, 'reopen in workshop', item.workshop.name, item.workshop.definitionPath, err, logLines);
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
