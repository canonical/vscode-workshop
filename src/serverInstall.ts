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
