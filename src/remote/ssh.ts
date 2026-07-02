import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { WorkshopClient } from '../api/client';
import { execWorkshop } from '../api/exec';

/** Paths to the local keypair managed by this extension. */
export interface Keypair {
  /** Absolute path to the OpenSSH private key file (mode 0600). */
  privateKeyPath: string;
  /** The SSH authorized_keys line for the public key. */
  publicKeyLine: string;
}

/**
 * Return the workshop-vscode keypair stored under `storageDir`, generating it
 * if it does not exist yet. Idempotent: calling twice returns the same key.
 *
 * Keys are generated via `ssh-keygen` so the private key is in OpenSSH native
 * format (`-----BEGIN OPENSSH PRIVATE KEY-----`), which every OpenSSH client
 * accepts without question. The companion `.pub` file is the
 * `ssh-ed25519 <base64> comment` line ready for `authorized_keys`.
 */
export function ensureKeypair(storageDir: string): Keypair {
  const privateKeyPath = path.join(storageDir, 'id_ed25519');
  const publicKeyPath = path.join(storageDir, 'id_ed25519.pub');

  if (!fs.existsSync(privateKeyPath)) {
    fs.mkdirSync(storageDir, { recursive: true });
    const result = childProcess.spawnSync(
      'ssh-keygen',
      ['-t', 'ed25519', '-f', privateKeyPath, '-N', '', '-C', 'workshop-vscode'],
      { stdio: 'pipe' },
    );
    if (result.status !== 0) {
      throw new Error(
        `ssh-keygen failed (exit ${result.status}): ${result.stderr?.toString().trim()}`,
      );
    }
  }

  const publicKeyLine = fs.readFileSync(publicKeyPath, 'utf8').trim();
  return { privateKeyPath, publicKeyLine };
}

/**
 * Ensure the extension's SSH public key is present in the workshop user's
 * `~/.ssh/authorized_keys` inside the container. Idempotent.
 *
 * Runs a single non-interactive command via the daemon exec endpoint; the
 * key is passed on stdin to avoid shell-quoting issues.
 */
export async function ensureSshAccess(
  client: WorkshopClient,
  projectId: string,
  name: string,
  storageDir: string,
): Promise<void> {
  const { publicKeyLine } = ensureKeypair(storageDir);

  const result = await execWorkshop(client, projectId, name, {
    command: ['bash', '-c', KEY_PLANT_SCRIPT],
    stdin: `${publicKeyLine}\n`,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to plant SSH key in workshop ${name}: exit ${result.exitCode}\n${result.stderr}`,
    );
  }
}

/**
 * Shell script run as root inside the container.
 *
 * - Reads the public key from stdin (avoids all quoting problems).
 * - Creates `~workshop/.ssh/` with correct ownership/permissions.
 * - Appends the key to `authorized_keys` only if not already present.
 */
const KEY_PLANT_SCRIPT = `
set -euo pipefail
PUBKEY=$(cat)
install -d -m 700 -o workshop -g workshop /home/workshop/.ssh
grep -qxF "$PUBKEY" /home/workshop/.ssh/authorized_keys 2>/dev/null \\
  || printf '%s\\n' "$PUBKEY" >> /home/workshop/.ssh/authorized_keys
chown workshop:workshop /home/workshop/.ssh/authorized_keys
chmod 600 /home/workshop/.ssh/authorized_keys
`.trim();
