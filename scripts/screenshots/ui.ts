import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Locator, Page } from 'playwright-core';

import { OUT_DIR, UI_TIMEOUT_MS, WINDOW } from './config.ts';

export type Log = (line: string) => void;

/** CSS for the Workshop view container; the dot in the id must be escaped. */
export const WORKSHOP_VIEW = '#workbench\\.view\\.extension\\.workshop';
export const REMOTE_INDICATOR = '#status\\.host';

// ---------------------------------------------------------------------------
// Basic waits
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Escape `text` so it matches literally inside a `RegExp`. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function poll<T>(
  description: string,
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < until) {
    try {
      const value = await fn();
      if (value !== undefined) {
        return value;
      }
    } catch (err) {
      if (err instanceof ProgressGoneError) {
        throw err;
      }
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

// ---------------------------------------------------------------------------
// Workbench pieces
// ---------------------------------------------------------------------------

/** Run a command through the palette by its full title, e.g. "Notifications: Clear All Notifications". */
export async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ timeout: UI_TIMEOUT_MS });
  await input.fill(`>${title}`);
  // Match the label exactly: "Terminal: Create New Terminal" must not pick
  // "Terminal: Create New Terminal (Local)" just because it sorts first.
  const row = page.locator('.quick-input-list .monaco-list-row', {
    has: page.locator('.label-name', { hasText: new RegExp(`^${escapeRegExp(title)}$`) }),
  }).first();
  await row.waitFor({ timeout: UI_TIMEOUT_MS });
  await row.click();
  await page.locator('.quick-input-widget').waitFor({ state: 'hidden', timeout: UI_TIMEOUT_MS });
}

/** Open the Workshop side bar, via the activity bar icon with a palette fallback. */
export async function openWorkshopsView(page: Page): Promise<Locator> {
  // The container only exists once the extension has activated (onStartupFinished).
  const icon = page.locator('.part.activitybar .action-item .action-label[aria-label="Workshop"]').first();
  const view = page.locator(WORKSHOP_VIEW);
  if (await view.isVisible()) {
    // Clicking the active icon would toggle the side bar closed.
    return view;
  }
  try {
    await icon.waitFor({ timeout: UI_TIMEOUT_MS });
    await icon.click();
  } catch {
    await runCommand(page, 'Workshop: Focus on Workshops View');
  }
  await view.waitFor({ timeout: UI_TIMEOUT_MS });
  return view;
}

export function welcomeContent(page: Page): Locator {
  return page.locator(`${WORKSHOP_VIEW} .welcome-view-content`);
}

/** A workshop row in the tree, matched on its label. */
export function workshopRow(page: Page, name: string): Locator {
  return page.locator(`${WORKSHOP_VIEW} .monaco-list-row`, {
    has: page.locator('.label-name', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
  }).first();
}

export function rowDescription(row: Locator): Locator {
  return row.locator('.label-description').first();
}

/** Hover a row and return one of its inline action buttons by title. */
export async function inlineAction(row: Locator, title: string): Promise<Locator> {
  await row.hover();
  const action = row.locator(`.actions .action-label[aria-label^="${title}"]`).first();
  await action.waitFor({ timeout: UI_TIMEOUT_MS });
  return action;
}

/** Any tree row in the Workshop view containing `text` (used for detail rows). */
export function viewRow(page: Page, text: string): Locator {
  return page.locator(`${WORKSHOP_VIEW} .monaco-list-row`, { hasText: text }).first();
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function toasts(page: Page): Locator {
  return page.locator('.notifications-toasts .notification-toast');
}

export function toast(page: Page, text: string | RegExp): Locator {
  return toasts(page).filter({ hasText: text }).first();
}

export async function waitToast(page: Page, text: string | RegExp, timeoutMs = UI_TIMEOUT_MS): Promise<Locator> {
  const found = toast(page, text);
  await found.waitFor({ timeout: timeoutMs });
  return found;
}

export async function clickToastButton(t: Locator, label: string): Promise<void> {
  const button = t.locator('.notification-list-item-buttons-container .monaco-button', { hasText: label }).first();
  await button.waitFor({ timeout: UI_TIMEOUT_MS });
  await button.click();
}

export async function clearNotifications(page: Page): Promise<void> {
  await runCommand(page, 'Notifications: Clear All Notifications');
  await sleep(300);
}

/** Move keyboard focus into the editor so lists lose their focus ring. */
export async function focusEditor(page: Page): Promise<void> {
  await page.keyboard.press('Control+1');
  // Park the cursor on the trailing empty line so no word gets highlighted.
  await page.keyboard.press('Control+End');
  await page.mouse.move(WINDOW.width / 2, WINDOW.height / 2);
}

/** Thrown when the action completed before its progress toast could be captured. */
export class ProgressGoneError extends Error {}

/**
 * Wait until a progress toast titled `title` shows a message matching `match`,
 * or, after `settleMs`, any message other than the initial one. Returns the toast.
 */
export async function waitProgressToast(
  page: Page,
  title: string,
  match: RegExp,
  settleMs: number,
  timeoutMs: number,
  initial = /turning on…|refreshing…/,
): Promise<Locator> {
  const started = Date.now();
  return poll(`progress toast for ${title}`, async () => {
    // If the action already finished (the window is connecting), stop waiting.
    const indicator = await page.locator(REMOTE_INDICATOR).innerText({ timeout: 1_000 }).catch(() => '');
    if (/SSH:|Opening Remote/.test(indicator)) {
      throw new ProgressGoneError(`${title}: the action finished before a progress toast was captured`);
    }
    const candidates = toasts(page).filter({ hasText: title });
    const count = await candidates.count();
    for (let i = 0; i < count; i++) {
      const candidate = candidates.nth(i);
      const text = await candidate.innerText();
      if (match.test(text)) {
        return candidate;
      }
      if (Date.now() - started > settleMs && !initial.test(text) && text.trim().length > 0) {
        return candidate;
      }
    }
    return undefined;
  }, timeoutMs);
}

// ---------------------------------------------------------------------------
// Remote indicator
// ---------------------------------------------------------------------------

/**
 * Wait for the status bar's remote indicator to show `SSH: <host>`, or, with
 * `host === null`, to show no SSH session at all. Survives the window reload
 * that Remote-SSH triggers (execution context destroyed errors are swallowed).
 */
export async function waitRemote(page: Page, host: string | null, timeoutMs: number, log?: Log): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    try {
      const text = (await page.locator(REMOTE_INDICATOR).innerText({ timeout: 2_000 })).trim();
      if (text !== last) {
        log?.(`remote indicator: "${text}"`);
        last = text;
      }
      if (host ? text.includes(`SSH: ${host}`) : !text.includes('SSH:')) {
        // Give the workbench a moment to finish restoring views after the reload.
        await sleep(1_500);
        return;
      }
    } catch {
      // Navigation in progress.
    }
    await sleep(1_000);
  }
  throw new Error(`remote indicator never showed ${host ?? 'a local window'} (last: "${last}")`);
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export async function openTerminal(page: Page): Promise<Locator> {
  // Start from exactly one terminal so the tabs list stays hidden.
  if (await page.locator('.part.panel .terminal-wrapper').count()) {
    await runCommand(page, 'Terminal: Kill All Terminals');
    await sleep(500);
  }
  await runCommand(page, 'Terminal: Create New Terminal');
  const terminal = page.locator('.part.panel .terminal-wrapper.active .xterm').first();
  await terminal.waitFor({ timeout: UI_TIMEOUT_MS });
  // Wait for the shell prompt before typing anything (rows are padded, so no `$` anchor).
  await waitTerminalText(page, /\$\s/, 60_000);
  await terminal.click();
  return terminal;
}

function terminalRows(page: Page): Locator {
  return page.locator('.part.panel .terminal-wrapper.active .xterm-rows').first();
}

/** Number of shell prompts currently rendered in the active terminal. */
async function promptCount(page: Page): Promise<number> {
  const text = await terminalRows(page).innerText();
  return (text.match(/\$\s/g) ?? []).length;
}

/**
 * Type a command and wait for the shell to print a new prompt, so the next
 * keystrokes don't interleave with this command's output. Pass `waitForPrompt`
 * as false for commands that keep running (servers).
 */
export async function typeTerminal(page: Page, line: string, waitForPrompt = true): Promise<void> {
  const before = await promptCount(page);
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
  if (waitForPrompt) {
    await poll(`prompt after ${line}`, async () => ((await promptCount(page)) > before ? true : undefined), 120_000, 300);
    await sleep(200);
  }
}

export async function waitTerminalText(page: Page, text: string | RegExp, timeoutMs = UI_TIMEOUT_MS): Promise<void> {
  const rows = terminalRows(page);
  await poll(`terminal text ${String(text)}`, async () => {
    const content = await rows.innerText();
    const matched = typeof text === 'string' ? content.includes(text) : text.test(content);
    return matched ? true : undefined;
  }, timeoutMs, 500);
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

export type Region =
  | 'full'
  | 'sidebar'
  | 'panel'
  | 'statusbar-left'
  | { locator: Locator; pad?: number }
  | { clip: { x: number; y: number; width: number; height: number } };

interface Clip { x: number; y: number; width: number; height: number }

function clamp(clip: Clip): Clip {
  const x = Math.max(0, Math.floor(clip.x));
  const y = Math.max(0, Math.floor(clip.y));
  return {
    x,
    y,
    width: Math.min(WINDOW.width - x, Math.ceil(clip.width)),
    height: Math.min(WINDOW.height - y, Math.ceil(clip.height)),
  };
}

async function box(locator: Locator): Promise<Clip | null> {
  return locator.boundingBox();
}

export async function clipOf(page: Page, region: Region): Promise<Clip | undefined> {
  if (region === 'full') {
    return undefined;
  }
  if (region === 'sidebar') {
    const activity = await box(page.locator('.part.activitybar'));
    const sidebar = await box(page.locator('.part.sidebar'));
    if (activity && sidebar) {
      const x = Math.min(activity.x, sidebar.x);
      const right = Math.max(activity.x + activity.width, sidebar.x + sidebar.width);
      return clamp({ x, y: sidebar.y, width: right - x, height: Math.min(sidebar.height, 400) });
    }
    return clamp({ x: 0, y: 35, width: 360, height: 400 });
  }
  if (region === 'panel') {
    const panel = await box(page.locator('.part.panel'));
    return panel ? clamp(panel) : clamp({ x: 348, y: 560, width: 1252, height: 418 });
  }
  if (region === 'statusbar-left') {
    const bar = await box(page.locator('.part.statusbar'));
    return bar
      ? clamp({ x: bar.x, y: bar.y, width: 520, height: bar.height })
      : clamp({ x: 0, y: WINDOW.height - 22, width: 520, height: 22 });
  }
  if ('clip' in region) {
    return clamp(region.clip);
  }
  const target = await box(region.locator);
  if (!target) {
    throw new Error('Cannot compute a clip: the target element has no bounding box');
  }
  const pad = region.pad ?? 12;
  return clamp({ x: target.x - pad, y: target.y - pad, width: target.width + 2 * pad, height: target.height + 2 * pad });
}

export async function shot(page: Page, name: string, region: Region, log?: Log): Promise<string> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.png`);
  const clip = await clipOf(page, region);
  await page.screenshot({ path: file, clip, animations: 'disabled', caret: 'hide' });
  log?.(`Saved ${path.relative(process.cwd(), file)}${clip ? ` (${clip.width}x${clip.height})` : ''}`);
  return file;
}
