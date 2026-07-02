import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Idempotently upsert a `Host` block for `hostname` into the file at
 * `filePath` (creating it if absent). Any existing block for the same hostname
 * is replaced in-place so the file never accumulates duplicates.
 */
export function upsertHostBlock(filePath: string, hostname: string, identityFile: string): void {
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {throw err;}
  }

  const cleaned = removeHostBlock(existing, hostname);
  const separator = cleaned.length > 0 ? '\n' : '';
  const content = cleaned + separator + buildHostBlock(hostname, identityFile);
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

/**
 * Ensure `Include <includePath>` appears at the top of the SSH config file at
 * `configPath`. Creates the file if absent. Never inserts a duplicate.
 */
export function ensureInclude(configPath: string, includePath: string): void {
  const directive = `Include ${includePath}`;
  let existing = '';
  try {
    existing = fs.readFileSync(configPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {throw err;}
  }
  if (existing.split('\n').some((l) => l.trim() === directive)) {return;}
  const tail = existing.length > 0 ? `\n${existing}` : '';
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${directive}\n${tail}`, { mode: 0o600 });
}

/**
 * Write a workshop SSH host entry so Remote-SSH can connect to `hostname`
 * without prompting or host-key warnings.
 *
 * - Upserts `~/.ssh/config.d/workshop` (idempotent per hostname).
 * - Prepends `Include ~/.ssh/config.d/*` to `~/.ssh/config` if missing.
 */
export function writeHostEntry(hostname: string, identityFile: string): void {
  const sshDir = path.join(os.homedir(), '.ssh');
  const configDotD = path.join(sshDir, 'config.d');
  fs.mkdirSync(configDotD, { recursive: true, mode: 0o700 });
  upsertHostBlock(path.join(configDotD, 'workshop'), hostname, identityFile);
  ensureInclude(path.join(sshDir, 'config'), '~/.ssh/config.d/*');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildHostBlock(hostname: string, identityFile: string): string {
  return [
    `Host ${hostname}`,
    `    HostName ${hostname}`,
    `    User workshop`,
    `    IdentityFile ${identityFile}`,
    `    IdentitiesOnly yes`,
    `    StrictHostKeyChecking no`,
    `    UserKnownHostsFile /dev/null`,
    '',
  ].join('\n');
}

/**
 * Remove the `Host <hostname>` block (from the `Host` line to the line before
 * the next `Host` keyword or EOF), then trim trailing blank lines.
 *
 * Limitation: only `Host` keywords reset the block boundary. The SSH config
 * grammar also uses `Match` as a block terminator, but we never write `Match`
 * blocks to the file we manage (`~/.ssh/config.d/workshop`), so this is safe.
 */
function removeHostBlock(content: string, hostname: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    const m = line.match(/^Host\s+(.+)$/);
    if (m) {
      inBlock = m[1].trim() === hostname;
    }
    if (!inBlock) {
      kept.push(line);
    }
  }

  // Trim trailing blank lines.
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }
  return kept.length > 0 ? kept.join('\n') + '\n' : '';
}
