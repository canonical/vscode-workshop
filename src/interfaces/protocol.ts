import { isSlotRef } from '../api/connections';
import { PanelData } from './data';
import { MountMenuItem } from './model';

/**
 * The message protocol between the extension host and the mounts webview.
 * Both sides are bundled from this repo and share these types (the webview
 * bundle is built from `src/webview/mountsPanel.ts`), but the webview is
 * still untrusted input to the extension: everything arriving from it goes
 * through {@link isWebviewToExt} and is re-validated against current state.
 */

export type ExtToWebview =
  | { type: 'state'; state: PanelData }
  /** Settles a whole toggle burst for one row (ok:false → snap back). */
  | { type: 'actionResult'; rowId: string; ok: boolean };

/** A menu choice: remount, or connect the row's plug to a specific slot. */
export type MenuAction = MountMenuItem;

export type WebviewToExt =
  | { type: 'ready' }
  /**
   * Carries the *desired* switch position, not a flip command, so repeated
   * messages are idempotent and coalescible (last write wins).
   */
  | { type: 'toggle'; rowId: string; desired: boolean }
  | { type: 'menu'; rowId: string; action: MenuAction }
  | { type: 'reveal'; path: string };

/** Validate a message received from the webview. */
export function isWebviewToExt(message: unknown): message is WebviewToExt {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const msg = message as Record<string, unknown>;
  switch (msg.type) {
    case 'ready':
      return true;
    case 'toggle':
      return typeof msg.rowId === 'string' && typeof msg.desired === 'boolean';
    case 'menu':
      return typeof msg.rowId === 'string' && isMenuAction(msg.action);
    case 'reveal':
      return typeof msg.path === 'string';
    default:
      return false;
  }
}

function isMenuAction(value: unknown): value is MenuAction {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const action = value as Record<string, unknown>;
  if (action.kind === 'remount') {
    return true;
  }
  return action.kind === 'connect' && isSlotRef(action.slot);
}
