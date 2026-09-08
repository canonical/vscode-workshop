import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The subset of the local `product.json` that Remote-SSH uses to locate and
 * install a matching server on the host. Read from `vscode.env.appRoot` by the
 * caller; this module never imports `vscode` so it stays unit-testable.
 */
export interface ClientServerIdentity {
  /** Commit the server is keyed on (exact match, not the version). */
  commit: string;
  /** `stable` or `insider`. */
  quality: string;
  /** Server data folder under `$HOME` (default `.vscode-server`). */
  serverDataFolderName: string;
  /** Server launcher name (default `code-server`). */
  serverApplicationName: string;
  /** Optional download URL template with `${quality}`/`${commit}`/`${os}`/`${arch}`. */
  serverDownloadUrlTemplate?: string;
}

/** Reads a UTF-8 file; injected in tests. */
export type ReadFile = (filePath: string) => string;

const defaultReadFile: ReadFile = (filePath) => fs.readFileSync(filePath, 'utf8');

/**
 * Parse the local `product.json` into a {@link ClientServerIdentity}.
 *
 * Returns `undefined` when the file is missing, unparseable, or has no
 * `commit` (OSS/dev builds) — the signal for callers to skip seeding and let
 * Remote-SSH behave normally.
 */
export function readClientServerIdentity(
  appRoot: string,
  readFile: ReadFile = defaultReadFile,
): ClientServerIdentity | undefined {
  let raw: string;
  try {
    raw = readFile(path.join(appRoot, 'product.json'));
  } catch {
    return undefined;
  }

  let product: Record<string, unknown>;
  try {
    product = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const commit = typeof product['commit'] === 'string' ? product['commit'] : undefined;
  if (!commit) {
    return undefined;
  }

  return {
    commit,
    quality: asString(product['quality'], 'stable'),
    serverDataFolderName: asString(product['serverDataFolderName'], '.vscode-server'),
    serverApplicationName: asString(product['serverApplicationName'], 'code-server'),
    serverDownloadUrlTemplate:
      typeof product['serverDownloadUrlTemplate'] === 'string'
        ? product['serverDownloadUrlTemplate']
        : undefined,
  };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Remote server platforms supported by the pre-install path. */
export type RemotePlatform = 'linux-x64' | 'linux-arm64' | 'linux-armhf';

/**
 * URL of the server tarball (`vscode-server-<platform>.tar.gz`) for a commit.
 *
 * Uses `serverDownloadUrlTemplate` from `product.json` when present (the same
 * source Remote-SSH uses), else the stable `update.code.visualstudio.com`
 * fallback keyed by commit.
 */
export function serverDownloadUrl(
  identity: ClientServerIdentity,
  platform: RemotePlatform,
): string {
  const [os, arch] = platform.split('-');
  if (identity.serverDownloadUrlTemplate) {
    return applyTemplate(identity.serverDownloadUrlTemplate, identity, os, arch);
  }
  return `https://update.code.visualstudio.com/commit:${identity.commit}` +
    `/server-${platform}/${identity.quality}`;
}

/**
 * URL of the standalone CLI binary (`code-<commit>`) for the CLI server layout.
 * Always the `update.code.visualstudio.com` endpoint keyed by commit.
 */
export function cliDownloadUrl(
  identity: ClientServerIdentity,
  platform: RemotePlatform,
): string {
  return `https://update.code.visualstudio.com/commit:${identity.commit}` +
    `/cli-${platform}/${identity.quality}`;
}

function applyTemplate(
  template: string,
  identity: ClientServerIdentity,
  os: string,
  arch: string,
): string {
  return template
    .replace(/\$\{quality\}/g, identity.quality)
    .replace(/\$\{commit\}/g, identity.commit)
    .replace(/\$\{os\}/g, os)
    .replace(/\$\{arch\}/g, arch);
}

/** Minimal `fetch` shape used for downloads; injected in tests. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Minimal filesystem surface used by the cache; injected in tests. */
export interface CacheFs {
  existsSync(filePath: string): boolean;
  mkdirSync(dir: string, options: { recursive: boolean }): void;
  writeFileSync(filePath: string, data: Buffer): void;
  renameSync(from: string, to: string): void;
  rmSync(filePath: string, options: { force: boolean }): void;
}

const defaultCacheFs: CacheFs = {
  existsSync: fs.existsSync,
  mkdirSync: (dir, options) => void fs.mkdirSync(dir, options),
  writeFileSync: fs.writeFileSync,
  renameSync: fs.renameSync,
  rmSync: fs.rmSync,
};

/**
 * Download `url` into `targetPath` exactly once, reusing an existing file.
 *
 * Writes to a `*.part` sibling first, then renames on success so a partial
 * transfer never looks complete. On failure the partial file is removed.
 * Returns `targetPath` for convenience.
 */
export async function ensureCachedTarball(
  targetPath: string,
  url: string,
  fetchImpl: FetchLike,
  fsImpl: CacheFs = defaultCacheFs,
): Promise<string> {
  if (fsImpl.existsSync(targetPath)) {
    return targetPath;
  }
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });

  const partPath = `${targetPath}.part`;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Download failed (HTTP ${response.status}) for ${url}`);
    }
    fsImpl.writeFileSync(partPath, Buffer.from(await response.arrayBuffer()));
    fsImpl.renameSync(partPath, targetPath);
    return targetPath;
  } catch (err) {
    fsImpl.rmSync(partPath, { force: true });
    throw err;
  }
}

/** Minimal spawned-process surface used by the SSH/SCP wrappers. */
export interface SpawnedProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
}

/** Injectable `child_process.spawn`; only argv arrays are ever passed (no shell). */
export type SpawnFn = (command: string, args: string[]) => SpawnedProcess;

const defaultSpawn: SpawnFn = (command, args) => cp.spawn(command, args);

/** Result of running a process to completion. */
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * SSH options shared by every invocation: fail fast rather than prompt, so a
 * misconfigured host never blocks the reopen flow on an interactive question.
 */
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

/** Run a process to completion, capturing stdout/stderr. Never uses a shell. */
export function runProcess(
  spawn: SpawnFn,
  command: string,
  args: string[],
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/** SSH runner bound to a hostname: resolves stdout, throws on non-zero exit. */
export type SshRun = (argv: string[]) => Promise<string>;
/** SCP pusher bound to a hostname: resolves on success, throws on non-zero exit. */
export type ScpPush = (localPath: string, remotePath: string) => Promise<void>;

/** Run `ssh <hostname> <argv…>` and return stdout, throwing on failure. */
export async function sshRun(
  spawn: SpawnFn,
  hostname: string,
  argv: string[],
): Promise<string> {
  const result = await runProcess(spawn, 'ssh', [...SSH_OPTIONS, hostname, ...argv]);
  if (result.code !== 0) {
    throw new Error(`ssh ${hostname} exited ${result.code}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Run `scp <localPath> <hostname>:<remotePath>`, throwing on failure. */
export async function scpPush(
  spawn: SpawnFn,
  hostname: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  const result = await runProcess(spawn, 'scp', [
    ...SSH_OPTIONS,
    localPath,
    `${hostname}:${remotePath}`,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `scp to ${hostname}:${remotePath} exited ${result.code}: ${result.stderr.trim()}`,
    );
  }
}

/**
 * Absolute remote paths (using `$HOME`) for both server layouts, keyed by the
 * client's commit. Used inside remote `bash -c` scripts where `$HOME` expands.
 */
export interface ServerLayout {
  dataDir: string;
  legacyServerDir: string;
  legacyLauncher: string;
  cliServerDir: string;
  cliLauncher: string;
  cliBinary: string;
}

/** CLI server directory label per quality: `Stable-<commit>` / `Insiders-<commit>`. */
function qualityLabel(quality: string): string {
  return quality === 'insider' || quality === 'insiders' ? 'Insiders' : 'Stable';
}

/** Compute the on-disk layout paths for a client identity. */
export function serverLayout(identity: ClientServerIdentity): ServerLayout {
  const dataDir = `$HOME/${identity.serverDataFolderName}`;
  const legacyServerDir = `${dataDir}/bin/${identity.commit}`;
  const cliServerDir =
    `${dataDir}/cli/servers/${qualityLabel(identity.quality)}-${identity.commit}/server`;
  return {
    dataDir,
    legacyServerDir,
    legacyLauncher: `${legacyServerDir}/bin/${identity.serverApplicationName}`,
    cliServerDir,
    cliLauncher: `${cliServerDir}/bin/${identity.serverApplicationName}`,
    cliBinary: `${dataDir}/code-${identity.commit}`,
  };
}

/** Map `uname -sm` output to a supported {@link RemotePlatform}. */
export function mapUname(uname: string): RemotePlatform | undefined {
  const [os, machine] = uname.trim().split(/\s+/);
  if (os !== 'Linux') {
    return undefined;
  }
  switch (machine) {
    case 'x86_64':
      return 'linux-x64';
    case 'aarch64':
    case 'arm64':
      return 'linux-arm64';
    case 'armv7l':
    case 'armv8l':
    case 'armhf':
      return 'linux-armhf';
    default:
      return undefined;
  }
}

/** Detect the remote platform via `uname -sm`; throws when unsupported. */
export async function detectRemotePlatform(ssh: SshRun): Promise<RemotePlatform> {
  const uname = (await ssh(['uname', '-sm'])).trim();
  const platform = mapUname(uname);
  if (!platform) {
    throw new Error(`Unsupported remote platform: ${uname}`);
  }
  return platform;
}

/**
 * True when a complete server is already installed under either layout. Checks
 * that a launcher exists and is executable, so a partial extract reads as absent.
 */
export async function remoteServerPresent(
  identity: ClientServerIdentity,
  ssh: SshRun,
): Promise<boolean> {
  const layout = serverLayout(identity);
  const script =
    `if [ -x "${layout.legacyLauncher}" ] || [ -x "${layout.cliLauncher}" ]; ` +
    'then echo present; else echo absent; fi';
  const out = (await ssh(['bash', '-c', script])).trim();
  return out === 'present';
}

/** Local (already downloaded) tarball paths to push to the host. */
export interface LocalTarballs {
  /** The `vscode-server-<platform>.tar.gz` payload (required). */
  server: string;
  /** The gzipped CLI binary; enables seeding the CLI layout when present. */
  cli?: string;
}

/** Remote paths after upload; mirrors {@link LocalTarballs}. */
interface RemoteTarballs {
  server: string;
  cli?: string;
}

/**
 * Build the idempotent remote `bash` script that seeds both server layouts.
 *
 * Each layout is guarded by its launcher check, extracted with
 * `--strip-components=1` into a staging sibling, then atomically `mv`d into
 * place so a partial transfer never looks installed. The CLI layout (and its
 * `code-<commit>` binary) is only emitted when a CLI tarball was uploaded.
 */
export function buildInstallScript(
  identity: ClientServerIdentity,
  tarballs: RemoteTarballs,
  tmpDir: string,
): string {
  const layout = serverLayout(identity);
  const lines = ['set -eu'];

  lines.push(
    `if [ ! -x "${layout.legacyLauncher}" ]; then`,
    `  mkdir -p "$(dirname "${layout.legacyServerDir}")"`,
    `  rm -rf "${layout.legacyServerDir}.staging"`,
    `  mkdir -p "${layout.legacyServerDir}.staging"`,
    `  tar -xzf "${tarballs.server}" -C "${layout.legacyServerDir}.staging" --strip-components=1`,
    `  rm -rf "${layout.legacyServerDir}"`,
    `  mv "${layout.legacyServerDir}.staging" "${layout.legacyServerDir}"`,
    'fi',
  );

  if (tarballs.cli) {
    lines.push(
      `if [ ! -x "${layout.cliLauncher}" ]; then`,
      `  mkdir -p "$(dirname "${layout.cliServerDir}")"`,
      `  rm -rf "${layout.cliServerDir}.staging"`,
      `  mkdir -p "${layout.cliServerDir}.staging"`,
      `  tar -xzf "${tarballs.server}" -C "${layout.cliServerDir}.staging" --strip-components=1`,
      `  rm -rf "${layout.cliServerDir}"`,
      `  mv "${layout.cliServerDir}.staging" "${layout.cliServerDir}"`,
      `  gunzip -c "${tarballs.cli}" > "${layout.cliBinary}.staging"`,
      `  chmod +x "${layout.cliBinary}.staging"`,
      `  mv "${layout.cliBinary}.staging" "${layout.cliBinary}"`,
      'fi',
    );
  }

  lines.push(`rm -rf "${tmpDir}"`);
  return lines.join('\n');
}

/**
 * Push the tarball(s) to a temp dir on the host and extract them atomically
 * into the legacy and (when a CLI tarball is given) CLI layouts. Idempotent:
 * already-installed layouts are left untouched.
 */
export async function installRemoteServer(
  identity: ClientServerIdentity,
  tarballs: LocalTarballs,
  ssh: SshRun,
  scp: ScpPush,
): Promise<void> {
  const tmpDir = (await ssh(['mktemp', '-d'])).trim();
  const remote: RemoteTarballs = { server: `${tmpDir}/server.tar.gz` };
  await scp(tarballs.server, remote.server);
  if (tarballs.cli) {
    remote.cli = `${tmpDir}/cli.gz`;
    await scp(tarballs.cli, remote.cli);
  }
  await ssh(['bash', '-c', buildInstallScript(identity, remote, tmpDir)]);
}
