import * as vscode from 'vscode';

import { WorkshopApiError, WorkshopClient } from './api/client';
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

/** Resolve the daemon project represented by the current VS Code window. */
export async function resolveCurrentProjectId(
  client: ProjectResolver,
  globalState: vscode.Memento,
  folder = vscode.workspace.workspaceFolders?.[0],
): Promise<string | undefined> {
  if (!folder) {
    return undefined;
  }
  const workshop = currentWorkshop(globalState, folder);
  if (workshop) {
    return workshop.session?.projectId;
  }
  return (await client.ensureProject(folder.uri.fsPath)).id;
}

/**
 * Holds the daemon project id for this window so it is resolved once — at
 * activation — instead of on every poll tick or action.
 *
 * Invalidation contract for the held id: it is dropped and re-resolved when
 * the workspace folders change (the `extension.ts` listener calls
 * {@link invalidate}) and when a caller proves it stale via
 * {@link withProjectRetry} (a daemon 404 for the held id). A failed
 * resolution holds nothing, so the next {@link getId} retries. The id is
 * never persisted across sessions: project ids are not stable for a given
 * path — the daemon mints a new id for a copied directory or a regenerated
 * lock file.
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
  async resolveNow(): Promise<string | undefined> {
    if (this.resolving === undefined) {
      const generation = this.generation;
      const pending = resolveCurrentProjectId(this.client, this.globalState, this.folder())
        .then((id) => {
          if (generation === this.generation) {
            this.projectId = id;
          }
          return id;
        })
        .finally(() => {
          if (this.resolving === pending) {
            this.resolving = undefined;
          }
        });
      this.resolving = pending;
    }
    return this.resolving;
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
 * Run `fn` with the held project id, re-resolving once on a stale-id
 * failure. When the daemon answers 404/`not-found` for the held id — its
 * project record can vanish (daemon state wiped) or be reissued under a new
 * id (the path was copied, or the lock file regenerated) — the path is
 * re-resolved via `POST /v1/projects` and `fn` retried once with the fresh
 * id. Re-registering can also revive the *same* id (the daemon restores ids
 * from the project lock file), so the retry is attempted even then.
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
    if (!isStaleProjectError(err)) {
      throw err;
    }
    projects.invalidate();
    const fresh = await projects.resolveNow();
    if (fresh === undefined) {
      throw err;
    }
    return fn(fresh);
  }
}

function isStaleProjectError(err: unknown): boolean {
  return err instanceof WorkshopApiError
    && (err.statusCode === 404 || err.kind === 'not-found');
}
