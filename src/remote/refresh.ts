import * as vscode from 'vscode';

import { WorkshopApiError, WorkshopClient } from '../api/client';
import { Workshop } from '../api/workshops';
import { ReopenCallbacks, reopenInWorkshop, runAction } from './reopen';

/**
 * Refresh a workshop from its definition file and reopen the current VS Code
 * window connected to it.
 *
 * 1. POST a `refresh` action with `mode: wait-on-error` and poll the change
 *    with `verbose=true`, streaming task summaries and log lines while the
 *    build runs — same loop as the `launch` path in {@link reopenInWorkshop}.
 * 2. If the change pauses (`Wait` state), notify the user and offer a
 *    "Connect" shortcut to debug inside the workshop.
 * 3. On success, call {@link reopenInWorkshop} on the `connect` path (no
 *    second action needed — the workshop is running after a successful refresh).
 */
export async function refreshAndReopen(
  client: WorkshopClient,
  projectPath: string,
  workshop: Workshop,
  callbacks: ReopenCallbacks = {},
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
      progress.report({ message: 'refreshing…' });
      const change = await runAction(
        client,
        project.id,
        workshop.name,
        'refresh',
        progress,
        callbacks,
        true,
        { mode: 'wait-on-error' },
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
      `"${workshop.name}" paused mid-refresh. Debug in workshop?`,
      'Debug',
      'Cancel',
    );
    if (choice !== 'Debug') {
      return;
    }
  }

  // Phase 3: connect. The workshop is running after a successful refresh (or
  // the user chose to debug a paused one); reopenInWorkshop just connects.
  await reopenInWorkshop(client, projectPath, workshop, callbacks);
}
