import * as vscode from 'vscode';

import { WorkshopApiError, WorkshopClient, WorkshopNotProjectError } from './api/client';
import { hostnameFromFolder, readSession, WorkshopSession } from './state';

type ProjectResolver = Pick<WorkshopClient, 'ensureProject'>;

export interface CurrentWorkshop {
  hostname: string;
  session: WorkshopSession | undefined;
}

export function isWorkshopWindow(): boolean {
  return vscode.env.remoteName === 'ssh-remote';
}

/** Return the SSH identity and stored session for a workshop folder. */
export function currentWorkshop(
  globalState: vscode.Memento,
  folder = vscode.workspace.workspaceFolders?.[0],
): CurrentWorkshop | undefined {
  const hostname = hostnameFromFolder(folder);
  if (!hostname) {
    return undefined;
  }
  return { hostname, session: readSession(globalState, hostname) };
}

/**
 * Holds the daemon project id for this window so it is resolved once instead
 * of on every poll tick or action. Workshop windows use their persisted
 * session id because the local daemon cannot resolve a Remote-SSH path; local
 * windows register their filesystem path with the daemon.
 *
 * Invalidation contract for the held id: it is dropped and re-resolved when
 * the workspace folders change (the `extension.ts` listener calls
 * {@link invalidate}) and, for local folders, when a caller proves it stale
 * via {@link withProjectRetry} (a daemon 404 for the held id). A failed local
 * resolution holds nothing, so the next {@link getId} retries.
 */
export class ProjectContext {
  private projectId: string | undefined;
  /** Single-flight guard: concurrent resolvers share one POST /v1/projects. */
  private resolving: Promise<string | undefined> | undefined;
  /**
   * Bumped by {@link invalidate}. A resolution stores its result only while its
   * generation is still current, so an {@link invalidate} racing an in-flight
   * {@link resolveNow} can't let the superseded id be written back afterwards.
   */
  private generation = 0;

  constructor(
    private readonly client: ProjectResolver,
    private readonly globalState: vscode.Memento,
    /** Injectable for tests; defaults to the window's first workspace folder. */
    private readonly folder: () => vscode.WorkspaceFolder | undefined = () =>
      vscode.workspace.workspaceFolders?.[0],
  ) {}

  /** The held id, resolving it first if no resolution has succeeded yet. */
  async getId(): Promise<string | undefined> {
    if (this.projectId !== undefined) {
      return this.projectId;
    }
    return this.resolveNow();
  }

  /** Resolve afresh (ignoring any held id) and hold the result. */
  private async resolveNow(): Promise<string | undefined> {
    if (this.resolving !== undefined) {
      return this.resolving;
    }

    // Hold the generation-aware operation (not the raw folder lookup) so
    // callers that join via `this.resolving` also honour a mid-flight
    // invalidation instead of receiving the superseded id.
    const pending = this.resolveGeneration(this.generation);
    this.resolving = pending;
    try {
      return await pending;
    } finally {
      if (this.resolving === pending) {
        this.resolving = undefined;
      }
    }
  }

  private async resolveGeneration(generation: number): Promise<string | undefined> {
    const id = await this.resolveFolder();
    if (generation !== this.generation) {
      // Invalidated mid-flight (e.g. the folder changed): this id belongs to
      // the superseded generation, so resolve the current one rather than let
      // the stale id escape to any caller (initiating or joined).
      return this.getId();
    }
    this.projectId = id;
    return id;
  }

  private async resolveFolder(): Promise<string | undefined> {
    const folder = this.folder();
    if (!folder) {
      return undefined;
    }
    const workshop = currentWorkshop(this.globalState, folder);
    if (workshop) {
      return workshop.session?.projectId;
    }
    if (folder.uri.scheme !== 'file') {
      return undefined;
    }
    return (await this.client.ensureProject(folder.uri.fsPath)).id;
  }

  /** Re-resolve a stale id only when the daemon can access the local folder. */
  async resolveStaleLocalId(staleId: string): Promise<string | undefined> {
    if (this.folder()?.uri.scheme !== 'file') {
      return undefined;
    }
    // A concurrent caller already refreshed past this id: reuse the new one
    // rather than invalidating it and minting yet another (superseding) id.
    if (this.projectId !== undefined && this.projectId !== staleId) {
      return this.projectId;
    }
    // Join a refresh already in flight rather than starting another.
    if (this.resolving !== undefined) {
      return this.resolving;
    }
    this.invalidate();
    return this.resolveNow();
  }

  /** Drop the held id; the next {@link getId} resolves afresh. */
  invalidate(): void {
    this.projectId = undefined;
    // Abandon any in-flight resolution: its result predates this invalidation.
    this.resolving = undefined;
    this.generation += 1;
  }
}

/**
 * Run `fn` with the held project id. For a local folder, re-resolve and retry
 * once when the daemon answers 404/`not-found`: its project record can vanish
 * or be reissued under a new id. Workshop windows preserve their persisted
 * session id and propagate the error because their remote path is not
 * accessible to the local daemon.
 */
export async function withProjectRetry<T>(
  projects: ProjectContext,
  fn: (projectId: string) => Promise<T>,
): Promise<T> {
  const id = await projects.getId();
  if (id === undefined) {
    throw new WorkshopApiError('no workshop project is associated with this window', 0);
  }
  try {
    return await fn(id);
  } catch (err) {
    if (!maybeStale(err)) {
      throw err;
    }
    const fresh = await projects.resolveStaleLocalId(id);
    if (fresh === undefined) {
      throw err;
    }
    return fn(fresh);
  }
}

function maybeStale(err: unknown): boolean {
  return !(err instanceof WorkshopNotProjectError)
    && err instanceof WorkshopApiError
    && (err.statusCode === 404 || err.kind === 'not-found');
}
