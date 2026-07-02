import * as vscode from 'vscode';

import { WorkshopClient } from '../api/client';
import { Workshop, reopenAction } from '../api/workshops';
import { ensureSshAccess } from './ssh';
import { writeHostEntry } from './sshConfig';

/**
 * Reopen the current VS Code window connected to a workshop over Remote-SSH.
 *
 * 1. If the workshop is not running, starts or launches it first (REST action,
 *    no CLI).
 * 2. Reads `hostname` from a single `getWorkshop` call (safe immediately after
 *    the action completes, since `workshopAction` waits for the change to finish).
 * 3. Plants the extension's SSH public key inside the container via one-shot
 *    daemon exec.
 * 4. Writes an SSH config host entry so Remote-SSH can reach the workshop.
 * 5. Calls `openFolder` with `forceReuseWindow: true` — same window, no new
 *    window, current ext-host will restart as the connection is made.
 */
export async function reopenInWorkshop(
  client: WorkshopClient,
  projectPath: string,
  workshop: Workshop,
  storageDir: string,
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
      if (action === 'start' || action === 'launch') {
        progress.report({ message: action === 'launch' ? 'launching…' : 'starting…' });
        await client.workshopAction(project.id, [workshop.name], action);
      }

      // Step 2: read the hostname — available immediately after the action
      // completes because workshopAction already waited for the change to finish.
      progress.report({ message: 'Reading workshop info…' });
      const info = await client.getWorkshop(project.id, workshop.name);
      if (!info.hostname) {
        throw new Error(`Workshop ${workshop.name} has no hostname after start`);
      }
      const hostname = info.hostname;

      // Step 3: plant our SSH key inside the container.
      progress.report({ message: 'Setting up SSH access…' });
      await ensureSshAccess(client, project.id, workshop.name, storageDir);

      // Step 4: write the SSH config host entry.
      writeHostEntry(hostname, `${storageDir}/id_ed25519`);

      // Step 5: reopen in the same window via Remote-SSH.
      progress.report({ message: 'Opening…' });
      const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${hostname}/project`);
      await vscode.commands.executeCommand('vscode.openFolder', uri, {
        forceReuseWindow: true,
      });
    },
  );
}
