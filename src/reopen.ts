import * as vscode from 'vscode';

import { Change, ERROR_KIND_NO_UPDATES_AVAILABLE, WorkshopApiError, WorkshopClient } from './api/client';
import { Workshop, reopenAction } from './api/workshops';
import { ensureDaemonSshInclude } from './remote/ssh';

/** How long to wait between change-poll requests during a launch. */
const LAUNCH_POLL_MS = 200;

/** Callbacks for the launch phase of {@link reopen
 *}. */
export interface ReopenCallbacks {
  /**
   * Called whenever new verbose log lines arrive from the daemon during a
   * `launch` operation. Lines are in the order the daemon produced them.
   */
  onLog?: (lines: string[]) => void;
  /**
   * Called after the hostname is resolved and immediately before opening the
   * remote window. The callback is awaited so callers can persist state before
   * `vscode.openFolder` can replace the extension host.
   */
  onBeforeOpen?: (hostname: string) => Thenable<void> | void;
  /**
   * Called when a `wait-on-error` refresh pauses (Wait state) because a task
   * failed. Receives the failure message from the change. Lets the caller
   * surface the logs and choose how to proceed:
   *   - `debug`   — connect into the paused workshop to investigate.
   *   - `abort`   — unwind the paused refresh (no connect).
   *   - `dismiss` — leave it paused and do nothing.
   * When omitted, a paused refresh is treated as `dismiss`.
   */
  onPause?: (error: string) => Promise<PauseChoice>;
}

/** How to proceed when a `wait-on-error` refresh pauses on a failure. */
export type PauseChoice = 'debug' | 'abort' | 'dismiss';

/**
 * Reopen the current VS Code window connected to a workshop over Remote-SSH.
 *
 * 1. If the workshop is not running, starts or launches it first.
 *    - `start` (stopped workshop): blocking REST action, shows "starting…".
 *    - `launch` (never-built workshop): verbose polling loop that streams task
 *      summaries into the notification and task log lines via {@link ReopenCallbacks.onLog}.
 * 2. Reads `hostname` from a single `getWorkshop` call.
 * 3. Ensures `~/.ssh/config` includes the workshopd CA config so Remote-SSH
 *    trusts the workshop's host certificate and uses the signed user cert.
 * 4. Calls `openFolder` with `forceReuseWindow: true`.
 *
 * Returns the SSH hostname used to open the remote window (e.g.
 * `'web.proj-1.wp'`).  Callers store this in `globalState` so "Reopen Locally"
 * can find its way back.
 */
export async function reopenInWorkshop(
  client: WorkshopClient,
  workshop: Workshop,
  callbacks: ReopenCallbacks = {},
): Promise<string> {
  const projectId = workshop.projectId;

  let connectedHostname = '';

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${workshop.name}`,
      cancellable: false,
    },
    async (progress) => {
      const action = reopenAction(workshop);

      // Step 1: bring the workshop online if needed.
      if (action !== 'connect') {
        progress.report({ message: 'turning on…' });
        const change = await runAction(
          client, projectId, workshop.name, action, progress, callbacks,
          /* verbose */ action === 'launch',
        );
        if (change.err) {
          throw new WorkshopApiError(change.err, 0);
        }
      }

      // Step 2: read the hostname.
      const info = await client.getWorkshop(projectId, workshop.name);
      if (!info.hostname) {
        throw new Error(
          `"${workshop.name}" is not reachable (status: ${info.status}). ` +
          `The workshop state may have changed — please try again.`,
        );
      }
      connectedHostname = info.hostname;

      // Step 3: ensure workshopd's CA config is included in ~/.ssh/config.
      ensureDaemonSshInclude(client.socket);

      // Step 4: reopen in the same window via Remote-SSH.
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

/**
 * POST a workshop action and poll the change, mirroring the progress-tracking
 * loop in `cmd/workshop/wait.go`:
 *
 * - Reports each "Doing" task's `summary` in the VS Code notification.
 * - When `verbose` is true, emits new task log lines via
 *   {@link ReopenCallbacks.onLog} so the caller can stream them into the Logs
 *   View panel.
 *
 * Returns the final Change without throwing — callers must check `.err` and
 * `.status` (e.g. `'Wait'` for a paused `wait-on-error` refresh).
 */
export async function runAction(
  client: WorkshopClient,
  projectId: string,
  name: string,
  action: 'start' | 'launch' | 'refresh' | 'remove',
  progress: vscode.Progress<{ message?: string }>,
  callbacks: ReopenCallbacks,
  verbose: boolean,
  options?: Record<string, unknown>,
): Promise<Change> {
  const body: Record<string, unknown> = { names: [name], action };
  if (options && Object.keys(options).length > 0) {
    body['options'] = options;
  }
  const { change: changeId } = await client.postAsync(
    `/v1/projects/${encodeURIComponent(projectId)}/workshops`,
    body,
  );

  // Track how many log lines we have already forwarded per task, so we only
  // emit newly-arrived lines on each poll — same as seenLines in wait.go.
  const seenLines = new Map<string, number>();

  for (;;) {
    const chg = await client.getChange(changeId, verbose);

    // Collect newly-arrived log lines across all tasks.
    const newLines: string[] = [];
    for (const task of chg.tasks ?? []) {
      const seen = seenLines.get(task.id) ?? 0;
      const taskLog = task.log ?? [];
      if (taskLog.length > seen) {
        newLines.push(...taskLog.slice(seen));
        seenLines.set(task.id, taskLog.length);
      }
    }
    if (newLines.length > 0) {
      callbacks.onLog?.(newLines);
    }

    // Show the first active task's description in the notification bubble,
    // appending a `done/total` counter when the task reports determinate
    // progress (total > 1). We keep the counter in the message rather than
    // using the notification's `increment` bar: a notification progress bar
    // can't switch back from determinate to the indeterminate spinner, so a
    // completed determinate task would leave the bar stuck at 100% for later
    // tasks that report no progress.
    const doingTask = chg.tasks?.find(
      (t) => t.status === 'Doing' || t.status === 'Undoing',
    );
    if (doingTask?.summary) {
      const p = doingTask.progress;
      const percent = p && p.total > 1
        ? Math.min(100, Math.max(0, Math.round((p.done / p.total) * 100)))
        : undefined;
      const message = percent !== undefined
        ? `${doingTask.summary} (${percent}%)`
        : doingTask.summary;
      progress.report({ message });
    }

    // Exit when done or paused. A change only reaches `Wait` via a
    // `wait-on-error` operation (which the daemon allows for launch/refresh but
    // not start/stop/remove), so this is safe for every action: `ready` means
    // the workshop is up, `Wait` means it paused for the caller to handle.
    if (chg.ready || chg.status === 'Wait') {
      return chg;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
  }
}

/** Progress-notification verb shown while each refresh mode runs. */
const REFRESH_VERB: Record<'wait-on-error' | 'continue' | 'abort', string> = {
  'wait-on-error': 'refreshing…',
  continue: 'continuing…',
  abort: 'aborting…',
};

/**
 * Refresh a workshop from its definition file and reopen the current VS Code
 * window connected to it.
 *
 * 1. POST a `refresh` action with the given `mode` and poll the change with
 *    `verbose=true`, streaming task summaries and log lines while the build
 *    runs — same loop as the `launch` path in {@link reopen
 *}.
 * 2. If the change pauses (`Wait` state) the refresh failed on a task; defer to
 *    {@link ReopenCallbacks.onPause} so the caller can show the logs and choose
 *    to debug (connect), abort (unwind), or dismiss.
 * 3. On success, call {@link reopen
 *} on the `connect` path (no
 *    second action needed — the workshop is running after a successful refresh).
 *
 * `mode` selects the refresh behaviour:
 *   - `wait-on-error` — normal refresh; pause on the first failing task.
 *   - `continue`      — resume a workshop paused mid-refresh.
 *   - `abort`         — unwind a workshop paused mid-refresh.
 *
 * `reopen` controls whether to connect into the workshop afterwards. An
 * `abort` triggered from a local window just unwinds and stays local, so the
 * caller passes `false`; every other path reopens.
 *
 * Resolves to the SSH hostname when it actually connected into the workshop,
 * `false` when it returned without connecting (paused-and-dismissed, aborted,
 * or `reopen` was `false`). Callers use the hostname to record the session.
 */
export async function refreshAndReopen(
  client: WorkshopClient,
  workshop: Workshop,
  callbacks: ReopenCallbacks = {},
  mode: 'wait-on-error' | 'continue' | 'abort' = 'wait-on-error',
  doReopen = true,
): Promise<string | false> {
  const projectId = workshop.projectId;

  // Phase 1: run the refresh action with verbose polling so task summaries and
  // log lines are streamed in real time — same approach as launchVerbose.
  let paused = false;
  let pauseError = '';
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${workshop.name}`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: REFRESH_VERB[mode] });
      let change;
      try {
        change = await runAction(
          client,
          projectId,
          workshop.name,
          'refresh',
          progress,
          callbacks,
          true,
          { mode },
        );
      } catch (err) {
        // "no updates available" isn't a failure: the definition already
        // matches the running workshop, so there's nothing to refresh. Fall
        // through to reopening.
        if (err instanceof WorkshopApiError && err.kind === ERROR_KIND_NO_UPDATES_AVAILABLE) {
          return;
        }
        throw err;
      }

      if (change.status === 'Wait') {
        paused = true;
        // The change parked in Wait: one or more tasks are themselves in Wait,
        // paused before they could run. Surface their descriptions the way the
        // CLI does — "cannot perform the following tasks:" followed by a
        // bulleted list of the waiting task summaries.
        const waiting = (change.tasks ?? [])
          .filter((t) => t.status === 'Wait' && t.summary)
          .map((t) => `  - ${t.summary}`);
        pauseError = waiting.length > 0
          ? `Cannot perform the following tasks:\n${waiting.join('\n')}`
          : 'refresh waits on a failing task';
      } else if (change.err) {
        throw new WorkshopApiError(change.err, 0);
      }
    },
  );

  // Phase 2: if paused, the refresh failed on a task. Let the caller surface
  // the logs and choose how to proceed.
  if (paused) {
    const choice = (await callbacks.onPause?.(pauseError)) ?? 'dismiss';
    if (choice === 'abort') {
      // Unwind the paused refresh and stay put — no connect.
      await refreshAndReopen(client, workshop, { onLog: callbacks.onLog }, 'abort', false);
      return false;
    }
    if (choice !== 'debug') {
      return false;
    }
  }

  // Phase 3: connect, unless the caller opted out (e.g. a local abort). The
  // workshop is running after a successful refresh (or the user chose to debug
  // a paused one); reopen
  // just connects.
  if (!doReopen) {
    return false;
  }
  return reopenInWorkshop(client, workshop, callbacks);
}
