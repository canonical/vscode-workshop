import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { WorkshopClient } from '../api/client';
import { execWorkshop } from '../api/exec';

/** Paths to the local keypair managed by this extension. */
export interface Keypair {
  /** Absolute path to the PKCS8 PEM private key file (mode 0600). */
  privateKeyPath: string;
  /** The SSH authorized_keys line for the public key. */
  publicKeyLine: string;
}

/**
 * Return the workshop-vscode keypair stored under `storageDir`, generating it
 * if it does not exist yet. Idempotent: calling twice returns the same key.
 *
 * The private key is written in OpenSSH format (`-----BEGIN OPENSSH PRIVATE KEY-----`),
 * the same format produced by `ssh-keygen -t ed25519`. The public key line is
 * the `ssh-ed25519 <base64>` format required by `authorized_keys`.
 */
export function ensureKeypair(storageDir: string): Keypair {
  const privateKeyPath = path.join(storageDir, 'id_ed25519');
  const publicKeyPath = path.join(storageDir, 'id_ed25519.pub');

  if (!fs.existsSync(privateKeyPath)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      privateKeyPath,
      // `openssh` is valid at runtime but absent from @types/node's overloads.
      (privateKey.export({ type: 'openssh', format: 'pem' } as unknown as crypto.KeyExportOptions<'pem'>) as string),
      { mode: 0o600 },
    );
    fs.writeFileSync(publicKeyPath, toAuthorizedKey(publicKey), { mode: 0o644 });
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

/**
 * Convert a Node.js ed25519 `KeyObject` to the `ssh-ed25519 <base64>` line
 * used in `authorized_keys`.
 *
 * Exports via JWK: the `x` field is the base64url-encoded 32-byte raw public
 * key — no DER parsing or hardcoded byte offsets.
 */
function toAuthorizedKey(publicKey: crypto.KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) {
    throw new Error('ed25519 JWK missing x parameter');
  }
  const rawKey = Buffer.from(jwk.x, 'base64url');
  const keyType = Buffer.from('ssh-ed25519');
  const wire = Buffer.allocUnsafe(4 + keyType.length + 4 + rawKey.length);
  wire.writeUInt32BE(keyType.length, 0);
  keyType.copy(wire, 4);
  wire.writeUInt32BE(rawKey.length, 4 + keyType.length);
  rawKey.copy(wire, 4 + keyType.length + 4);
  return `ssh-ed25519 ${wire.toString('base64')} workshop-vscode`;
}
