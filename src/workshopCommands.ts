import * as vscode from 'vscode';

import { WorkshopClient } from './api/client';
import {
  buildInitArgs,
  definitionPath,
  InitError,
  InitSpec,
  runWorkshopInit,
} from './api/init';
import { REFERENCE_SDKS } from './api/sdkCatalog';
import { canRefresh, listProjectWorkshops, Workshop } from './api/workshops';
import {
  runAddWorkshopWizard,
  WizardDeps,
  WizardResult,
} from './ui/addWorkshopWizard';
import {
  refreshAndReopen,
  refreshWorkshop,
  reopenInWorkshop,
  ReopenCallbacks,
  RefreshMode,
  runAction,
} from './reopen';
import {
  clearPendingOp,
  clearSession,
  PendingOperation,
  readPendingOp,
  writePendingOp,
  writeSession,
} from './state';
import { LogsView } from './ui/logsView';
import { createOpenPrompt } from './ui/openPrompt';
import { WorkshopItem } from './ui/workshopsTree';
import {
  currentWorkshop,
  isWorkshopWindow,
  resolveCurrentProjectId,
} from './workspaceContext';

export interface WorkshopCommands {
  activateLocalProject(): void;
  definitionChanged(filePath: string, cached: Workshop[] | undefined): void;
  reopenInWorkshop(item: WorkshopItem): void;
  reopenLocally(): Promise<void>;
  refresh(item: WorkshopItem, mode?: RefreshMode): void;
  openDefinition(arg: WorkshopItem | string): void;
  turnOff(item: WorkshopItem): Promise<void>;
  addWorkshop(): Promise<void>;
}

interface WorkshopCommandDependencies {
  client: WorkshopClient;
  globalState: vscode.Memento;
  log: vscode.LogOutputChannel;
  logsView: LogsView;
  /** Overrides below are injected in tests to keep VS Code UI and the CLI out of the hot path. */
  wizard?: (deps: WizardDeps) => Promise<WizardResult | undefined>;
  runInit?: (spec: InitSpec) => Promise<unknown>;
  workspaceFolders?: () => { name: string; path: string }[];
}

/** Create command handlers that share the extension's long-lived dependencies. */
export function createWorkshopCommands({
  client,
  globalState,
  log,
  logsView,
  wizard = runAddWorkshopWizard,
  runInit = runWorkshopInit,
  workspaceFolders = () => (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => ({ name: folder.name, path: folder.uri.fsPath })),
}: WorkshopCommandDependencies): WorkshopCommands {
  let wizardOpen = false;
  function withSession(workshop: Workshop, callbacks: ReopenCallbacks): ReopenCallbacks {
    return {
      ...callbacks,
      onBeforeOpen: (hostname) => writeSession(globalState, hostname, {
        projectId: workshop.projectId,
        workshopName: workshop.name,
      }),
    };
  }

  async function showWorkshopError(
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
        // The definition file may not be readable from this window.
      }
    }
    if (anchored) {
      await logsView.openLog(`${workshopName} (error)`, logContent);
    } else {
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{}, {}],
      });
      await logsView.openLog(`${workshopName} (error)`, logContent, vscode.ViewColumn.Two);
    }
  }

  async function resolveWorkshopDefinitionPath(workshop: Workshop): Promise<string | undefined> {
    if (workshop.definitionPath) {
      return workshop.definitionPath;
    }
    const workshops = await listProjectWorkshops(client, workshop.projectId);
    return workshops.find((candidate) => candidate.name === workshop.name)?.definitionPath;
  }

  async function showResolvedWorkshopError(
    workshop: Workshop,
    err: unknown,
    logLines: string[],
  ): Promise<void> {
    const definitionPath = await resolveWorkshopDefinitionPath(workshop).catch(() => undefined);
    await showWorkshopError(workshop.name, definitionPath, err, logLines);
  }

  function refreshCallbacks(workshop: Workshop, logLines: string[]): ReopenCallbacks {
    return {
      onLog: (lines) => logLines.push(...lines),
      onPause: async (error) => {
        log.error(`Couldn't refresh ${workshop.name}: ${error}`);
        await showResolvedWorkshopError(workshop, new Error(error), logLines);
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

  function activateLocalProject(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    const localPath = folder.uri.fsPath;

    void client.ensureProject(localPath)
      .then(async (project) => {
        const pendingOp = readPendingOp(globalState, project.id);
        if (pendingOp) {
          await clearPendingOp(globalState, project.id);
          void runPendingOperation(pendingOp);
          return;
        }
        await showOpenPrompt(project.id);
      })
      .catch((err: unknown) => {
        log.debug(`Open prompt skipped: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  async function showOpenPrompt(projectId: string): Promise<void> {
    const workshops = await listProjectWorkshops(client, projectId);
    await createOpenPrompt({
      workshops,
      reopen: async (workshop) => reopenInWorkshopCommand(new WorkshopItem(workshop)),
    });
  }

  async function reopenLocally(): Promise<void> {
    const current = currentWorkshop(globalState);
    if (!current) {
      void vscode.window.showErrorMessage('Cannot reopen locally: not connected to a workshop.');
      return;
    }
    const { hostname, session } = current;
    if (!session) {
      void vscode.commands.executeCommand('workbench.action.remote.close');
      return;
    }
    const project = await client.getProject(session.projectId);
    if (!project) {
      void vscode.window.showErrorMessage('Cannot reopen locally: project-id is not known to workshopd.');
      return;
    }
    await clearSession(globalState, hostname);
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(project.path),
      { forceReuseWindow: true },
    );
  }

  function refresh(item: WorkshopItem, mode: RefreshMode = 'wait-on-error'): void {
    if (isWorkshopWindow()) {
      void deferRefreshToLocal(item.workshop.name, item.workshop.projectId, mode);
      return;
    }
    const logLines: string[] = [];
    const action = mode === 'wait-on-error' ? 'refresh and reopen' : `${mode} refresh`;
    const callbacks = refreshCallbacks(item.workshop, logLines);
    const operation = mode === 'abort'
      ? refreshWorkshop(client, item.workshop, { mode, onLog: callbacks.onLog })
      : refreshAndReopen(client, item.workshop, {
        ...withSession(item.workshop, callbacks),
        mode,
      });
    operation.catch((err: unknown) => {
      log.error(`Couldn't ${action} ${item.workshop.name}: ${err instanceof Error ? err.message : String(err)}`);
      void showResolvedWorkshopError(item.workshop, err, logLines);
    });
  }

  async function deferRefreshToLocal(
    name: string,
    projectId: string,
    mode: RefreshMode,
  ): Promise<void> {
    const project = await client.getProject(projectId);
    if (!project) {
      void vscode.window.showErrorMessage('No local project path known for this workshop.');
      return;
    }
    await writePendingOp(globalState, projectId, {
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

  function findWorkshopForDefinition(
    workshops: Workshop[],
    filePath: string,
  ): Workshop | undefined {
    const exact = workshops.find((workshop) => workshop.definitionPath === filePath);
    if (exact) {
      return exact;
    }
    const base = pathBasename(filePath);
    return workshops.find(
      (workshop) => workshop.definitionPath !== undefined
        && pathBasename(workshop.definitionPath) === base,
    );
  }

  async function resolveChangedWorkshop(
    cached: Workshop[] | undefined,
    filePath: string,
  ): Promise<Workshop | undefined> {
    const fromCache = findWorkshopForDefinition(cached ?? [], filePath);
    if (fromCache) {
      return fromCache;
    }
    const projectId = await resolveCurrentProjectId(client, globalState);
    if (!projectId) {
      return undefined;
    }
    const workshops = await listProjectWorkshops(client, projectId);
    return findWorkshopForDefinition(workshops, filePath);
  }

  function definitionChanged(filePath: string, cached: Workshop[] | undefined): void {
    void resolveChangedWorkshop(cached, filePath)
      .then(async (workshop) => {
        if (!workshop || !canRefresh(workshop)) {
          return;
        }
        const choice = await vscode.window.showInformationMessage(
          `"${workshop.name}" definition changed. Refresh and reopen?`,
          'Refresh and Reopen',
        );
        if (choice === 'Refresh and Reopen') {
          void vscode.commands.executeCommand(
            'workshop.refreshAndReopen',
            new WorkshopItem(workshop),
          );
        }
      })
      .catch((err: unknown) => {
        log.debug(`Definition-change prompt skipped: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  async function runPendingOperation(op: PendingOperation): Promise<void> {
    if (op.kind === 'turn-off') {
      await runTurnOff({ name: op.workshopName, status: 'Waiting', projectId: op.projectId })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`Couldn't turn off ${op.workshopName}: ${message}`);
          void vscode.window.showErrorMessage(`Couldn't turn off "${op.workshopName}": ${message}`);
        });
      return;
    }

    const workshop: Workshop = {
      name: op.workshopName,
      status: 'Waiting',
      projectId: op.projectId,
    };
    const logLines: string[] = [];
    refreshAndReopen(
      client,
      workshop,
      {
        ...withSession(workshop, refreshCallbacks(workshop, logLines)),
        mode: op.mode,
      },
    ).catch((err: unknown) => {
      const action = op.mode === 'wait-on-error' ? 'refresh and reopen' : `${op.mode} refresh`;
      log.error(`Couldn't ${action} ${workshop.name}: ${err instanceof Error ? err.message : String(err)}`);
      void showResolvedWorkshopError(workshop, err, logLines);
    });
  }

  function reopenInWorkshopCommand(item: WorkshopItem): void {
    const logLines: string[] = [];
    const callbacks: ReopenCallbacks = { onLog: (lines) => logLines.push(...lines) };
    reopenInWorkshop(
      client,
      item.workshop,
      withSession(item.workshop, callbacks),
    ).catch((err: unknown) => {
      log.error(`Couldn't reopen in workshop ${item.workshop.name}: ${err instanceof Error ? err.message : String(err)}`);
      void showResolvedWorkshopError(item.workshop, err, logLines);
    });
  }

  function openDefinition(arg: WorkshopItem | string): void {
    if (arg instanceof WorkshopItem) {
      const definitionPath = arg.workshop.definitionPath;
      if (definitionPath) {
        void vscode.window.showTextDocument(vscode.Uri.file(definitionPath), { preview: false });
      } else {
        void vscode.window.showWarningMessage(
          `No definition file path is available for "${arg.workshop.name}".`,
        );
      }
      return;
    }
    void vscode.window.showTextDocument(vscode.Uri.file(arg), { preview: false });
  }

  async function turnOff(item: WorkshopItem): Promise<void> {
    const workshop = item.workshop;
    const confirmed = await vscode.window.showWarningMessage(
      `Turn off "${workshop.name}"? `,
      { modal: true, detail: 'This will remove the workshop container and any data stored in the default bind mounts.' },
      'Turn Off',
    );
    if (confirmed !== 'Turn Off') {
      return;
    }

    const current = currentWorkshop(globalState);
    const turningOffCurrent = current?.session?.projectId === workshop.projectId
      && current.session.workshopName === workshop.name;

    if (isWorkshopWindow() && turningOffCurrent) {
      const project = await client.getProject(workshop.projectId);
      if (!project) {
        void vscode.window.showErrorMessage(
          'Cannot turn off: the local project path for this workshop is unknown.',
        );
        return;
      }
      await writePendingOp(globalState, workshop.projectId, {
        kind: 'turn-off',
        workshopName: workshop.name,
        projectId: workshop.projectId,
      } satisfies PendingOperation);
      void vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(project.path),
        { forceReuseWindow: true },
      );
      return;
    }
    await runTurnOff(workshop).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Couldn't turn off ${workshop.name}: ${message}`);
      void vscode.window.showErrorMessage(`Couldn't turn off "${workshop.name}": ${message}`);
    });
  }

  async function runTurnOff(workshop: Workshop): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: workshop.name,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'turning off…' });
        await runAction(client, workshop, 'remove', progress);
      },
    );
  }

  /** Add New Workshop: only one wizard runs at a time. */
  async function addWorkshop(): Promise<void> {
    if (wizardOpen) {
      log.debug('Add New Workshop ignored: a wizard is already open');
      return;
    }
    wizardOpen = true;
    try {
      await runAddWorkshop();
    } finally {
      wizardOpen = false;
    }
  }

  async function runAddWorkshop(): Promise<void> {
    const folders = workspaceFolders();
    if (folders.length === 0) {
      void vscode.window.showWarningMessage('Open a folder first to create a workshop.');
      return;
    }

    const result = await wizard({
      folders,
      log,
    });
    if (!result) {
      return;
    }

    const { folder, name } = result;
    const target = definitionPath(folder.path, name);

    const spec: InitSpec = {
      folder: folder.path,
      name,
      base: result.base,
      sdks: result.sdks.map((sdkName) => ({
        name: sdkName,
        channel: REFERENCE_SDKS.find((r) => r.name === sdkName)?.recommendedChannel,
      })),
    };
    log.info(`Creating workshop: workshop ${buildInitArgs(spec).join(' ')}`);
    try {
      await runInit(spec);
    } catch (err: unknown) {
      const reason = err instanceof InitError
        ? err.reason
        : err instanceof Error ? err.message : String(err);
      log.error(`Failed to create workshop "${name}": ${reason}`);
      if (err instanceof InitError && err.stderr.trim()) {
        log.error(err.stderr.trim());
      }
      void vscode.window.showErrorMessage(`${reason}`);
      return;
    }

    log.info(`Created ${target}`);
    await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: false });
    void vscode.commands.executeCommand('workshop.poll');
  }

  return {
    activateLocalProject,
    definitionChanged,
    reopenInWorkshop: reopenInWorkshopCommand,
    reopenLocally,
    refresh,
    openDefinition,
    turnOff,
    addWorkshop,
  };
}

/** Basename of a path, tolerant of both POSIX and Windows separators. */
function pathBasename(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return separator >= 0 ? path.slice(separator + 1) : path;
}
