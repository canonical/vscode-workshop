import type { Page } from 'playwright-core';

export { openWorkshopsView } from './ui.ts';

import {
  BROKEN_SDK,
  EXPECTED_HOSTNAME,
  EXTRA_SDK,
  LAUNCH_TIMEOUT_MS,
  REFRESH_TIMEOUT_MS,
  SAMPLE_DIR,
  UI_TIMEOUT_MS,
  WORKSHOP_NAME,
} from './config.ts';
import {
  clearNotifications,
  clickToastButton,
  focusEditor,
  inlineAction,
  openTerminal,
  openWorkshopsView,
  poll,
  ProgressGoneError,
  rowDescription,
  runCommand,
  shot,
  sleep,
  toast,
  typeTerminal,
  viewRow,
  waitProgressToast,
  waitRemote,
  waitTerminalText,
  waitToast,
  welcomeContent,
  workshopRow,
  REMOTE_INDICATOR,
} from './ui.ts';
import { close, launch, staleSocketPath, type Session } from './vscode.ts';
import {
  addSdkLine,
  info,
  readDefinition,
  removeBrokenSdk,
  removeSdkLine,
  waitForStatus,
  writeBrokenSdk,
  writeDefinition,
} from './workshop.ts';

export interface Context {
  exe: string;
  scale: number;
  xvfb: boolean;
  log: (line: string) => void;
  session?: Session;
}

export interface Step {
  id: string;
  produces: string[];
  run(ctx: Context): Promise<void>;
}

function page(ctx: Context): Page {
  if (!ctx.session) {
    throw new Error('No VS Code session is open');
  }
  return ctx.session.page;
}

/** Dismiss the activation prompt if it shows up (it re-fires on every local reload). */
export async function dismissOpenPrompt(p: Page): Promise<void> {
  const prompt = toast(p, /Reopen this window in (a|the) workshop\?/);
  try {
    await prompt.waitFor({ timeout: 8_000 });
    await clickToastButton(prompt, 'Not now');
  } catch {
    // No prompt this time.
  }
}

async function connectedAndSettled(ctx: Context, host: string, timeoutMs: number): Promise<void> {
  const p = page(ctx);
  await waitRemote(p, host, timeoutMs, ctx.log);
  // Remote-SSH shows its own toasts while the server starts; wait them out.
  await poll('Remote-SSH setup toasts to disappear', async () => {
    const busy = toast(p, /Setting up SSH Host|Downloading VS Code Server|Installing VS Code Server/);
    return (await busy.count()) === 0 ? true : undefined;
  }, 5 * 60_000, 1_000);
  await sleep(2_000);
  await clearNotifications(p);
}

/**
 * Capture the workshop's progress toast. When everything is cached the action
 * can finish before a toast shows a percentage; then the previous image is kept.
 */
async function captureProgress(ctx: Context, name: string, timeoutMs: number): Promise<void> {
  const p = page(ctx);
  try {
    const progress = await waitProgressToast(p, WORKSHOP_NAME, /\(\d+%\)/, 15_000, timeoutMs);
    await shot(p, name, { locator: progress }, ctx.log);
  } catch (err) {
    if (err instanceof ProgressGoneError) {
      ctx.log(`${err.message}; keeping the existing ${name}.png`);
      return;
    }
    throw err;
  }
}

/** Steps that expect the window to be connected to the workshop when they start. */
export const REMOTE_STEPS = new Set(['connected', 'terminal', 'definition-changed', 'reopen-locally']);

/** For resumed runs: reopen the (already launched) workshop and wait for the connection. */
export async function ensureRemote(ctx: Context): Promise<void> {
  const p = page(ctx);
  await openWorkshopsView(p);
  const row = workshopRow(p, WORKSHOP_NAME);
  const action = await inlineAction(row, 'Reopen in Workshop');
  await action.click();
  await connectedAndSettled(ctx, EXPECTED_HOSTNAME, LAUNCH_TIMEOUT_MS);
}

export const steps: Step[] = [
  {
    id: 'not-installed',
    produces: ['workshops-view-not-installed'],
    async run(ctx) {
      ctx.session = await launch({
        exe: ctx.exe,
        folder: SAMPLE_DIR,
        env: { WORKSHOP_SOCKET: staleSocketPath() },
        scale: ctx.scale,
        xvfb: ctx.xvfb,
        log: ctx.log,
      });
      const p = page(ctx);
      await openWorkshopsView(p);
      await welcomeContent(p).filter({ hasText: "doesn't appear to be installed" }).waitFor({ timeout: UI_TIMEOUT_MS });
      await sleep(500);
      await shot(p, 'workshops-view-not-installed', 'sidebar', ctx.log);
      await close(ctx.session);
      ctx.session = undefined;
    },
  },
  {
    id: 'empty',
    produces: ['workshops-view-empty'],
    async run(ctx) {
      ctx.session = await launch({ exe: ctx.exe, folder: SAMPLE_DIR, scale: ctx.scale, xvfb: ctx.xvfb, log: ctx.log });
      const p = page(ctx);
      await openWorkshopsView(p);
      await welcomeContent(p).filter({ hasText: 'No workshops found' }).waitFor({ timeout: UI_TIMEOUT_MS });
      await sleep(500);
      await shot(p, 'workshops-view-empty', 'sidebar', ctx.log);
    },
  },
  {
    id: 'wizard',
    produces: ['wizard-select-sdks', 'wizard-select-base', 'wizard-enter-name', 'created-prompt', 'created-workshop'],
    async run(ctx) {
      const p = page(ctx);
      await welcomeContent(p).locator('a', { hasText: 'Add New Workshop' }).click();

      const widget = p.locator('.quick-input-widget');
      await widget.locator('.quick-input-title', { hasText: 'Select SDKs' }).waitFor({ timeout: UI_TIMEOUT_MS });
      const goRow = widget.locator('.quick-input-list .monaco-list-row', {
        has: p.locator('.label-name', { hasText: /^go$/ }),
      }).first();
      await goRow.waitFor({ timeout: UI_TIMEOUT_MS });
      const checkbox = goRow.locator('.quick-input-list-checkbox').first();
      if (await checkbox.count()) {
        await checkbox.click();
      } else {
        await goRow.click();
      }
      await sleep(400);
      await shot(p, 'wizard-select-sdks', { locator: widget, pad: 16 }, ctx.log);
      await p.keyboard.press('Enter');

      await widget.locator('.quick-input-title', { hasText: 'Select a base' }).waitFor({ timeout: UI_TIMEOUT_MS });
      await sleep(400);
      await shot(p, 'wizard-select-base', { locator: widget, pad: 16 }, ctx.log);
      await p.keyboard.press('Enter');

      await widget.locator('.quick-input-title', { hasText: 'Enter a name' }).waitFor({ timeout: UI_TIMEOUT_MS });
      await sleep(400);
      await shot(p, 'wizard-enter-name', { locator: widget, pad: 16 }, ctx.log);
      await p.keyboard.press('Enter');

      const created = await waitToast(p, `Created "${WORKSHOP_NAME}"`, 60_000);
      // The definition opens in the editor at the same time.
      await p.locator('.tab', { hasText: `${WORKSHOP_NAME}.yaml` }).first().waitFor({ timeout: UI_TIMEOUT_MS });
      await sleep(800);
      await shot(p, 'created-prompt', { locator: created }, ctx.log);
      await shot(p, 'created-workshop', 'full', ctx.log);
      await clickToastButton(created, 'Not now');
    },
  },
  {
    id: 'off',
    produces: ['workshops-view-off'],
    async run(ctx) {
      const p = page(ctx);
      const row = workshopRow(p, WORKSHOP_NAME);
      await row.waitFor({ timeout: UI_TIMEOUT_MS });
      await rowDescription(row).filter({ hasText: 'Off' }).waitFor({ timeout: UI_TIMEOUT_MS });
      await inlineAction(row, 'Reopen in Workshop');
      await sleep(300);
      await shot(p, 'workshops-view-off', 'sidebar', ctx.log);
    },
  },
  {
    id: 'launch',
    produces: ['launch-progress'],
    async run(ctx) {
      const p = page(ctx);
      const row = workshopRow(p, WORKSHOP_NAME);
      const action = await inlineAction(row, 'Reopen in Workshop');
      await action.click();
      await captureProgress(ctx, 'launch-progress', LAUNCH_TIMEOUT_MS);
    },
  },
  {
    id: 'connected',
    produces: ['connected-window', 'workshops-view-expanded', 'statusbar-remote'],
    async run(ctx) {
      const p = page(ctx);
      await connectedAndSettled(ctx, EXPECTED_HOSTNAME, LAUNCH_TIMEOUT_MS);
      const details = info();
      if (details.hostname !== EXPECTED_HOSTNAME) {
        throw new Error(`Unexpected hostname ${details.hostname}; expected ${EXPECTED_HOSTNAME}`);
      }
      // Show the Go file in the editor and the expanded workshop in the side bar,
      // with no panel: window state persists across launches within a run.
      if (await p.locator('.part.panel').isVisible()) {
        await runCommand(p, 'View: Close Panel');
      }
      await runCommand(p, 'View: Show Explorer');
      await p.locator('.explorer-folders-view .monaco-list-row', { hasText: 'hello.go' }).first().click();
      await p.locator('.tab', { hasText: 'hello.go' }).first().waitFor({ timeout: UI_TIMEOUT_MS });
      await openWorkshopsView(p);
      const row = workshopRow(p, WORKSHOP_NAME);
      await rowDescription(row).filter({ hasText: 'On' }).waitFor({ timeout: UI_TIMEOUT_MS });
      if ((await row.getAttribute('aria-expanded')) !== 'true') {
        await row.locator('.monaco-tl-twistie').first().click();
      }
      await viewRow(p, 'Hostname').waitFor({ timeout: 60_000 });
      await viewRow(p, 'SDKs').waitFor({ timeout: UI_TIMEOUT_MS });
      await focusEditor(p);
      await sleep(800);
      await shot(p, 'connected-window', 'full', ctx.log);
      await shot(p, 'workshops-view-expanded', 'sidebar', ctx.log);
      await shot(p, 'statusbar-remote', 'statusbar-left', ctx.log);
    },
  },
  {
    id: 'terminal',
    produces: ['terminal-go-version', 'terminal-window', 'port-forwarded'],
    async run(ctx) {
      const p = page(ctx);
      await openTerminal(p);
      await typeTerminal(p, 'hostname');
      await typeTerminal(p, 'go version');
      await waitTerminalText(p, /go version go/);
      await sleep(500);
      await shot(p, 'terminal-go-version', 'panel', ctx.log);
      await shot(p, 'terminal-window', 'full', ctx.log);
      await typeTerminal(p, 'go run hello.go', false);
      await waitTerminalText(p, 'Listening on', 120_000);
      try {
        const forwarded = await waitToast(p, /port 8080/, 30_000);
        await shot(p, 'port-forwarded', { locator: forwarded }, ctx.log);
      } catch (err) {
        ctx.log(`No port-forward toast captured: ${err instanceof Error ? err.message : String(err)}`);
      }
      await p.keyboard.press('Control+c');
      await sleep(500);
    },
  },
  {
    id: 'definition-changed',
    produces: ['definition-changed-prompt', 'refresh-progress'],
    async run(ctx) {
      const p = page(ctx);
      await clearNotifications(p);
      addSdkLine(EXTRA_SDK, ctx.log);
      const prompt = await waitToast(p, `"${WORKSHOP_NAME}" definition changed`, 60_000);
      await sleep(500);
      await shot(p, 'definition-changed-prompt', { locator: prompt }, ctx.log);
      await clickToastButton(prompt, 'Refresh and Reopen');
      // The window returns to the local folder first, then refreshes there.
      await waitRemote(p, null, UI_TIMEOUT_MS * 4, ctx.log);
      await captureProgress(ctx, 'refresh-progress', REFRESH_TIMEOUT_MS);
      await connectedAndSettled(ctx, EXPECTED_HOSTNAME, REFRESH_TIMEOUT_MS);
    },
  },
  {
    id: 'reopen-locally',
    produces: ['reopen-locally-menu'],
    async run(ctx) {
      const p = page(ctx);
      await p.locator(REMOTE_INDICATOR).click();
      const widget = p.locator('.quick-input-widget');
      await widget.waitFor({ timeout: UI_TIMEOUT_MS });
      const target = widget.locator('.quick-input-list .monaco-list-row', { hasText: 'Reopen Locally' }).first();
      await target.waitFor({ timeout: UI_TIMEOUT_MS });
      await target.hover();
      for (let i = 0; i < 20; i++) {
        const focused = widget.locator('.quick-input-list .monaco-list-row.focused').first();
        if ((await focused.count()) && /Reopen Locally/.test(await focused.innerText())) {
          break;
        }
        await p.keyboard.press('ArrowDown');
        await sleep(100);
      }
      await sleep(300);
      await shot(p, 'reopen-locally-menu', { locator: widget, pad: 16 }, ctx.log);
      await p.keyboard.press('Enter');
      await waitRemote(p, null, UI_TIMEOUT_MS * 4, ctx.log);
      await dismissOpenPrompt(p);
    },
  },
  {
    id: 'refresh-error',
    produces: ['refresh-error'],
    async run(ctx) {
      const p = page(ctx);
      await clearNotifications(p);
      writeDefinition(readDefinition().replace(/name: go(?=\s|$)/m, 'name: goo'), ctx.log);
      await triggerRefresh(ctx, false);
      await p.locator('.tab', { hasText: `${WORKSHOP_NAME} (error)` }).first().waitFor({ timeout: REFRESH_TIMEOUT_MS });
      await poll('two editor groups', async () => {
        return (await p.locator('.editor-group-container').count()) >= 2 ? true : undefined;
      }, UI_TIMEOUT_MS);
      await p.mouse.move(800, 500);
      await sleep(1_500);
      await shot(p, 'refresh-error', 'full', ctx.log);
      await runCommand(p, 'View: Close All Editors');
      writeDefinition(readDefinition().replace(/name: goo(?=\s|$)/m, 'name: go'), ctx.log);
      await dismissDefinitionPrompt(p);
    },
  },
  {
    id: 'refresh-paused',
    produces: ['refresh-paused'],
    async run(ctx) {
      const p = page(ctx);
      await clearNotifications(p);
      // Let the poller catch up with the daemon after the previous, rejected refresh.
      await openWorkshopsView(p);
      await rowDescription(workshopRow(p, WORKSHOP_NAME)).filter({ hasText: 'On' }).waitFor({ timeout: 60_000 });
      await sleep(6_000);
      writeBrokenSdk(ctx.log);
      addSdkLine(`project-${BROKEN_SDK}`, ctx.log);
      await triggerRefresh(ctx, false);
      const paused = await waitToast(p, /refresh is paused due to a failure/, REFRESH_TIMEOUT_MS);
      await p.locator('.tab', { hasText: `${WORKSHOP_NAME} (error)` }).first().waitFor({ timeout: UI_TIMEOUT_MS });
      // Park the pointer away from the toast so no button tooltip shows.
      await p.mouse.move(800, 500);
      await sleep(1_500);
      await shot(p, 'refresh-paused', 'full', ctx.log);
      await clickToastButton(paused, 'Abort');
      await waitForStatus('Ready', REFRESH_TIMEOUT_MS, ctx.log);
      await runCommand(p, 'View: Close All Editors');
      removeBrokenSdk();
      removeSdkLine(`project-${BROKEN_SDK}`, ctx.log);
      await dismissDefinitionPrompt(p);
    },
  },
  {
    id: 'turn-off',
    produces: ['turn-off-dialog'],
    async run(ctx) {
      const p = page(ctx);
      await clearNotifications(p);
      await openWorkshopsView(p);
      const row = workshopRow(p, WORKSHOP_NAME);
      await rowDescription(row).filter({ hasText: 'On' }).waitFor({ timeout: UI_TIMEOUT_MS });
      await row.click({ button: 'right' });
      const menu = p.locator('.context-view .monaco-menu');
      await menu.waitFor({ timeout: UI_TIMEOUT_MS });
      // Context menus react to keyboard navigation more reliably than to synthetic clicks.
      for (let i = 0; i < 10; i++) {
        const focused = menu.locator('.action-item.focused .action-label').first();
        if ((await focused.count()) && /Turn Off/.test(await focused.innerText())) {
          break;
        }
        await p.keyboard.press('ArrowDown');
        await sleep(100);
      }
      await p.keyboard.press('Enter');
      const dialog = p.locator('.monaco-dialog-box');
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      await sleep(400);
      await shot(p, 'turn-off-dialog', { locator: dialog, pad: 24 }, ctx.log);
      await dialog.locator('.monaco-button', { hasText: /^Turn Off$/ }).first().click();
      // The definition stays, so the workshop is listed as Off rather than disappearing.
      await waitForStatus('Off', REFRESH_TIMEOUT_MS, ctx.log);
    },
  },
];

/**
 * Start "Refresh and Reopen" for the workshop: accept the definition-change
 * prompt when it shows up, otherwise use the row's inline action. The prompt
 * only appears when the extension's cached status allows a refresh, which can
 * lag a few seconds behind the daemon after a failed refresh.
 */
async function triggerRefresh(ctx: Context, expectPrompt: boolean): Promise<void> {
  const p = page(ctx);
  const prompt = toast(p, `"${WORKSHOP_NAME}" definition changed`);
  try {
    await prompt.waitFor({ timeout: expectPrompt ? 60_000 : 15_000 });
    await clickToastButton(prompt, 'Refresh and Reopen');
  } catch (err) {
    if (expectPrompt) {
      throw err;
    }
    ctx.log('No definition-change prompt; using the inline Refresh and Reopen action instead');
    await openWorkshopsView(p);
    const row = workshopRow(p, WORKSHOP_NAME);
    await rowDescription(row).filter({ hasText: 'On' }).waitFor({ timeout: 60_000 });
    const action = await inlineAction(row, 'Refresh and Reopen');
    await action.click();
  }
}

/** After restoring the definition, the local watcher prompts again; dismiss it. */
async function dismissDefinitionPrompt(p: Page): Promise<void> {
  const prompt = toast(p, /definition changed/);
  try {
    await prompt.waitFor({ timeout: 5_000 });
    await prompt.locator('.codicon-notifications-clear, .codicon-close').first().click();
  } catch {
    // Nothing to dismiss.
  }
}
