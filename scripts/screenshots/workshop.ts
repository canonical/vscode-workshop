import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BROKEN_SDK, GO_MOD, HELLO_GO, SAMPLE_DIR, WORKSHOP_NAME } from './config.ts';
import { escapeRegExp } from './ui.ts';

export type Log = (line: string) => void;

/** Run `workshop -p <sample> …` and return stdout; throws on non-zero exit unless `allowFail`. */
export function ws(args: string[], options: { allowFail?: boolean; log?: Log } = {}): string {
  options.log?.(`$ workshop -p ${SAMPLE_DIR} ${args.join(' ')}`);
  try {
    return execFileSync('workshop', ['-p', SAMPLE_DIR, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (options.allowFail) {
      return '';
    }
    throw err;
  }
}

/** Status column of `workshop list` for the sample workshop, or undefined when absent. */
export function status(): string | undefined {
  const out = ws(['list'], { allowFail: true });
  for (const line of out.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === WORKSHOP_NAME) {
      return cols[1];
    }
  }
  return undefined;
}

/** `workshop info <name>` as a flat key/value map of the top-level scalars. */
export function info(): Record<string, string> {
  const out = ws(['info', WORKSHOP_NAME]);
  const result: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const match = /^([a-z-]+):\s+(.*)$/.exec(line);
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }
  return result;
}

export async function waitForStatus(
  wanted: string,
  timeoutMs: number,
  log?: Log,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < until) {
    const current = status();
    if (current !== last) {
      log?.(`workshop list: ${WORKSHOP_NAME} ${current ?? '(absent)'}`);
      last = current;
    }
    if (current === wanted) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`workshop ${WORKSHOP_NAME} never reached status ${wanted} (last: ${last ?? 'absent'})`);
}

/** Remove any leftover workshop and sample directory from a previous run. */
export function teardown(log: Log, removeSample: boolean): void {
  if (fs.existsSync(SAMPLE_DIR)) {
    ws(['refresh', '--abort', WORKSHOP_NAME], { allowFail: true, log });
    ws(['remove', WORKSHOP_NAME], { allowFail: true, log });
  }
  if (removeSample) {
    fs.rmSync(SAMPLE_DIR, { recursive: true, force: true });
  }
}

/** Fresh sample directory with the Go program the story runs, but no workshop yet. */
export function createSample(log: Log): void {
  fs.rmSync(SAMPLE_DIR, { recursive: true, force: true });
  fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  fs.writeFileSync(path.join(SAMPLE_DIR, 'hello.go'), HELLO_GO);
  fs.writeFileSync(path.join(SAMPLE_DIR, 'go.mod'), GO_MOD);
  log(`Created sample project at ${SAMPLE_DIR}`);
}

export function definitionPath(): string {
  return path.join(SAMPLE_DIR, '.workshop', `${WORKSHOP_NAME}.yaml`);
}

export function readDefinition(): string {
  return fs.readFileSync(definitionPath(), 'utf8');
}

export function writeDefinition(content: string, log?: Log): void {
  log?.(`Writing ${definitionPath()}:\n${content}`);
  fs.writeFileSync(definitionPath(), content);
}

/** Append an SDK entry to the definition's `sdks:` list (which `workshop init` always writes). */
export function addSdkLine(name: string, log?: Log): void {
  const current = readDefinition().replace(/\s+$/, '');
  if (new RegExp(`^  - name: ${escapeRegExp(name)}$`, 'm').test(current)) {
    return;
  }
  writeDefinition(`${current}\n  - name: ${name}\n`, log);
}

/** Drop an SDK entry added by {@link addSdkLine}. */
export function removeSdkLine(name: string, log?: Log): void {
  const current = readDefinition();
  const next = current.replace(new RegExp(`^  - name: ${escapeRegExp(name)}\n`, 'm'), '');
  if (next !== current) {
    writeDefinition(next, log);
  }
}

/** Write an in-project SDK whose setup-base hook fails, to force a paused refresh. */
export function writeBrokenSdk(log: Log): void {
  const dir = path.join(SAMPLE_DIR, '.workshop', BROKEN_SDK);
  const hooks = path.join(dir, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sdk.yaml'), [
    `name: ${BROKEN_SDK}`,
    'base: ubuntu@24.04',
    'summary: Simulates a failing SDK setup hook',
    'description: |',
    '  Used only to produce the paused-refresh screenshot.',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(hooks, 'setup-base'), [
    '#!/bin/sh',
    'echo "Installing build dependencies..."',
    'echo "E: Unable to locate package libfoo-dev" >&2',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  log(`Wrote failing in-project SDK at ${dir}`);
}

export function removeBrokenSdk(): void {
  fs.rmSync(path.join(SAMPLE_DIR, '.workshop', BROKEN_SDK), { recursive: true, force: true });
}
