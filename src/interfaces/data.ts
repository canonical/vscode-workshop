import {
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
  'getWorkshop' | 'getConnections'
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

  if (status === 'Off' || status === 'Error' || status === 'Unknown') {
    return derivePanelState({ status });
  }

  // Launched or Pending: the workshop endpoint returns mounts for a Pending
  // workshop too, so there is no task-in-progress message — show live state
  // (or Loading until its snapshot arrives).
  const sections = await fetchSections(deps, projectId, workshop, detail);
  return derivePanelState({ status, sections });
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
