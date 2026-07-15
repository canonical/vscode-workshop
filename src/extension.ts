// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { WorkshopClient } from './api/client';
import { WorkshopPoller } from './poller';
import { listProjectWorkshops, Workshop } from './api/workshops';
import { UNAVAILABLE_CONTEXT, WorkshopsTreeProvider, WorkshopItem } from './ui/workshopsTree';
import { LogsView } from './ui/logsView';
import { reopenInWorkshop, runAction, ReopenCallbacks, refreshAndReopen } from './reopen';
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
  PendingOperation,
} from './state';

/** True when the window is running locally (not connected to a workshop). */
const isLocal = () => vscode.env.remoteName !== 'ssh-remote';

/** True when the window is connected to a workshop via Remote-SSH. */
const isWorkshop = () => vscode.env.remoteName === 'ssh-remote';

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
    // When the window is connected to a workshop via Remote-SSH, the daemon is
    // on the local machine, not the remote. Use the project ID stored in the
    // session to poll directly, skipping ensureProject.
    if (isWorkshop()) {
      const hostname = hostnameFromFolder(folder);
      const projectId = hostname ? readSession(context.globalState, hostname)?.projectId : undefined;
      if (!projectId) {
        return Promise.resolve([]);
      }
      return listProjectWorkshops(client, projectId);
    }
    return client.ensureProject(folder.uri.fsPath)
      .then((project) => listProjectWorkshops(client, project.id));
  });

  const provider = new WorkshopsTreeProvider(poller, log);
  const treeView = vscode.window.createTreeView('workshop.workshops', {
    treeDataProvider: provider,
  });

  function updateTreeViewTitle(): void {
    treeView.title = vscode.workspace.name ?? undefined;
  }
  updateTreeViewTitle();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(updateTreeViewTitle),
  );
  // Gate polling on view visibility so the daemon can go socket-activated
  // when the Workshop panel is closed.
  let activationHandle: vscode.Disposable | undefined;
  function onViewVisible(): void {
    activationHandle ??= poller.activate();
    // If connected via Remote-SSH to a workshop, tell the tree provider which
    // workshop is active so it can highlight that item.
    if (isWorkshop()) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const hostname = hostnameFromFolder(folder);
      const workshopName = hostname ? readSession(context.globalState, hostname)?.workshopName : undefined;
      if (workshopName) {
        provider.setActiveWorkshop(workshopName);
      }
    }
  }

  if (treeView.visible) {
    onViewVisible();
  }

  // In a local window, activate features that only make sense when not inside a workshop.
  if (isLocal()) {
    handlePendingOp(client, context, log, logsView);
  }

  context.subscriptions.push(
    log,
    poller,
    provider,
    treeView,
    vscode.window.registerFileDecorationProvider(provider.decorationProvider),
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        onViewVisible();
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
      handleReopenLocally(client, context),
    ),
    vscode.commands.registerCommand('workshop.refreshAndReopen', (item: WorkshopItem) =>
      handleRefresh(client, context, log, logsView, item),
    ),
    vscode.commands.registerCommand('workshop.continueRefresh', (item: WorkshopItem) =>
      handleRefresh(client, context, log, logsView, item, 'continue'),
    ),
    vscode.commands.registerCommand('workshop.abortRefresh', (item: WorkshopItem) =>
      handleRefresh(client, context, log, logsView, item, 'abort'),
    ),
    vscode.commands.registerCommand('workshop.openDefinition', (arg: WorkshopItem | string) => {
      if (arg instanceof WorkshopItem) {
        const path = arg.workshop.definitionPath;
        if (path) {
          void vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false });
        } else {
          void vscode.window.showWarningMessage(`No definition file path is available for "${arg.workshop.name}".`);
        }
      } else {
        void vscode.window.showTextDocument(vscode.Uri.file(arg), { preview: false });
      }
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
  logsView: LogsView,
  workshopName: string,
  definitionPath: string | undefined,
  err: unknown,
  logLines: string[],
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
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
      log.error(`Failed to refresh ${workshop.name}: ${error}`);
      await showWorkshopError(
        logsView,
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
  if (!folder) {
    return;
  }
  const localPath = folder.uri.fsPath;

  // Fire-and-forget: ensureProject to get the stable project ID, then check
  // for a deferred operation or show the one-shot open prompt.
  void client.ensureProject(localPath)
    .then(async (project) => {
      const pendingOp = readPendingOp(context.globalState, project.id);
      if (pendingOp) {
        await clearPendingOp(context.globalState, project.id);
        void resumePendingOperation(client, context, log, logsView, pendingOp);
        return;
      }
      await maybeShowOpenPrompt(client, context, log, logsView, project.id, localPath);
    })
    .catch((err: unknown) => {
      log.debug(
        `Open prompt skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
}

/**
 * Show the one-shot open prompt for a project, unless it has already been
 * shown before. Marks the project as prompted after the first showing.
 */
async function maybeShowOpenPrompt(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  logsView: LogsView,
  projectId: string,
  localPath: string,
): Promise<void> {
  const promptedKey = `workshop.prompted.${projectId}`;
  if (context.globalState.get<boolean>(promptedKey)) {
    return;
  }
  const workshops = await listProjectWorkshops(client, projectId);
  const shown = await createOpenPrompt({
    workshops,
    projectPath: localPath,
    reopen: async (workshop) =>
      handleReopenInWorkshop(client, context, log, logsView, new WorkshopItem(workshop)),
  });
  if (shown) {
    await context.globalState.update(promptedKey, true);
  }
}

async function handleReopenLocally(client: WorkshopClient, context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const hostname = hostnameFromFolder(folder);
  if (!hostname) {
    void vscode.window.showErrorMessage('Cannot reopen locally: not connected to a workshop.');
    return;
  }
  const session = readSession(context.globalState, hostname);
  if (!session) {
    void vscode.commands.executeCommand('workbench.action.remote.close');
    return;
  }
  const project = await client.getProject(session.projectId);
  if (!project) {
    void vscode.window.showErrorMessage('Cannot reopen locally: project-id is not known to workshopd.');
    return;
  }
  void clearSession(context.globalState, hostname);
  void vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(project.path),
    { forceReuseWindow: true },
  );
}

/**
 * Refresh a workshop and reopen into it, or continue/abort a paused refresh.
 *
 * When invoked from inside a workshop, exits to the local window first and
 * defers the operation there (the refresh runs against the local daemon).
 * When invoked locally, runs the refresh immediately.
 */
function handleRefresh(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  logsView: LogsView,
  item: WorkshopItem,
  mode: 'wait-on-error' | 'continue' | 'abort' = 'wait-on-error',
): void {
  if (isWorkshop()) {
    void deferRefreshToLocal(client, context, item.workshop.name, item.workshop.projectId, mode);
    return;
  }
  const logLines: string[] = [];
  const action = mode === 'wait-on-error' ? 'refresh and reopen' : `${mode} refresh`;
  refreshAndReopen(
    client,
    item.workshop,
    refreshCallbacks(log, logsView, item.workshop, logLines),
    mode,
    mode !== 'abort',
  )
    .then((hostname) => {
      if (hostname) {
        void writeSession(context.globalState, hostname, { projectId: item.workshop.projectId, workshopName: item.workshop.name });
      }
    })
    .catch((err: unknown) => {
      log.error(`Failed to ${action} ${item.workshop.name}: ${err instanceof Error ? err.message : String(err)}`);
      void showWorkshopError(logsView, item.workshop.name, item.workshop.definitionPath, err, logLines);
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
async function deferRefreshToLocal(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  name: string,
  projectId: string,
  mode: 'wait-on-error' | 'continue' | 'abort' = 'wait-on-error',
): Promise<void> {
  const project = await client.getProject(projectId);
  if (!project) {
    void vscode.window.showErrorMessage('No local project path known for this workshop.');
    return;
  }
  await writePendingOp(context.globalState, projectId, {
    kind: 'refresh',
    workshopName: name,
    projectId,
    mode,
  } satisfies PendingOperation);
  void vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(project.path),
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
  let projectId: string | undefined;
  if (isWorkshop()) {
    const hostname = hostnameFromFolder(folder);
    projectId = hostname ? readSession(context.globalState, hostname)?.projectId : undefined;
  } else if (folder) {
    const project = await client.ensureProject(folder.uri.fsPath);
    projectId = project.id;
  }
  if (!projectId) {
    return undefined;
  }
  const workshops = await listProjectWorkshops(client, projectId);
  return findWorkshopForDefinition(workshops, filePath);
}

/** Basename of a path, tolerant of both POSIX and Windows separators. */
function pathBasename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
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
    runTurnOff(client, { name: op.workshopName, status: 'Waiting', projectId: op.projectId })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed to turn off ${op.workshopName}: ${message}`);
        void vscode.window.showErrorMessage(`Failed to turn off "${op.workshopName}": ${message}`);
      });
  } else if (op.kind === 'refresh') {
    const workshop: Workshop = { name: op.workshopName, status: 'Waiting', projectId: op.projectId };
    const logLines: string[] = [];
    refreshAndReopen(
      client,
      workshop,
      refreshCallbacks(log, logsView, workshop, logLines),
      op.mode,
      true,
    )
      .then((hostname) => {
        if (hostname) {
          void writeSession(context.globalState, hostname, { projectId: op.projectId, workshopName: workshop.name });
        }
      })
      .catch((err: unknown) => {
        const action = op.mode === 'wait-on-error' ? 'refresh and reopen' : `${op.mode} refresh`;
        log.error(`Failed to ${action} ${workshop.name}: ${err instanceof Error ? err.message : String(err)}`);
        void showWorkshopError(logsView, workshop.name, workshop.definitionPath, err, logLines);
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
  const logLines: string[] = [];
  const callbacks: ReopenCallbacks = { onLog: (lines) => logLines.push(...lines) };
  reopenInWorkshop(client, item.workshop, callbacks)
    .then((hostname: string) => {
      void writeSession(context.globalState, hostname, { projectId: item.workshop.projectId, workshopName: item.workshop.name });
    })
    .catch((err: unknown) => {
      log.error(`Failed to reopen in workshop ${item.workshop.name}: ${err instanceof Error ? err.message : String(err)}`);
      void showWorkshopError(logsView, item.workshop.name, item.workshop.definitionPath, err, logLines);
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
async function handleTurnOff(
  client: WorkshopClient,
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  item: WorkshopItem,
): Promise<void> {
  const name = item.workshop.name;

  if (isWorkshop()) {
    // Exit to the local window first, then remove there.
    const project = await client.getProject(item.workshop.projectId);
    if (!project) {
      void vscode.window.showErrorMessage(
        'Cannot turn off: the local project path for this workshop is unknown.',
      );
      return;
    }
    await writePendingOp(context.globalState, item.workshop.projectId, {
      kind: 'turn-off',
      workshopName: name,
      projectId: item.workshop.projectId,
    } satisfies PendingOperation);
    void vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(project.path),
      { forceReuseWindow: true },
    );
    return;
  }
  await runTurnOff(client, item.workshop)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to turn off ${item.workshop.name}: ${message}`);
      void vscode.window.showErrorMessage(`Failed to turn off "${item.workshop.name}": ${message}`);
    });
}

/** Run the `remove` action for a workshop, with a progress notification. */
async function runTurnOff(
  client: WorkshopClient,
  workshop: Workshop,
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: workshop.name,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'turning off…' });
      await runAction(client, workshop.projectId, workshop.name, 'remove', progress, {}, false);
    },
  );
}
