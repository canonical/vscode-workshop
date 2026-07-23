import * as vscode from 'vscode';

import {
  Change,
  ERROR_KIND_NO_UPDATES_AVAILABLE,
  WorkshopApiError,
  WorkshopClient,
} from './api/client';
import { Workshop, reopenAction } from './api/workshops';
import { ensureDaemonSshInclude } from './remote/ssh';

const ACTION_POLL_MS = 200;

export type PauseChoice = 'debug' | 'abort' | 'dismiss';
export type RefreshMode = 'wait-on-error' | 'continue' | 'abort';

export interface ReopenCallbacks {
  onLog?: (lines: string[]) => void;
  /** Persist any state needed by the new window before this host is replaced. */
  onBeforeOpen?: (hostname: string) => Thenable<void> | void;
  onPause?: (error: string) => Promise<PauseChoice>;
}

export interface RefreshOptions extends ReopenCallbacks {
  mode?: RefreshMode;
}

interface RunActionOptions {
  verbose?: boolean;
  actionOptions?: Record<string, unknown>;
  onLog?: (lines: string[]) => void;
}

type RefreshResult =
  | { status: 'ready' }
  | { status: 'paused'; error: string };

/** Reopen the current window connected to a workshop over Remote-SSH. */
export async function reopenInWorkshop(
  client: WorkshopClient,
  workshop: Workshop,
  callbacks: ReopenCallbacks = {},
): Promise<string> {
  let connectedHostname = '';

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: workshop.name,
      cancellable: false,
    },
    async (progress) => {
      const action = reopenAction(workshop);
      if (action !== 'connect') {
        progress.report({ message: 'turning on…' });
        const change = await runAction(client, workshop, action, progress, {
          verbose: action === 'launch',
          onLog: callbacks.onLog,
        });
        if (change.err) {
          throw new WorkshopApiError(change.err, 0);
        }
      }

      const info = await client.getWorkshop(workshop.projectId, workshop.name);
      if (!info.hostname) {
        throw new Error(
          `"${workshop.name}" is not reachable (status: ${info.status}). ` +
          'The workshop state may have changed. Please try again.',
        );
      }
      connectedHostname = info.hostname;

      ensureDaemonSshInclude(client.socket);

      progress.report({ message: 'Opening…' });
      const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${connectedHostname}/project`);
      await callbacks.onBeforeOpen?.(connectedHostname);
      await vscode.commands.executeCommand('vscode.openFolder', uri, {
        forceReuseWindow: true,
      });
    },
  );

  return connectedHostname;
}

/** POST an action and poll its change while reporting progress and new logs. */
export async function runAction(
  client: WorkshopClient,
  workshop: Pick<Workshop, 'projectId' | 'name'>,
  action: 'start' | 'launch' | 'refresh' | 'remove',
  progress: vscode.Progress<{ message?: string }>,
  options: RunActionOptions = {},
): Promise<Change> {
  const body: Record<string, unknown> = { names: [workshop.name], action };
  if (options.actionOptions && Object.keys(options.actionOptions).length > 0) {
    body['options'] = options.actionOptions;
  }
  const { change: changeId } = await client.postAsync(
    `/v1/projects/${encodeURIComponent(workshop.projectId)}/workshops`,
    body,
  );
  const seenLines = new Map<string, number>();

  for (;;) {
    const change = await client.getChange(changeId, options.verbose ?? false);

    const newLines: string[] = [];
    for (const task of change.tasks ?? []) {
      const seen = seenLines.get(task.id) ?? 0;
      const taskLog = task.log ?? [];
      if (taskLog.length > seen) {
        newLines.push(...taskLog.slice(seen));
        seenLines.set(task.id, taskLog.length);
      }
    }
    if (newLines.length > 0) {
      options.onLog?.(newLines);
    }

    const activeTask = change.tasks?.find(
      (task) => task.status === 'Doing' || task.status === 'Undoing',
    );
    if (activeTask?.summary) {
      const taskProgress = activeTask.progress;
      const percent = taskProgress && taskProgress.total > 1
        ? Math.min(100, Math.max(0, Math.round((taskProgress.done / taskProgress.total) * 100)))
        : undefined;
      progress.report({
        message: percent === undefined
          ? activeTask.summary
          : `${activeTask.summary} (${percent}%)`,
      });
    }

    if (change.ready || change.status === 'Wait') {
      return change;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ACTION_POLL_MS));
  }
}

const REFRESH_VERB: Record<RefreshMode, string> = {
  'wait-on-error': 'refreshing…',
  continue: 'continuing…',
  abort: 'aborting…',
};

/** Refresh a workshop without deciding whether another window should open. */
export async function refreshWorkshop(
  client: WorkshopClient,
  workshop: Workshop,
  options: Pick<RefreshOptions, 'mode' | 'onLog'> = {},
): Promise<RefreshResult> {
  const mode = options.mode ?? 'wait-on-error';

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: workshop.name,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: REFRESH_VERB[mode] });
      let change: Change;
      try {
        change = await runAction(client, workshop, 'refresh', progress, {
          verbose: true,
          onLog: options.onLog,
          actionOptions: { mode },
        });
      } catch (err) {
        if (err instanceof WorkshopApiError && err.kind === ERROR_KIND_NO_UPDATES_AVAILABLE) {
          return { status: 'ready' };
        }
        throw err;
      }

      if (change.status === 'Wait') {
        return { status: 'paused', error: waitingError(change) };
      }
      if (change.err) {
        throw new WorkshopApiError(change.err, 0);
      }
      return { status: 'ready' };
    },
  );
}

/** Refresh a workshop, handle a pause decision, and reconnect when appropriate. */
export async function refreshAndReopen(
  client: WorkshopClient,
  workshop: Workshop,
  options: RefreshOptions = {},
): Promise<string | false> {
  const result = await refreshWorkshop(client, workshop, options);
  if (result.status === 'paused') {
    const choice = (await options.onPause?.(result.error)) ?? 'dismiss';
    if (choice === 'abort') {
      await refreshWorkshop(client, workshop, {
        mode: 'abort',
        onLog: options.onLog,
      });
      return false;
    }
    if (choice !== 'debug') {
      return false;
    }
  }
  return reopenInWorkshop(client, workshop, options);
}

function waitingError(change: Change): string {
  const waiting = (change.tasks ?? [])
    .filter((task) => task.status === 'Wait' && task.summary)
    .map((task) => `  - ${task.summary}`);
  return waiting.length > 0
    ? `Cannot perform the following tasks:\n${waiting.join('\n')}`
    : 'refresh waits on a failing task';
}
