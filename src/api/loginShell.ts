import { WorkshopClient } from './client';
import { execWorkshop } from './exec';

const LOGIN_SHELL_SETTINGS = `{
  "terminal.integrated.profiles.linux": { "bash": { "path": "bash", "args": ["-l"] } },
  "terminal.integrated.defaultProfile.linux": "bash"
}
`;

// Stage stdin in a temp file, then hard-link it into place: ln is atomic and never replaces an existing file.
export const WRITE_IF_ABSENT = [
  'f="$HOME/.vscode-server/data/Machine/settings.json"',
  'mkdir -p "${f%/*}" || exit',
  't=$(mktemp "$f.XXXXXX") || exit',
  'trap \'rm -f "$t"\' EXIT',
  'cat > "$t" || exit',
  'ln "$t" "$f" 2>/dev/null || [ -e "$f" ]',
].join('\n');

/**
 * Default the workshop's VS Code Server terminals to a login shell, so they get
 * the /etc/profile.d SDK environment that Remote-SSH sessions lack.
 */
export async function ensureLoginShellTerminals(
  client: WorkshopClient,
  projectId: string,
  name: string,
): Promise<void> {
  const result = await execWorkshop(client, projectId, name, {
    command: ['sh', '-c', WRITE_IF_ABSENT],
    stdin: LOGIN_SHELL_SETTINGS,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `exit code ${result.exitCode}`);
  }
}
