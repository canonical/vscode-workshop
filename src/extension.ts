// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { WorkshopClient } from './api/client';
import { WorkshopPoller } from './poller';
import { listProjectWorkshops, Workshop } from './api/workshops';
import { UNAVAILABLE_CONTEXT, WorkshopsTreeProvider, WorkshopItem } from './ui/workshopsTree';
import { LogsView } from './ui/logsView';
import { reopenInWorkshop, runAction, ReopenCallbacks } from './reopen';
import { refreshAndReopen, runResumeRefresh } from './refresh';
import { createDefinitionWatcher } from './ui/definitionWatcher';
import { canRefresh } from './api/workshops';
import { createOpenPrompt } from './ui/openPrompt';
import {
  hostnameFromFolder,
  readSession,
  writeSession,
  clearSession,
  readPendingOp,
  writePendingOp,
  clearPendingOp,
  resolveLocalProjectPath,
  PendingOperation,
} from './state';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Workshop', { log: true });
  const client = new WorkshopClient();
  log.info(`Workshop extension activated; using daemon socket ${client.socket}`);

  // Start in the "not unavailable" state so the welcome stub stays hidden until
  // a request actually proves the daemon is unreachable. (The unset default
  // already hides it; this just makes the intent explicit.)
  void vscode.commands.executeCommand('setContext', UNAVAILABLE_CONTEXT, false);

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
  const treeView = vscode.window.createTreeView('workshop.workshops', {
    treeDataProvider: provider,
  });
  // Gate polling on view visibility so the daemon can go socket-activated
  // when the Workshop panel is closed.
  let activationHandle: vscode.Disposable | undefined;
  if (treeView.visible) {
    activationHandle = poller.activate();
  }

  // In a local window, activate features that only make sense when not inside a workshop.
  if (vscode.env.remoteName !== 'ssh-remote') {
    handlePendingOp(client, context, log, logsView);
  } else if (vscode.env.remoteName === 'ssh-remote') {
    // If connected via Remote-SSH to a workshop, tell the tree provider which
    // workshop is active so it can highlight that item. Keep the Workshop view
    // in front (rather than switching to the Explorer) so its visibility-gated
    // poller keeps running — the definition watcher relies on that live cache.
    const folder = vscode.workspace.workspaceFolders?.[0];
    const hostname = hostnameFromFolder(folder);
    const workshopName = hostname ? readSession(context.globalState, hostname)?.workshopName : undefined;
    if (workshopName) {
      provider.setActiveWorkshop(workshopName);
    }
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
    // Watch definition files and prompt to refresh when they change. Active in
    // both local and in-workshop windows: locally the command runs the refresh
    // directly; inside a workshop it exits to the local window first and resumes
    // there (handled by workshop.refreshAndReopen / handleRefreshAndReopen).
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
    vscode.commands.registerCommand('workshop.poll', () => void poller.poll()),
    vscode.commands.registerCommand('workshop.install', () =>
      vscode.env.openExternal(vscode.Uri.parse('https://snapcraft.io/workshop')),
    ),
    vscode.commands.registerCommand('workshop.reopenInWorkshop', (item: WorkshopItem) =>
      handleReopenInWorkshop(client, context, log, logsView, item),
    ),
    vscode.commands.registerCommand('workshop.reopenLocally', () =>
      handleReopenLocally(context),
    ),
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

/**
 * In a local window: resume a deferred {@link PendingOperation} if one exists
 * for this project, or show the one-shot open prompt as a fallback.
 */
function handlePendingOp(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  logsView: LogsView,
): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const localPath = resolveLocalProjectPath(folder, context.globalState);

  // An operation triggered from inside a workshop defers to the local window
  // (the extension host restarts on reopen). Resume it here.
  // Keyed by localPath so only this project's op is consumed — ops from other
  // projects are invisible to this lookup.
  const pendingOp = localPath ? readPendingOp(context.globalState, localPath) : undefined;
  if (pendingOp && localPath) {
    void clearPendingOp(context.globalState, localPath);
    void resumePendingOperation(client, context, log, logsView, pendingOp, localPath);
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

function handleReopenLocally(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const hostname = hostnameFromFolder(folder);
  if (!hostname) {
    void vscode.window.showErrorMessage('Cannot reopen locally: not connected to a workshop.');
    return;
  }
  const session = readSession(context.globalState, hostname);
  if (!session) {
    void vscode.window.showErrorMessage(
      'Cannot reopen locally: local project path unknown. Use the Remote Explorer to disconnect.',
    );
    return;
  }
  void clearSession(context.globalState, hostname);
  void vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(session.localProjectPath),
    { forceReuseWindow: true },
  );
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
    .then((hostname) => {
      if (hostname) {
        void writeSession(context.globalState, hostname, { localProjectPath: projectPath, workshopName: item.workshop.name });
      }
    })
    .catch((err: unknown) => {
      void showWorkshopError(log, logsView, 'refresh and reopen', item.workshop.name, item.workshop.definitionPath, err, logLines);
    });
}

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
  void writePendingOp(context.globalState, projectPath, {
    kind: 'refresh',
    workshopName: name,
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
    void writePendingOp(context.globalState, projectPath, {
      kind: 'refresh',
      workshopName: item.workshop.name,
      mode,
    } satisfies PendingOperation);
    void vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(projectPath),
      { forceReuseWindow: true },
    );
    return;
  }

  const logLines: string[] = [];
  runResumeRefresh(
    client,
    projectPath,
    item.workshop,
    refreshCallbacks(log, logsView, item.workshop, logLines),
    mode,
    mode !== 'abort',
    (hostname) => void writeSession(context.globalState, hostname, { localProjectPath: projectPath, workshopName: item.workshop.name }),
    (err) => {
      void showWorkshopError(log, logsView, `${mode} refresh`, item.workshop.name, item.workshop.definitionPath, err, logLines);
    },
  );
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
  projectPath: string,
): Promise<void> {
  if (op.kind === 'turn-off') {
    runTurnOff(client, context, log, projectPath, op.workshopName);
  } else if (op.kind === 'refresh') {
    const workshop: Workshop = { name: op.workshopName, status: 'Waiting' };
    const logLines: string[] = [];
    refreshAndReopen(
      client,
      projectPath,
      workshop,
      refreshCallbacks(log, logsView, workshop, logLines),
      op.mode,
      true,
    )
      .then((hostname) => {
        if (hostname) {
          void writeSession(context.globalState, hostname, { localProjectPath: projectPath, workshopName: workshop.name });
        }
      })
      .catch((err: unknown) => {
        const action = op.mode === 'wait-on-error' ? 'refresh and reopen' : `${op.mode} refresh`;
        void showWorkshopError(log, logsView, action, workshop.name, workshop.definitionPath, err, logLines);
      });
  }
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
    .then((hostname) => {
      void writeSession(context.globalState, hostname, { localProjectPath: projectPath, workshopName: item.workshop.name });
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
  const folder2 = vscode.workspace.workspaceFolders?.[0];
  const hostname = hostnameFromFolder(folder2);
  const connectedToTarget =
    vscode.env.remoteName === 'ssh-remote' &&
    hostname !== undefined &&
    readSession(context.globalState, hostname)?.workshopName === name;

  if (connectedToTarget) {
    // Exit to the local window first, then remove there.
    if (!projectPath) {
      void vscode.window.showErrorMessage(
        'Cannot turn off: the local project path for this workshop is unknown.',
      );
      return;
    }
    void writePendingOp(context.globalState, projectPath, {
      kind: 'turn-off',
      workshopName: name,
    } satisfies PendingOperation);
    void vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(projectPath),
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
        await runAction(client, project.id, name, 'remove', progress, {}, false);
      },
    )
    .then(undefined, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to turn off ${name}: ${message}`);
      void vscode.window.showErrorMessage(`Failed to turn off "${name}": ${message}`);
    });
}
