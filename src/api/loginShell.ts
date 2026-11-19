import { WorkshopClient } from './client';
import { execWorkshop } from './exec';

const LOGIN_SHELL_SETTINGS = `{
  "terminal.integrated.profiles.linux": { "bash": { "path": "bash", "args": ["-l"] } },
  "terminal.integrated.defaultProfile.linux": "bash"
}
`;

// noclobber creates with O_EXCL, so existing machine settings are never overwritten.
export const WRITE_IF_ABSENT = 'f="$HOME/.vscode-server/data/Machine/settings.json"; mkdir -p "${f%/*}" && { set -C; cat > "$f"; } || [ -e "$f" ]';

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
