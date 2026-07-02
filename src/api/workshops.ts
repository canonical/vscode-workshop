import { WorkshopClient, WorkshopsResponse } from './client';

/**
 * Workshop lifecycle states.
 *
 * - `On`       — the workshop is up and reachable (daemon status: `ready`).
 * - `Off`      — no running container (daemon status: `off`, `stopped`, or definition-only).
 * - `Pending`  — a transient state while a workshop is being launched.
 * - `Waiting`  — paused mid-change, awaiting user input.
 * - `Error`    — the workshop failed.
 * - `Unknown`  — a status we don't recognise.
 */
export type Status = 'On' | 'Off' | 'Pending' | 'Waiting' | 'Error' | 'Unknown';

/** Coerce a raw status string from the daemon into a known {@link Status}. */
export function normalizeStatus(raw: string | undefined): Status {
  switch (raw?.toLowerCase()) {
    case 'ready':   return 'On';
    case 'off':     return 'Off';
    case 'stopped': return 'Off';
    case 'pending': return 'Pending';
    case 'waiting': return 'Waiting';
    case 'error':   return 'Error';
    default:        return 'Unknown';
  }
}

/** A workshop to display: its name and resolved status. */
export interface Workshop {
  name: string;
  status: Status;
  /**
   * The raw daemon status string (e.g. `ready`, `stopped`, `off`). Undefined
   * for definition-only workshops that have never been launched. Kept
   * alongside {@link status} because the display status collapses `stopped`
   * and `off` into `Off`, but the reopen action needs to tell them apart.
   */
  rawStatus?: string;
  /**
   * The workshop's routable hostname. Present only when the workshop is
   * running (see {@link WorkshopInfo.hostname}).
   */
  hostname?: string;
  /**
   * Absolute path to the definition file on the local filesystem, as returned
   * by the daemon's `files` list. May be any of:
   *   - `.workshop/<name>.yaml`
   *   - `.workshop.yaml` (single-workshop project)
   *   - `workshop.yaml` (single-workshop project, root level)
   */
  definitionPath?: string;
}

/**
 * What {@link reopenInWorkshop} must do to bring a workshop online before
 * connecting:
 *
 * - `connect` — already running; connect directly.
 * - `start`   — built but stopped; issue the `start` action first.
 * - `launch`  — never built (raw `off` or definition-only); `launch` first.
 */
export type ReopenAction = 'connect' | 'start' | 'launch';

/**
 * Decide how to reopen into a workshop from its model. Derived from the raw
 * daemon status and origin, not the collapsed display {@link Status}.
 */
export function reopenAction(workshop: Workshop): ReopenAction {
  if (workshop.status === 'On' || workshop.status === 'Waiting') {
    return 'connect';
  }
  if (workshop.rawStatus?.toLowerCase() === 'stopped') {
    return 'start';
  }
  return 'launch'; // raw 'off' or definition-only
}

/**
 * Merge the two halves of a `listWorkshops` response into a single, sorted
 * list. Launched workshops carry a live status; definition files that have no
 * matching live workshop are surfaced as `Off`, mirroring the old behaviour.
 */
export function mergeWorkshops(response: WorkshopsResponse): Workshop[] {
  const byName = new Map<string, Workshop>();

  for (const file of response.files ?? []) {
    byName.set(file.name, { name: file.name, status: 'Off', definitionPath: file.path });
  }
  for (const workshop of response.workshops ?? []) {
    byName.set(workshop.name, {
      ...byName.get(workshop.name), // preserve definitionPath if already set from files
      name: workshop.name,
      status: normalizeStatus(workshop.status),
      rawStatus: workshop.status,
      hostname: workshop.hostname,
      definitionPath: byName.get(workshop.name)?.definitionPath,
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * High-level helper: resolve a directory to a project and return its merged,
 * sorted workshop list.
 */
export async function listProjectWorkshops(
  client: WorkshopClient,
  projectPath: string,
): Promise<Workshop[]> {
  const project = await client.ensureProject(projectPath);
  const response = await client.listWorkshops(project.id);
  return mergeWorkshops(response);
}
