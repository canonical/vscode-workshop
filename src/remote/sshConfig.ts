import * as fs from 'node:fs';
import * as path from 'node:path';

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
