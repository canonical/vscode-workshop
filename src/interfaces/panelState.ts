import { Status } from '../api/workshops';
import { MountSection } from './model';

/**
 * Panel-level state derivation: which single message the Mounts tab shows,
 * or the table. Every user-visible string lives here verbatim (the handoff
 * treats them as normative). No vscode imports.
 */

export const MSG_LOADING = 'Loading mounts…';
export const MSG_NO_MOUNTS = 'No mounts';
export const MSG_OFF = 'Workshop is Off. Launch this workshop to see existing mounts.';
export const MSG_NO_WORKSHOPS = 'No workshops in this project.';
export const MSG_NO_SELECTION = 'Select a workshop to see its mounts.';
export const MSG_DEVICES = 'Devices are coming soon.';

/** `<Kind> task in progress…` — kind is a daemon change kind (`launch`…). */
export function pendingMessage(kind: string): string {
  const title = kind.length > 0 ? kind[0].toUpperCase() + kind.slice(1) : kind;
  return `${title} task in progress… Mounts will show when workshop is ready`;
}

export type PanelState =
  | { kind: 'message'; text: string }
  | { kind: 'table'; sections: MountSection[] };

export interface PanelStateInput {
  /** Display status of the selected workshop. */
  status?: Status;
  /**
   * The kind of a matched in-progress *lifecycle* change (launch, refresh,
   * …). MUST be unset for row-level kinds (connect, disconnect, remount) —
   * those keep the table live — and for a Pending that matched no change
   * (which falls through to Loading/table, never a fabricated task name).
   */
  pendingKind?: string;
  /** Undefined until a connections snapshot for this workshop arrived. */
  sections?: MountSection[];
}

/**
 * Ordered guards from the handoff's single-message-state table for the
 * *selected* workshop (the panel follows the tree selection; there is no
 * picker). Anything that falls through renders the table — including a
 * workshop the daemon reports Pending because of a row-level change. The
 * no-workshops / no-selection / workshop-gone states are decided earlier, in
 * `fetchPanelData`.
 */
export function derivePanelState(input: PanelStateInput): PanelState {
  if (input.pendingKind !== undefined) {
    return { kind: 'message', text: pendingMessage(input.pendingKind) };
  }
  if (input.status === 'Off' || input.status === 'Error' || input.status === 'Unknown') {
    return { kind: 'message', text: MSG_OFF };
  }
  if (input.sections === undefined) {
    return { kind: 'message', text: MSG_LOADING };
  }
  if (input.sections.length === 0) {
    return { kind: 'message', text: MSG_NO_MOUNTS };
  }
  return { kind: 'table', sections: input.sections };
}
