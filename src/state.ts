import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-hostname record stored under `'workshop.sessions'` in `globalState`.
 *
 * Written just before a workshop window is opened via Remote-SSH; cleared when
 * "Reopen Locally" returns the user to the local project.  Keyed by SSH
 * hostname (e.g. `'web.proj-1.wp'`) so concurrent workshop windows for
 * different projects never overwrite each other.
 */
export interface WorkshopSession {
  /** Absolute local path to the project directory on the host machine. */
  localProjectPath: string;
  /** Workshop name (e.g. `'web'`). */
  workshopName: string;
}

/**
 * An operation deferred to the local window because it must run against the
 * local daemon.  Stored under `'workshop.pendingOps'` keyed by
 * `localProjectPath` so it can only be consumed by the window that owns that
 * project — stale ops from other projects are structurally invisible.
 */
export type PendingOperation =
  | { kind: 'refresh'; workshopName: string; mode: 'wait-on-error' | 'continue' | 'abort' }
  | { kind: 'turn-off'; workshopName: string };

// ---------------------------------------------------------------------------
// globalState key constants
// ---------------------------------------------------------------------------

export const SESSIONS_KEY = 'workshop.sessions';
export const PENDING_OPS_KEY = 'workshop.pendingOps';

// ---------------------------------------------------------------------------
// Hostname helpers
// ---------------------------------------------------------------------------

/**
 * Extract the SSH hostname from a workspace folder URI.
 *
 * Inside a Remote-SSH workshop window, `folder.uri` has scheme `vscode-remote`
 * and authority `ssh-remote+<hostname>`.  Returns `undefined` in a local window
 * (scheme `file`) or when the authority format is unrecognised.
 */
export function hostnameFromFolder(
  folder: vscode.WorkspaceFolder | undefined,
): string | undefined {
  if (!folder || folder.uri.scheme !== 'vscode-remote') {
    return undefined;
  }
  const authority = folder.uri.authority; // "ssh-remote+<hostname>"
  const prefix = 'ssh-remote+';
  return authority.startsWith(prefix) ? authority.slice(prefix.length) : undefined;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/** Read the session record for the given SSH hostname, or `undefined` if absent. */
export function readSession(
  globalState: vscode.Memento,
  hostname: string,
): WorkshopSession | undefined {
  const all = globalState.get<Record<string, WorkshopSession>>(SESSIONS_KEY) ?? {};
  return all[hostname];
}

/** Persist a session record for the given SSH hostname. */
export function writeSession(
  globalState: vscode.Memento,
  hostname: string,
  session: WorkshopSession,
): Thenable<void> {
  const all = globalState.get<Record<string, WorkshopSession>>(SESSIONS_KEY) ?? {};
  return globalState.update(SESSIONS_KEY, { ...all, [hostname]: session });
}

/** Remove the session record for the given SSH hostname. */
export function clearSession(
  globalState: vscode.Memento,
  hostname: string,
): Thenable<void> {
  const all = globalState.get<Record<string, WorkshopSession>>(SESSIONS_KEY) ?? {};
  const { [hostname]: _removed, ...rest } = all;
  return globalState.update(SESSIONS_KEY, Object.keys(rest).length > 0 ? rest : undefined);
}

// ---------------------------------------------------------------------------
// Pending-operation helpers
// ---------------------------------------------------------------------------

/** Read the pending operation for the given local project path, or `undefined`. */
export function readPendingOp(
  globalState: vscode.Memento,
  localProjectPath: string,
): PendingOperation | undefined {
  const all = globalState.get<Record<string, PendingOperation>>(PENDING_OPS_KEY) ?? {};
  return all[localProjectPath];
}

/** Persist a pending operation for the given local project path. */
export function writePendingOp(
  globalState: vscode.Memento,
  localProjectPath: string,
  op: PendingOperation,
): Thenable<void> {
  const all = globalState.get<Record<string, PendingOperation>>(PENDING_OPS_KEY) ?? {};
  return globalState.update(PENDING_OPS_KEY, { ...all, [localProjectPath]: op });
}

/** Remove the pending operation for the given local project path. */
export function clearPendingOp(
  globalState: vscode.Memento,
  localProjectPath: string,
): Thenable<void> {
  const all = globalState.get<Record<string, PendingOperation>>(PENDING_OPS_KEY) ?? {};
  const { [localProjectPath]: _removed, ...rest } = all;
  return globalState.update(PENDING_OPS_KEY, Object.keys(rest).length > 0 ? rest : undefined);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the local filesystem path for the project open in the given
 * workspace folder.
 *
 * - **Local window** (`folder.uri.scheme === 'file'`): returns `folder.uri.fsPath`.
 * - **Remote-SSH window** (`vscode-remote` scheme): looks up the session record
 *   by hostname to recover the local path stored when the window was opened.
 *   Returns `undefined` if no session exists (window opened via some other
 *   means, e.g. the Remote Explorer).
 * - Returns `undefined` when no folder is open.
 */
export function resolveLocalProjectPath(
  folder: vscode.WorkspaceFolder | undefined,
  globalState: vscode.Memento,
): string | undefined {
  if (!folder) {
    return undefined;
  }
  if (folder.uri.scheme === 'file') {
    return folder.uri.fsPath;
  }
  const hostname = hostnameFromFolder(folder);
  if (!hostname) {
    return undefined;
  }
  return readSession(globalState, hostname)?.localProjectPath;
}
