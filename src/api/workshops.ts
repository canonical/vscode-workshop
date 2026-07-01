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
}

/**
 * Merge the two halves of a `listWorkshops` response into a single, sorted
 * list. Launched workshops carry a live status; definition files that have no
 * matching live workshop are surfaced as `Off`, mirroring the old behaviour.
 */
export function mergeWorkshops(response: WorkshopsResponse): Workshop[] {
  const byName = new Map<string, Workshop>();

  for (const file of response.files ?? []) {
    byName.set(file.name, { name: file.name, status: 'Off' });
  }
  for (const workshop of response.workshops ?? []) {
    byName.set(workshop.name, { name: workshop.name, status: normalizeStatus(workshop.status) });
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
