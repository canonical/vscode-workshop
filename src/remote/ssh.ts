import * as os from 'node:os';
import * as path from 'node:path';

import { SNAP_SOCKET_PATH } from '../api/client';
import { ensureInclude } from './sshConfig';

const SNAP_SSH_DIR = '/var/snap/workshop/current/ssh';
const DEFAULT_SSH_DIR = '/var/lib/workshop/ssh';

/**
 * Return the path to the workshopd-generated SSH config for the current user.
 *
 * workshopd places the config at `<ssh-dir>/<uid>/config` where `<ssh-dir>`
 * depends on how Workshop is installed:
 *   - snap:   `/var/snap/workshop/current/ssh`
 *   - system: `/var/lib/workshop/ssh`
 */
export function daemonSshConfigPath(socketPath: string): string {
  const sshDir = socketPath.startsWith('/var/snap/workshop/') ? SNAP_SSH_DIR : DEFAULT_SSH_DIR;
  const uid = String(os.userInfo().uid);
  return path.join(sshDir, uid, 'config');
}

/**
 * Ensure `~/.ssh/config` includes the workshopd CA-generated SSH config for
 * the current user. workshopd acts as a CA: it signs a user certificate and
 * writes a `known_hosts` trusted by cert-authority, so no per-workshop key
 * generation or planting is needed.
 */
export function ensureDaemonSshInclude(socketPath: string): void {
  ensureInclude(path.join(os.homedir(), '.ssh', 'config'), daemonSshConfigPath(socketPath));
}

// Re-export SNAP_SOCKET_PATH so callers that only import from this module
// don't need a separate client import.
export { SNAP_SOCKET_PATH };
