import {
  Change,
  WorkshopApiError,
  WorkshopClient,
  WorkshopInfo,
} from '../api/client';
import { plugKey } from '../api/connections';
import { normalizeStatus } from '../api/workshops';
import { HostMounts, MountSection, buildSections } from './model';
import {
  derivePanelState,
  MSG_NO_SELECTION,
  PanelState,
} from './panelState';

/**
 * Data acquisition for the Mounts panel: one poll tick produces one
 * {@link PanelData}. The project id is passed in from activation state —
 * never resolved here (the caller wraps the tick in `withProjectRetry`).
 * No vscode imports.
 */

export type MountsClient = Pick<
  WorkshopClient,
  'getWorkshop' | 'getConnections' | 'listChanges'
>;

export interface MountsDataDeps {
  client: MountsClient;
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
  if (selectedWorkshop === undefined) {
    return { body: { kind: 'message', text: MSG_NO_SELECTION } };
  }
  return { body: await deriveSelectedBody(deps, projectId, selectedWorkshop) };
}

async function deriveSelectedBody(
  deps: MountsDataDeps,
  projectId: string,
  workshop: string,
): Promise<PanelState> {
  let detail: WorkshopInfo;
  try {
    detail = await deps.client.getWorkshop(projectId, workshop);
  } catch (err) {
    // The name comes from the tree. A kind-less 404 means there is no
    // container instance — never launched, or just removed — so render it as
    // Off. A stopped workshop keeps its container and does not 404.
    if (isNotFound(err)) {
      return derivePanelState({ status: 'Off' });
    }
    throw err;
  }

  const status = normalizeStatus(detail.status);

  if (status === 'Pending') {
    const pendingKind = await matchLifecycleChange(deps.client, projectId, workshop);
    if (pendingKind !== undefined) {
      return derivePanelState({ status, pendingKind });
    }
  }
  if (status === 'Off' || status === 'Error' || status === 'Unknown') {
    return derivePanelState({ status });
  }

  // Launched (On/Waiting), or Pending from a row-op/unmatched change: show
  // live state so flipping switches never blanks the tab.
  const sections = await fetchSections(deps, projectId, workshop, detail);
  return derivePanelState({ status, sections });
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

async function fetchSections(
  deps: MountsDataDeps,
  projectId: string,
  workshop: string,
  detail: WorkshopInfo,
): Promise<MountSection[] | undefined> {
  let snapshot;
  try {
    snapshot = await deps.client.getConnections(projectId, workshop);
  } catch (err) {
    // Raced a stop/remove after the status fetch: a kind-less 404 degrades to
    // Loading, not a failed poll.
    if (isNotFound(err)) {
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

  return buildSections({ projectId, workshop, snapshot, mounts: hostMounts });
}

/** A kind-less 404: the workshop has no container instance right now. */
function isNotFound(err: unknown): boolean {
  return err instanceof WorkshopApiError && err.statusCode === 404 && err.kind === undefined;
}
