import { WorkshopApiError, WorkshopClient, WorkshopUnavailableError } from './api/client';

/**
 * Minimum `workshop` version this extension supports. From v0.9.5 the daemon
 * configures OpenSSH access automatically, so the extension no longer plants
 * SSH config itself and depends on this baseline being installed.
 */
export const MIN_WORKSHOP_VERSION = '0.9.5';

/**
 * Thrown when the installed workshop version is older than
 * {@link MIN_WORKSHOP_VERSION}. Treated like unavailability by the UI: the tree
 * is blanked and a welcome view offers an upgrade.
 */
export class WorkshopIncompatibleError extends WorkshopUnavailableError {
  constructor(
    readonly version: string,
    readonly minimum: string = MIN_WORKSHOP_VERSION,
  ) {
    super(
      `This extension requires Workshop ${minimum} or later, but ${version} is installed. ` +
      'Please upgrade with "snap refresh workshop".',
    );
    this.name = 'WorkshopIncompatibleError';
  }
}

/** Compare dotted numeric versions: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** True when `version` is at least {@link MIN_WORKSHOP_VERSION}. */
export function isWorkshopVersionCompatible(
  version: string,
  minimum: string = MIN_WORKSHOP_VERSION,
): boolean {
  return compareVersions(version, minimum) >= 0;
}

/**
 * Fetch the daemon version via `GET /v1/system-info`.
 *
 * - Returns the version string on success.
 * - Throws {@link WorkshopIncompatibleError} when the endpoint is absent (pre-0.9.5 daemon) — logged at debug.
 * - Returns `undefined` for other unexpected API errors — logged at warn.
 * - Re-throws `WorkshopUnavailableError` so callers surface daemon unavailability normally.
 */
export async function getDaemonVersion(
  client: WorkshopClient,
  log?: { debug(message: string): void; warn(message: string): void },
): Promise<string | undefined> {
  try {
    const info = await client.systemInfo();
    const version = info.version || undefined;
    if (version) {
      log?.debug(`Workshop daemon version: ${version}`);
    }
    return version;
  } catch (err) {
    if (err instanceof WorkshopUnavailableError) {
      throw err;
    }
    if (err instanceof WorkshopApiError && err.statusCode === 404) {
      log?.debug('/v1/system-info not found: daemon predates version reporting');
      throw new WorkshopIncompatibleError(`< ${MIN_WORKSHOP_VERSION}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    log?.warn(`Cannot determine daemon version: ${message}`);
    return undefined;
  }
}

/**
 * Throw a {@link WorkshopIncompatibleError} when the daemon version is known
 * and older than {@link MIN_WORKSHOP_VERSION}.
 */
export async function assertWorkshopVersionCompatible(
  client: WorkshopClient,
  log?: { debug(message: string): void; warn(message: string): void },
): Promise<void> {
  const version = await getDaemonVersion(client, log);
  if (version && !isWorkshopVersionCompatible(version)) {
    throw new WorkshopIncompatibleError(version);
  }
}
