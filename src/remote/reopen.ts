import * as vscode from 'vscode';

import { WorkshopApiError, WorkshopClient } from '../api/client';
import { Workshop, reopenAction } from '../api/workshops';
import { ensureDaemonSshInclude } from './ssh';

/** How long to wait between change-poll requests during a launch. */
const LAUNCH_POLL_MS = 200;

/** Callbacks for the launch phase of {@link reopenInWorkshop}. */
export interface ReopenCallbacks {
  /**
   * Called whenever new verbose log lines arrive from the daemon during a
   * `launch` operation. Lines are in the order the daemon produced them.
   */
  onLog?: (lines: string[]) => void;
}

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
 */
export async function reopenInWorkshop(
  client: WorkshopClient,
  projectPath: string,
  workshop: Workshop,
  callbacks: ReopenCallbacks = {},
): Promise<void> {
  const project = await client.ensureProject(projectPath);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Workshop: ${workshop.name}`,
      cancellable: false,
    },
    async (progress) => {
      const action = reopenAction(workshop);

      // Step 1: bring the workshop online if needed.
      if (action === 'start') {
        progress.report({ message: 'starting…' });
        await client.workshopAction(project.id, [workshop.name], 'start');
      } else if (action === 'launch') {
        await launchVerbose(client, project.id, workshop.name, progress, callbacks);
      }

      // Step 2: read the hostname — available immediately after the action
      // completes because the polling loop already waited for the change to finish.
      progress.report({ message: 'Reading workshop info…' });
      const info = await client.getWorkshop(project.id, workshop.name);
      if (!info.hostname) {
        throw new Error(
          `"${workshop.name}" is not reachable (status: ${info.status}). ` +
          `The workshop state may have changed — please try again.`,
        );
      }
      const hostname = info.hostname;

      // Step 3: ensure workshopd's CA config is included in ~/.ssh/config.
      ensureDaemonSshInclude(client.socket);

      // Step 4: reopen in the same window via Remote-SSH.
      progress.report({ message: 'Opening…' });
      const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${hostname}/project`);
      await vscode.commands.executeCommand('vscode.openFolder', uri, {
        forceReuseWindow: true,
      });
    },
  );
}

/**
 * POST a `launch` action and poll the change with `verbose=true`, mirroring
 * the progress-tracking loop in `cmd/workshop/wait.go`:
 *
 * - Reports each "Doing" task's `summary` in the VS Code notification.
 * - Emits new task log lines via {@link ReopenCallbacks.onLog} so the caller
 *   can stream them into the Logs View panel.
 */
async function launchVerbose(
  client: WorkshopClient,
  projectId: string,
  name: string,
  progress: vscode.Progress<{ message?: string }>,
  callbacks: ReopenCallbacks,
): Promise<void> {
  const { change: changeId } = await client.postAsync(
    `/v1/projects/${encodeURIComponent(projectId)}/workshops`,
    { names: [name], action: 'launch' },
  );

  // Track how many log lines we have already forwarded per task, so we only
  // emit newly-arrived lines on each poll — same as seenLines in wait.go.
  const seenLines = new Map<string, number>();

  for (;;) {
    const chg = await client.getChange(changeId, true /* verbose */);

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

    // Show the first active task's description in the notification bubble.
    const doingTask = chg.tasks?.find(
      (t) => t.status === 'Doing' || t.status === 'Undoing',
    );
    if (doingTask?.summary) {
      progress.report({ message: doingTask.summary });
    }

    if (chg.ready) {
      if (chg.err) {
        throw new WorkshopApiError(chg.err, 0);
      }
      return;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
  }
}
