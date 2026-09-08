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
