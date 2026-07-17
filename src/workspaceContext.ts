import * as vscode from 'vscode';

import { WorkshopClient } from './api/client';
import { hostnameFromFolder, readSession, WorkshopSession } from './state';

type ProjectResolver = Pick<WorkshopClient, 'ensureProject'>;

export interface CurrentWorkshop {
  hostname: string;
  session: WorkshopSession | undefined;
}

export function isWorkshopWindow(): boolean {
  return vscode.env.remoteName === 'ssh-remote';
}

/** Return the SSH identity and stored session for a workshop folder. */
export function currentWorkshop(
  globalState: vscode.Memento,
  folder = vscode.workspace.workspaceFolders?.[0],
): CurrentWorkshop | undefined {
  const hostname = hostnameFromFolder(folder);
  if (!hostname) {
    return undefined;
  }
  return { hostname, session: readSession(globalState, hostname) };
}

/** Resolve the daemon project represented by the current VS Code window. */
export async function resolveCurrentProjectId(
  client: ProjectResolver,
  globalState: vscode.Memento,
  folder = vscode.workspace.workspaceFolders?.[0],
): Promise<string | undefined> {
  if (!folder) {
    return undefined;
  }
  const workshop = currentWorkshop(globalState, folder);
  if (workshop) {
    return workshop.session?.projectId;
  }
  return (await client.ensureProject(folder.uri.fsPath)).id;
}
