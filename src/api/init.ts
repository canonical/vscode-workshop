/**
 * Create workshop definitions with the `workshop init` CLI.
 *
 * workshopd offers no endpoint for creating definitions, so the wizard shells
 * out to the CLI, which also owns the validation and error wording.
 *
 * This module must stay free of VS Code APIs (see eslint.config.mjs).
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface InitSdk {
  name: string;
  /** `track/risk`; omitted to let the store resolve the default channel. */
  channel?: string;
}

export interface InitSpec {
  /** Project folder; the definition lands in `<folder>/.workshop/<name>.yaml`. */
  folder: string;
  name: string;
  base: string;
  sdks: InitSdk[];
}

export interface InitRunnerOptions {
  /** The `workshop` executable; defaults to `workshop` resolved via PATH. */
  executable?: string;
  timeoutMs?: number;
}

export const DEFAULT_WORKSHOP_EXECUTABLE = 'workshop';
const DEFAULT_TIMEOUT_MS = 30_000;

export const WORKSHOP_NOT_FOUND_REASON =
  'workshop command not found (is the Workshop snap installed?)';

/** Path of the definition `workshop init` creates for `name` in `folder`. */
export function definitionPath(folder: string, name: string): string {
  return path.join(folder, '.workshop', `${name}.yaml`);
}

/** Arguments for `workshop init` matching `spec`. */
export function buildInitArgs(spec: InitSpec): string[] {
  const args = ['init', spec.name];
  if (spec.sdks.length > 0) {
    const sdks = spec.sdks.map((sdk) => (sdk.channel ? `${sdk.name}/${sdk.channel}` : sdk.name));
    args.push('--sdks', sdks.join(','));
  }
  args.push('--base', spec.base, '-p', spec.folder);
  return args;
}

/** `workshop init` failed; `reason` carries Workshop's own wording. */
export class InitError extends Error {
  constructor(
    readonly reason: string,
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(reason);
    this.name = 'InitError';
  }
}

/**
 * Extract Workshop's reason from the CLI's stderr: the `error: …` line without
 * its prefix, else the last non-empty line, else a generic message.
 */
export function parseInitFailure(stderr: string, exitCode: number | undefined): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errorLine = lines.find((line) => line.startsWith('error:'));
  if (errorLine) {
    return errorLine.replace(/^error:\s*/, '');
  }
  if (lines.length > 0) {
    return lines[lines.length - 1];
  }
  return exitCode === undefined
    ? 'workshop init did not complete'
    : `workshop init exited with code ${exitCode}`;
}

/** Run `workshop init`; rejects with {@link InitError} on any failure. */
export function runWorkshopInit(
  spec: InitSpec,
  options: InitRunnerOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const executable = options.executable ?? DEFAULT_WORKSHOP_EXECUTABLE;
  const args = buildInitArgs(spec);
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { cwd: spec.folder, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr });
          return;
        }
        const spawnError = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        if (spawnError.code === 'ENOENT') {
          reject(new InitError(WORKSHOP_NOT_FOUND_REASON, undefined, stderr));
          return;
        }
        if (spawnError.killed) {
          reject(new InitError('workshop init timed out', undefined, stderr));
          return;
        }
        const exitCode = typeof spawnError.code === 'number' ? spawnError.code : undefined;
        reject(new InitError(parseInitFailure(stderr, exitCode), exitCode, stderr));
      },
    );
  });
}

/** Names of the workshops defined under `<folder>/.workshop/`. */
export async function listDefinitionNames(folder: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(path.join(folder, '.workshop'));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /\.ya?ml$/.test(entry))
    .map((entry) => entry.replace(/\.ya?ml$/, ''))
    .sort();
}

/** Whether `<folder>/.workshop/<name>.yaml` already exists. */
export async function definitionExists(folder: string, name: string): Promise<boolean> {
  try {
    await fs.promises.access(definitionPath(folder, name));
    return true;
  } catch {
    return false;
  }
}
