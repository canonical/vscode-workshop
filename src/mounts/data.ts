import {
  Change,
  WorkshopApiError,
  WorkshopClient,
  WorkshopInfo,
} from '../api/client';
import { plugKey } from '../api/connections';
import { mergeWorkshops, Workshop } from '../api/workshops';
import { InflightTracker } from './inflight';
import { HostMounts, buildSections } from './model';
import {
  derivePanelState,
  MSG_NO_SELECTION,
  MSG_NO_WORKSHOPS,
  PanelState,
  workshopGoneMessage,
} from './panelState';

/**
 * Data acquisition for the Mounts panel: one poll tick produces one
 * {@link PanelData}. The project id is passed in from activation state —
 * never resolved here (the caller wraps the tick in `withProjectRetry`).
 * No vscode imports.
 */

export type MountsClient = Pick<
  WorkshopClient,
  'listWorkshops' | 'getWorkshop' | 'getConnections' | 'listChanges'
>;

export interface MountsDataDeps {
  client: MountsClient;
  inflight: InflightTracker;
}

/**
 * Everything one render needs. Deliberately free of volatile fields
 * (change ids, timestamps): the poller diffs PanelData structurally and
 * must not re-render every tick.
 */
export interface PanelData {
  body: PanelState;
}

/**
 * Change kinds that are row-level operations: the daemon flips the workshop
 * to Pending while they run, but they must keep the table live — never a
 * single-message state.
 */
export const ROW_OP_KINDS: ReadonlySet<string> = new Set(['connect', 'disconnect', 'remount']);

/**
 * Lifecycle kinds that blank the tab with `<Kind> task in progress…` while
 * they run. Anything else (row ops, exec, unmatched) falls through to the
 * live table / Loading.
 */
const LIFECYCLE_KINDS: ReadonlySet<string> = new Set(['launch', 'refresh', 'stop', 'remove', 'start']);

/** Fetch one poll's PanelData for the workshop selected in the tree. */
export async function fetchPanelData(
  deps: MountsDataDeps,
  projectId: string,
  selectedWorkshop: string | undefined,
): Promise<PanelData> {
  const workshops = mergeWorkshops(await deps.client.listWorkshops(projectId), projectId);
  const names = workshops.map((workshop) => workshop.name);

  if (names.length === 0) {
    return { body: { kind: 'message', text: MSG_NO_WORKSHOPS } };
  }
  if (selectedWorkshop === undefined) {
    return { body: { kind: 'message', text: MSG_NO_SELECTION } };
  }
  const selected = workshops.find((workshop) => workshop.name === selectedWorkshop);
  if (selected === undefined) {
    return { body: { kind: 'message', text: workshopGoneMessage(selectedWorkshop) } };
  }
  const body = await deriveSelectedBody(deps, projectId, names, selected);
  return { body };
}

async function deriveSelectedBody(
  deps: MountsDataDeps,
  projectId: string,
  names: string[],
  workshop: Workshop,
): Promise<PanelState> {
  const guidedRemount = deps.inflight.isGuidedRemount(projectId, workshop.name);
  const base = {
    workshops: names,
    selected: workshop.name,
    status: workshop.status,
    guidedRemount,
  };
  if (guidedRemount) {
    return derivePanelState(base);
  }

  let pendingKind: string | undefined;
  if (workshop.status === 'Pending') {
    pendingKind = await matchLifecycleChange(deps.client, projectId, workshop.name);
    if (pendingKind !== undefined) {
      return derivePanelState({ ...base, pendingKind });
    }
  }
  if (workshop.status === 'Off' || workshop.status === 'Error' || workshop.status === 'Unknown') {
    return derivePanelState(base);
  }

  // Launched (On/Waiting), or Pending from a row-op/unmatched change: show
  // live state so flipping switches never blanks the tab.
  const live = await fetchLiveState(deps, projectId, workshop);
  return derivePanelState({ ...base, sections: live?.sections });
}

/**
 * The kind of an in-progress lifecycle change for this workshop, if any.
 * The `?workshops=` filter matches nothing (no change sets a `workshop`
 * field), so the workshop is matched client-side against change/task
 * summaries: the daemon quotes workshop names (`… workshop "dev" …`) and
 * remount summaries use the `<workshop>/<sdk>:<plug>` form.
 */
async function matchLifecycleChange(
  client: MountsClient,
  projectId: string,
  workshop: string,
): Promise<string | undefined> {
  const changes = await client.listChanges({ select: 'in-progress', projectId });
  const matched = changes.find(
    (change) => changeMatchesWorkshop(change, workshop) && !ROW_OP_KINDS.has(change.kind),
  );
  return matched !== undefined && LIFECYCLE_KINDS.has(matched.kind) ? matched.kind : undefined;
}

function changeMatchesWorkshop(change: Change, workshop: string): boolean {
  const quoted = `"${workshop}"`;
  const slashed = ` ${workshop}/`;
  const texts = [change.summary, ...(change.tasks ?? []).map((task) => task.summary)];
  return texts.some(
    (text) => text !== undefined && (text.includes(quoted) || text.includes(slashed)),
  );
}

async function fetchLiveState(
  deps: MountsDataDeps,
  projectId: string,
  workshop: Workshop,
): Promise<{ sections: ReturnType<typeof buildSections> } | undefined> {
  let detail: WorkshopInfo;
  let snapshot;
  try {
    [detail, snapshot] = await Promise.all([
      deps.client.getWorkshop(projectId, workshop.name),
      deps.client.getConnections(projectId, workshop.name),
    ]);
  } catch (err) {
    // A plain 404 means the fetch raced a stop/remove (these endpoints send
    // no error kind, just the status): degrade to Loading, not a failed poll.
    if (err instanceof WorkshopApiError && err.statusCode === 404 && err.kind === undefined) {
      return undefined;
    }
    throw err;
  }

  const hostMounts: HostMounts = {};
  for (const sdk of detail.sdks ?? []) {
    for (const mount of sdk.mounts ?? []) {
      const key = plugKey(mount.plug);
      hostMounts[key] = {
        hostSource: mount['host-source'],
        workshopTarget: mount['workshop-target'],
      };
    }
  }

  return {
    sections: buildSections({
      projectId,
      workshop: workshop.name,
      snapshot,
      mounts: hostMounts,
      pendingRowIds: deps.inflight.pendingRowIds(),
    }),
  };
}
