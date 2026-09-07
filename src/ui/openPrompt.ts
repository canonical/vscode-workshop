import * as path from 'path';
import * as vscode from 'vscode';
import { Workshop } from '../api/workshops';

/**
 * Show a Quick Pick to let the user choose one workshop from a list.
 *
 * Returns `undefined` if the user dismissed the picker.
 * Returns the single workshop directly (without showing a picker) when there
 * is only one candidate.
 */
export async function pickWorkshop(
  workshops: Workshop[],
  projectPath?: string,
): Promise<Workshop | undefined> {
  if (workshops.length === 0) {
    return undefined;
  }
  if (workshops.length === 1) {
    return workshops[0];
  }

  const items = workshops.map((w) => ({
    label: w.name,
    description: w.status,
    detail:
      w.definitionPath && projectPath
        ? path.relative(projectPath, w.definitionPath)
        : w.definitionPath,
    workshop: w,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a workshop to reopen in',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return picked?.workshop;
}

/**
 * Dependencies injected into {@link createOpenPrompt} so the function is
 * testable without a real VS Code window.
 */
export interface OpenPromptDeps {
  /** All workshops discovered for the project; may be empty. */
  workshops: Workshop[];
  /**
   * Local filesystem path of the project root. Used to display definition
   * paths as relative paths in the Quick Pick.
   */
  projectPath?: string;
  /**
   * Notification message shown to the user. Defaults to the generic
   * "definition(s) detected" prompt used on activation.
   */
  message?: string;
  /**
   * Called with the chosen workshop when the user confirms.
   * Should invoke the `workshop.reopenInWorkshop` command or equivalent.
   */
  reopen: (workshop: Workshop) => Promise<void>;
  /**
   * Override for `pickWorkshop` — injected in tests to avoid VS Code UI.
   */
  pick?: (workshops: Workshop[]) => Promise<Workshop | undefined>;
  /**
   * Override for `vscode.window.showInformationMessage` — injected in tests.
   */
  showMessage?: (
    message: string,
    ...items: string[]
  ) => Promise<string | undefined>;
}

/**
 * Show a one-shot per-session prompt when workshop definitions are detected in
 * the current project.
 *
 * Designed to be called once on extension activation (local window only).
 * The caller is responsible for skipping this in ssh-remote windows.
 *
 * @returns `true` if the prompt was shown (regardless of the user's choice),
 *          `false` if there were no candidate workshops.
 */
export async function createOpenPrompt(deps: OpenPromptDeps): Promise<boolean> {
  const workshops = deps.workshops.filter((w) => w.definitionPath !== undefined);
  if (workshops.length === 0) {
    return false;
  }

  const showMessage =
    deps.showMessage ??
    ((msg: string, ...items: string[]) =>
      vscode.window.showInformationMessage(msg, ...items));

  const pick = deps.pick ?? ((ws: Workshop[]) => pickWorkshop(ws, deps.projectPath));

  const BUTTON = 'Reopen in Workshop';
  const answer = await showMessage(
    deps.message ?? 'Workshop definition(s) detected. Reopen this window in a workshop?',
    BUTTON,
    'Not now',
  );

  if (answer !== BUTTON) {
    return true; // shown, user dismissed
  }

  const chosen = await pick(workshops);
  if (!chosen) {
    return true; // user dismissed the quick pick
  }

  await deps.reopen(chosen);
  return true;
}
