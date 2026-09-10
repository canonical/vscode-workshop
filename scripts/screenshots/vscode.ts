import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron';

import {
  EXTENSIONS_DIR,
  REMOTE_SSH_VERSION,
  ROOT,
  SCRIPT_DIR,
  USER_DATA_DIR,
  VSCODE_CACHE_DIR,
  VSCODE_VERSION,
  VSIX_PATH,
  WINDOW,
  WORK_DIR,
} from './config.ts';

export interface LaunchOptions {
  exe: string;
  folder: string;
  env?: Record<string, string>;
  scale: number;
  xvfb: boolean;
  log: (line: string) => void;
}

export interface Session {
  app: ElectronApplication;
  page: Page;
}

/** Download (once) and return the pinned VS Code executable. */
export async function ensureVSCode(log: (line: string) => void): Promise<string> {
  log(`Ensuring VS Code ${VSCODE_VERSION} in ${VSCODE_CACHE_DIR}`);
  return downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath: VSCODE_CACHE_DIR });
}

/** Package the extension from the working tree into `.work/workshop.vsix`. */
export function packageExtension(log: (line: string) => void): void {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  log(`Packaging extension to ${VSIX_PATH}`);
  execFileSync('npx', ['@vscode/vsce', 'package', '-o', VSIX_PATH], { cwd: ROOT, stdio: 'inherit' });
}

/** Install Remote - SSH (pinned) and the freshly packaged extension into the isolated extensions dir. */
export function installExtensions(exe: string, log: (line: string) => void): void {
  const cli = resolveCliPathFromVSCodeExecutablePath(exe);
  fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });
  log(`Installing extensions into ${EXTENSIONS_DIR}`);
  execFileSync(cli, [
    '--user-data-dir', USER_DATA_DIR,
    '--extensions-dir', EXTENSIONS_DIR,
    '--install-extension', `ms-vscode-remote.remote-ssh@${REMOTE_SSH_VERSION}`,
    '--install-extension', VSIX_PATH,
    '--force',
  ], { stdio: 'inherit' });
}

/** Start from a clean user-data dir seeded with the committed settings. */
export function seedUserData(): void {
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  const userDir = path.join(USER_DATA_DIR, 'User');
  fs.mkdirSync(userDir, { recursive: true });
  fs.copyFileSync(path.join(SCRIPT_DIR, 'settings.json'), path.join(userDir, 'settings.json'));
}

/**
 * A Unix socket file nobody listens on. Pointing `WORKSHOP_SOCKET` at it makes
 * the extension fail with ECONNREFUSED, which is how it shows the
 * "not installed or running" welcome view. (A non-existent path would simply be
 * skipped in favour of the real snap socket.)
 */
export function staleSocketPath(): string {
  const socket = path.join(WORK_DIR, 'stale', 'workshop.socket');
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  fs.rmSync(socket, { force: true });
  // Bind, then exit without closing so the file stays behind.
  execFileSync(process.execPath, [
    '-e',
    "require('net').createServer().listen(process.argv[1], () => process.exit(0))",
    socket,
  ]);
  if (!fs.existsSync(socket)) {
    throw new Error(`Failed to create a stale socket at ${socket}`);
  }
  return socket;
}

export const BASE_ARGS = [
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-workspace-trust',
  '--disable-telemetry',
  '--disable-updates',
  '--disable-experiments',
  '--no-cached-data',
  '--use-inmemory-secretstorage',
  '--no-sandbox',
  '--ozone-platform=x11',
  '--locale=en',
];

/** Launch VS Code on `folder` and size the window deterministically. */
export async function launch(options: LaunchOptions): Promise<Session> {
  const args = [
    `--user-data-dir=${USER_DATA_DIR}`,
    `--extensions-dir=${EXTENSIONS_DIR}`,
    ...BASE_ARGS,
    `--force-device-scale-factor=${options.scale}`,
    ...(options.xvfb ? ['--disable-gpu'] : []),
    options.folder,
  ];
  options.log(`Launching ${options.exe} ${args.join(' ')}`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  Object.assign(env, options.env ?? {});
  const app = await electron.launch({ executablePath: options.exe, args, env, timeout: 120_000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.monaco-workbench', { timeout: 120_000 });
  await setWindowSize(app, page);
  return { app, page };
}

export async function setWindowSize(app: ElectronApplication, page: Page): Promise<void> {
  const browserWindow = await app.browserWindow(page);
  await browserWindow.evaluate((w, size: { width: number; height: number }) => {
    w.unmaximize();
    w.setPosition(0, 0);
    w.setContentSize(size.width, size.height);
  }, WINDOW);
  await page.waitForFunction(
    (size: { width: number; height: number }) => window.innerWidth === size.width && window.innerHeight === size.height,
    WINDOW,
    { timeout: 10_000 },
  );
}

export async function close(session: Session | undefined): Promise<void> {
  if (!session) {
    return;
  }
  try {
    await session.app.close();
  } catch {
    // The window may already be gone.
  }
}
