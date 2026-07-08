import * as vscode from 'vscode';

import { WorkshopApiError, WorkshopClient } from '../api/client';
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
 * 2. If the change pauses (`Wait` state), notify the user and offer a
 *    "Debug" shortcut to connect inside the paused workshop.
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
 */
export async function refreshAndReopen(
  client: WorkshopClient,
  projectPath: string,
  workshop: Workshop,
  callbacks: ReopenCallbacks = {},
  mode: 'wait-on-error' | 'continue' | 'abort' = 'wait-on-error',
  reopen = true,
): Promise<void> {
  const project = await client.ensureProject(projectPath);

  // Phase 1: run the refresh action with verbose polling so task summaries and
  // log lines are streamed in real time — same approach as launchVerbose.
  let paused = false;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Workshop: ${workshop.name}`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: REFRESH_VERB[mode] });
      const change = await runAction(
        client,
        project.id,
        workshop.name,
        'refresh',
        progress,
        callbacks,
        true,
        { mode },
      );

      if (change.status === 'Wait') {
        paused = true;
      } else if (change.err) {
        throw new WorkshopApiError(change.err, 0);
      }
    },
  );

  // Phase 2: if paused, ask whether to connect for debugging.
  if (paused) {
    const choice = await vscode.window.showInformationMessage(
      `"${workshop.name}" refresh failed. Debug in workshop?`,
      'Debug',
      'Cancel',
    );
    if (choice !== 'Debug') {
      return;
    }
  }

  // Phase 3: connect, unless the caller opted out (e.g. a local abort). The
  // workshop is running after a successful refresh (or the user chose to debug
  // a paused one); reopenInWorkshop just connects.
  if (reopen) {
    await reopenInWorkshop(client, projectPath, workshop, callbacks);
  }
}
