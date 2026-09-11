/**
 * Regenerate the extension's screenshots.
 *
 *   npm run screenshots              # everything, on the current X display
 *   npm run screenshots:xvfb         # same, on a virtual display
 *   npm run screenshots -- --only=wizard,off --keep
 *
 * Runs on the host (not inside the `ext` workshop): it needs the real
 * `workshop` daemon, LXD, and network access to the SDK store. See README.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { OUT_DIR, SAMPLE_DIR, VSIX_PATH } from './config.ts';
import { steps, type Context } from './steps.ts';
import { close, ensureVSCode, installExtensions, packageExtension, seedUserData } from './vscode.ts';
import { createSample, teardown } from './workshop.ts';

interface Args {
  only: Set<string> | undefined;
  keep: boolean;
  clean: boolean;
  scale: number;
  xvfb: boolean;
  skipInstall: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    only: undefined,
    keep: false,
    clean: false,
    scale: 1,
    xvfb: process.env.XVFB === '1',
    skipInstall: false,
    list: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--only=')) {
      args.only = new Set(arg.slice('--only='.length).split(',').filter(Boolean));
    } else if (arg === '--keep') {
      args.keep = true;
    } else if (arg === '--clean') {
      args.clean = true;
    } else if (arg.startsWith('--scale=')) {
      const raw = arg.slice('--scale='.length);
      const scale = Number(raw);
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error(`--scale must be a positive number, got "${raw}"`);
      }
      args.scale = scale;
    } else if (arg === '--xvfb') {
      args.xvfb = true;
    } else if (arg === '--skip-install') {
      args.skipInstall = true;
    } else if (arg === '--list') {
      args.list = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string): void => {
    console.log(`[${timestamp()}] ${line}`);
  };

  if (args.list) {
    for (const step of steps) {
      console.log(`${step.id.padEnd(20)} ${step.produces.join(', ')}`);
    }
    return;
  }

  const selected = args.only ? steps.filter((step) => args.only!.has(step.id)) : steps;
  if (args.only) {
    const unknown = [...args.only].filter((id) => !steps.some((step) => step.id === id));
    if (unknown.length > 0) {
      throw new Error(`Unknown step(s): ${unknown.join(', ')}`);
    }
  }
  const fromStart = !args.only || selected[0]?.id === steps[0].id || selected[0]?.id === 'empty';

  const exe = await ensureVSCode(log);
  if (!args.skipInstall || !fs.existsSync(VSIX_PATH)) {
    packageExtension(log);
    installExtensions(exe, log);
  }
  if (fromStart) {
    teardown(log, true);
    createSample(log);
    seedUserData();
  } else {
    log(`Reusing ${SAMPLE_DIR} and the current workshop state for --only=${[...args.only ?? []].join(',')}`);
    if (!fs.existsSync(SAMPLE_DIR)) {
      throw new Error(`${SAMPLE_DIR} does not exist; run without --only first`);
    }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const ctx: Context = { exe, scale: args.scale, xvfb: args.xvfb, log };
  let failed: Error | undefined;
  try {
    if (!fromStart) {
      const { launch } = await import('./vscode.ts');
      const { dismissOpenPrompt, ensureRemote, openWorkshopsView, REMOTE_STEPS } = await import('./steps.ts');
      ctx.session = await launch({ exe, folder: SAMPLE_DIR, scale: args.scale, xvfb: args.xvfb, log });
      await dismissOpenPrompt(ctx.session.page);
      await openWorkshopsView(ctx.session.page);
      if (selected[0] && REMOTE_STEPS.has(selected[0].id)) {
        await ensureRemote(ctx);
      }
    }
    for (const step of selected) {
      log(`==> ${step.id}`);
      await step.run(ctx);
    }
  } catch (err) {
    failed = err instanceof Error ? err : new Error(String(err));
    log(`FAILED: ${failed.message}`);
    if (ctx.session) {
      const file = path.join(OUT_DIR, '_failure.png');
      await ctx.session.page.screenshot({ path: file }).catch(() => undefined);
      log(`Saved ${file} for diagnosis`);
    }
  } finally {
    await close(ctx.session);
    if (!args.keep) {
      teardown(log, args.clean);
    } else {
      log(`Keeping the workshop and ${SAMPLE_DIR} (--keep)`);
    }
  }
  if (failed) {
    process.exitCode = 1;
  } else {
    log(`Done. Screenshots are in ${OUT_DIR}`);
  }
}

await main();
