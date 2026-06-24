import { WorkshopClient, WorkshopsResponse } from './client';

/**
 * Workshop lifecycle states, matching the statuses surfaced by the old
 * implementation (see `old/src/types.ts`).
 *
 * - `Off`      — a definition exists on disk but there is no container.
 * - `Pending`  — a transient state while a workshop is being launched.
 * - `Ready`    — the workshop is up and reachable.
 * - `Stopped`  — the container exists but is not running.
 * - `Waiting`  — paused mid-change, awaiting user input.
 * - `Error`    — the workshop failed.
 * - `Unknown`  — a status we don't recognise.
 */
export type Status = 'Off' | 'Pending' | 'Ready' | 'Stopped' | 'Waiting' | 'Error' | 'Unknown';

const KNOWN: Status[] = ['Off', 'Pending', 'Ready', 'Stopped', 'Waiting', 'Error'];

/** Coerce a raw status string from the daemon into a known {@link Status}. */
export function normalizeStatus(raw: string | undefined): Status {
  if (!raw) {
    return 'Unknown';
  }
  const lc = raw.toLowerCase();
  return KNOWN.find((s) => s.toLowerCase() === lc) ?? 'Unknown';
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
