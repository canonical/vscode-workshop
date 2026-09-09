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

export type PanelState =
  | { kind: 'message'; text: string }
  | { kind: 'table'; sections: MountSection[] };

export interface PanelStateInput {
  /** Display status of the selected workshop. */
  status?: Status;
  /** Undefined until a connections snapshot for this workshop arrived. */
  sections?: MountSection[];
}

/**
 * Ordered guards from the handoff's single-message-state table for the
 * *selected* workshop (the panel follows the tree selection; there is no
 * picker). A Pending workshop is not a message state — the workshop endpoint
 * returns mounts for it too — so it falls through to the table, or to Loading
 * until its snapshot arrives. The no-selection / Off states are decided
 * earlier, in `fetchPanelData`.
 */
export function derivePanelState(input: PanelStateInput): PanelState {
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
