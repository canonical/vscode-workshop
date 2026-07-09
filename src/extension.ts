// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { WorkshopClient } from './api/client';
import { WorkshopPoller } from './poller';
import { listProjectWorkshops, normalizeStatus, Workshop } from './api/workshops';
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

    // An operation triggered from inside a workshop defers to the local window
    // (the extension host restarts on reopen). Resume it here.
    const pendingOp = context.globalState.get<PendingOperation>('workshop.pendingOperation');
    if (pendingOp) {
      void context.globalState.update('workshop.pendingOperation', undefined);
      void resumePendingOperation(client, context, log, logsView, pendingOp);
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
  }

  // Watch definition files and prompt to refresh when they change. Active in
  // both local and in-workshop windows: locally the command runs the refresh
  // directly; inside a workshop it exits to the local window first and resumes
  // there (handled by workshop.refreshAndReopen / handleRefreshAndReopen).
  context.subscriptions.push(
    createDefinitionWatcher((filePath) => {
      // Prefer the poller's cache, but fall back to a direct list when it's
      // empty. Polling is gated on the Workshop view's visibility, so the cache
      // is empty whenever that panel isn't in front (always the case inside a
      // workshop, where the Explorer is shown). Without the fallback the prompt
      // would silently never appear.
      void resolveChangedWorkshop(client, context, poller.lastValue, filePath)
        .then((workshop) => {
          if (!workshop || !canRefresh(workshop)) {
            return;
          }
          return vscode.window.showInformationMessage(
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
        })
        .catch((err: unknown) => {
          log.debug(
            `Definition-change prompt skipped: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }),
  );

  // If connected via Remote-SSH to a workshop, tell the tree provider which
  // workshop is active so it can highlight that item. Keep the Workshop view
  // in front (rather than switching to the Explorer) so its visibility-gated
  // poller keeps running — the definition watcher relies on that live cache.
  if (vscode.env.remoteName === 'ssh-remote') {
    const activeWorkshop = context.globalState.get<string>('workshop.activeWorkshopName');
    if (activeWorkshop) {
      provider.setActiveWorkshop(activeWorkshop);
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
    vscode.commands.registerCommand('workshop.turnOff', (item: WorkshopItem) =>
      handleTurnOff(client, context, log, item),
    ),
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

/**
 * Build the callbacks for a refresh: collect verbose log lines, and on a
 * paused (`Wait`) refresh show those logs — same presentation as a failed
 * launch — then ask whether to reopen for debugging or abort the refresh.
 */
function refreshCallbacks(
  log: vscode.LogOutputChannel,
  logsView: LogsView,
  workshop: Workshop,
  logLines: string[],
): ReopenCallbacks {
  return {
    onLog: (lines) => logLines.push(...lines),
    onPause: async (error) => {
      await showWorkshopError(
        log,
        logsView,
        'refresh',
        workshop.name,
        workshop.definitionPath,
        new Error(error),
        logLines,
      );
      const choice = await vscode.window.showInformationMessage(
        `"${workshop.name}" refresh is paused due to a failure. Reopen for debugging, or abort the refresh?`,
        'Reopen and Debug',
        'Abort',
      );
      if (choice === 'Reopen and Debug') {
        return 'debug';
      }
      if (choice === 'Abort') {
        return 'abort';
      }
      return 'dismiss';
    },
  };
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
  // Invoked from inside a workshop: exit to the local window first, then resume
  // the refresh-and-reopen there (the refresh runs against the local daemon).
  if (vscode.env.remoteName === 'ssh-remote') {
    deferRefreshToLocal(context, item.workshop.name);
    return;
  }
  const logLines: string[] = [];
  refreshAndReopen(
    client,
    projectPath,
    item.workshop,
    refreshCallbacks(log, logsView, item.workshop, logLines),
  )
    .then((connected) => {
      if (connected) {
        void context.globalState.update('workshop.activeWorkshopName', item.workshop.name);
      }
    })
    .catch((err: unknown) => {
      void showWorkshopError(log, logsView, 'refresh and reopen', item.workshop.name, item.workshop.definitionPath, err, logLines);
    });
}

/**
 * An operation requested from inside a workshop and deferred to the local
 * window. Persisted in `globalState` across the window reload that exits the
 * workshop, then consumed on the next local activation.
 *
 * - `refresh`  — a `continue`/`abort` of a paused refresh, or a plain
 *   `wait-on-error` refresh-and-reopen triggered by a definition change.
 * - `turn-off` — remove the workshop's container after leaving it.
 */
type PendingOperation =
  | { kind: 'refresh'; name: string; projectPath: string; mode: 'wait-on-error' | 'continue' | 'abort' }
  | { kind: 'turn-off'; name: string; projectPath: string };

/**
 * Persist a refresh-and-reopen intent and exit the current workshop window to
 * the local folder, where {@link resumePendingRefresh} picks it up. Used when a
 * definition changes while connected to a workshop.
 *
 * The active-workshop marker is intentionally left in place: we bounce out to
 * the local window only to run the refresh, then reconnect to the *same*
 * workshop, so it stays "active" the whole time. (The reconnect happens via a
 * window reload that can kill the extension host before any post-connect state
 * update runs, so clearing it here would leave the reconnected workshop with no
 * highlight.)
 */
function deferRefreshToLocal(context: vscode.ExtensionContext, name: string): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const projectPath = resolveLocalProjectPath(folder, context.globalState);
  if (!projectPath) {
    void vscode.window.showErrorMessage('No local project path known for this workshop.');
    return;
  }
  void context.globalState.update('workshop.pendingOperation', {
    kind: 'refresh',
    name,
    projectPath,
    mode: 'wait-on-error',
  } satisfies PendingOperation);
  void vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(projectPath),
    { forceReuseWindow: true },
  );
}

/**
 * Find the workshop whose definition file changed. Prefers an exact path match;
 * inside a workshop the watcher reports the remote path while the daemon knows
 * the definition by its local path, so fall back to matching basenames.
 */
function findWorkshopForDefinition(
  workshops: Workshop[],
  filePath: string,
): Workshop | undefined {
  const exact = workshops.find((w) => w.definitionPath === filePath);
  if (exact) {
    return exact;
  }
  const base = pathBasename(filePath);
  return workshops.find(
    (w) => w.definitionPath !== undefined && pathBasename(w.definitionPath) === base,
  );
}

/**
 * Resolve the workshop whose definition changed. Tries the poller's cache
 * first; if that yields nothing (the cache is empty whenever the Workshop view
 * isn't visible — always so inside a workshop), lists workshops on demand so
 * the prompt still works regardless of view visibility.
 */
async function resolveChangedWorkshop(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  cached: Workshop[] | undefined,
  filePath: string,
): Promise<Workshop | undefined> {
  const fromCache = findWorkshopForDefinition(cached ?? [], filePath);
  if (fromCache) {
    return fromCache;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  const projectPath = resolveLocalProjectPath(folder, context.globalState);
  if (!projectPath) {
    return undefined;
  }
  const workshops = await listProjectWorkshops(client, projectPath);
  return findWorkshopForDefinition(workshops, filePath);
}

/** Basename of a path, tolerant of both POSIX and Windows separators. */
function pathBasename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
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
    void context.globalState.update('workshop.pendingOperation', {
      kind: 'refresh',
      name: item.workshop.name,
      projectPath,
      mode,
    } satisfies PendingOperation);
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
 * Run a refresh in `wait-on-error`/`continue`/`abort` mode. Records the
 * workshop as active only when the refresh actually connected into it — a
 * paused-and-dismissed, aborted, or `reopen: false` run stays local.
 */
function runResumeRefresh(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  logsView: LogsView,
  workshop: Workshop,
  projectPath: string,
  mode: 'wait-on-error' | 'continue' | 'abort',
  reopen: boolean,
): void {
  const logLines: string[] = [];
  refreshAndReopen(
    client,
    projectPath,
    workshop,
    refreshCallbacks(log, logsView, workshop, logLines),
    mode,
    reopen,
  )
    .then((connected) => {
      if (connected) {
        void context.globalState.update('workshop.activeWorkshopName', workshop.name);
      }
    })
    .catch((err: unknown) => {
      const action = mode === 'wait-on-error' ? 'refresh and reopen' : `${mode} refresh`;
      void showWorkshopError(log, logsView, action, workshop.name, workshop.definitionPath, err, logLines);
    });
}

/**
 * Resume a {@link PendingOperation} deferred from inside a workshop.
 */
async function resumePendingOperation(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  logsView: LogsView,
  op: PendingOperation,
): Promise<void> {
  if (op.kind === 'turn-off') {
    runTurnOff(client, context, log, op.projectPath, op.name);
    return;
  }
  // A refresh: resolve the workshop model so we can surface its definition
  // path in error logs, then run it (reopening afterwards).
  let workshop: Workshop = { name: op.name, status: 'Waiting' };
  try {
    const project = await client.ensureProject(op.projectPath);
    const info = await client.getWorkshop(project.id, op.name);
    workshop = {
      name: info.name,
      status: normalizeStatus(info.status),
      rawStatus: info.status,
      hostname: info.hostname,
      definitionPath: info.path,
    };
  } catch {
    // Daemon may not be reachable yet; fall back to the minimal model.
  }
  runResumeRefresh(client, context, log, logsView, workshop, op.projectPath, op.mode, true);
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
 * Turn a workshop off by removing its container (the daemon `remove` action).
 *
 * When invoked while connected to the workshop being turned off, the window
 * must exit to the local folder first (removing its container would otherwise
 * drop the Remote-SSH session mid-operation). The intent is persisted and the
 * removal runs on the next local activation.
 */
function handleTurnOff(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  item: WorkshopItem,
): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const projectPath = resolveLocalProjectPath(folder, context.globalState);
  if (!projectPath) {
    void vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }
  const name = item.workshop.name;
  const connectedToTarget =
    vscode.env.remoteName === 'ssh-remote' &&
    context.globalState.get<string>('workshop.activeWorkshopName') === name;

  if (connectedToTarget) {
    // Exit to the local window first, then remove there.
    const localPath = context.globalState.get<string>('workshop.localProjectPath');
    if (!localPath) {
      void vscode.window.showErrorMessage(
        'Cannot turn off: the local project path for this workshop is unknown.',
      );
      return;
    }
    void context.globalState.update('workshop.pendingOperation', {
      kind: 'turn-off',
      name,
      projectPath: localPath,
    } satisfies PendingOperation);
    void context.globalState.update('workshop.activeWorkshopName', undefined);
    void vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(localPath),
      { forceReuseWindow: true },
    );
    return;
  }
  void runTurnOff(client, context, log, projectPath, name);
}

/** Run the `remove` action for a workshop, with a progress notification. */
function runTurnOff(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  projectPath: string | undefined,
  name: string,
): void {
  if (!projectPath) {
    void vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }
  void vscode.window
    .withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: name,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'turning off…' });
        const project = await client.ensureProject(projectPath);
        await client.workshopAction(project.id, [name], 'remove');
        // If this was the connected workshop, drop the active highlight.
        if (context.globalState.get<string>('workshop.activeWorkshopName') === name) {
          await context.globalState.update('workshop.activeWorkshopName', undefined);
        }
      },
    )
    .then(undefined, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to turn off ${name}: ${message}`);
      void vscode.window.showErrorMessage(`Failed to turn off "${name}": ${message}`);
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
