import * as vscode from 'vscode';

import { ERROR_KIND_NO_UPDATES_AVAILABLE, WorkshopApiError, WorkshopClient } from '../api/client';
import { Workshop } from '../api/workshops';
import { ReopenCallbacks, reopenInWorkshop, runAction } from './reopen';

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
 *    runs — same loop as the `launch` path in {@link reopenInWorkshop}.
 * 2. If the change pauses (`Wait` state) the refresh failed on a task; defer to
 *    {@link ReopenCallbacks.onPause} so the caller can show the logs and choose
 *    to debug (connect), abort (unwind), or dismiss.
 * 3. On success, call {@link reopenInWorkshop} on the `connect` path (no
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
  projectPath: string,
  workshop: Workshop,
  callbacks: ReopenCallbacks = {},
  mode: 'wait-on-error' | 'continue' | 'abort' = 'wait-on-error',
  reopen = true,
): Promise<string | false> {
  const project = await client.ensureProject(projectPath);

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
          project.id,
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
      await refreshAndReopen(client, projectPath, workshop, { onLog: callbacks.onLog }, 'abort', false);
      return false;
    }
    if (choice !== 'debug') {
      return false;
    }
  }

  // Phase 3: connect, unless the caller opted out (e.g. a local abort). The
  // workshop is running after a successful refresh (or the user chose to debug
  // a paused one); reopenInWorkshop just connects.
  if (!reopen) {
    return false;
  }
  return reopenInWorkshop(client, projectPath, workshop, callbacks);
}
