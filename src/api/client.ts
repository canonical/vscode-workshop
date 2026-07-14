import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

/**
 * Minimal client for the `workshopd` daemon REST API, spoken over its Unix
 * domain socket. Mirrors the subset of `canonical/workshop`'s Go client this
 * extension needs: resolve a directory to a project, then list that project's
 * workshops.
 *
 * The daemon wraps every response in a sync/async envelope
 * (`{ "type": "sync", "status-code": 200, "result": ... }`); {@link request}
 * unwraps it and returns `result`, throwing on error envelopes or non-2xx
 * responses.
 */

/** A project as returned by `/v1/projects` — a directory known to the daemon. */
export interface Project {
  id: string;
  path: string;
}

/** A launched workshop with a live status (`GET .../workshops` → `workshops`). */
export interface WorkshopInfo {
  'project-id': string;
  name: string;
  base?: string;
  status: string;
  notes?: string[];
  /**
   * The workshop's routable hostname on the `.wp` domain. Sent with
   * `omitempty`, so it is present only once the workshop is running and has a
   * network identity.
   */
  hostname?: string;
  /**
   * Absolute path to the definition file. Only the single-workshop endpoint
   * (`GET .../workshops/<name>`) includes it — the `Workshop` struct adds a
   * `path` field on top of the embedded {@link WorkshopInfo}.
   */
  path?: string;
}

/**
 * A workshop *definition file* on disk (`GET .../workshops` → `files`). These
 * may exist without a running container — i.e. the workshop is `Off`.
 */
export interface WorkshopFile {
  'project-id': string;
  name: string;
  path: string;
}

export interface WorkshopsResponse {
  workshops?: WorkshopInfo[];
  files?: WorkshopFile[];
}

/** A single task within a {@link Change}. */
export interface ChangeTask {
  id: string;
  kind: string;
  summary?: string;
  status: string;
  /** Verbose log lines emitted by the task (present when `verbose=true`). */
  log?: string[];
  /** Completion progress for the task. `total` is 1 for indeterminate work. */
  progress?: TaskProgress;
  /** Kind-specific data (e.g. an `exec` task carries `exit-code`). */
  data?: Record<string, unknown>;
}

/** A task's completion progress (see `TaskProgress` in `client/changes.go`). */
export interface TaskProgress {
  label: string;
  done: number;
  total: number;
}

/** A daemon change: the async unit of work returned by mutating endpoints. */
export interface Change {
  id: string;
  kind: string;
  summary?: string;
  status: string;
  ready: boolean;
  err?: string;
  tasks?: ChangeTask[];
}

/** The daemon's response envelope. `result` shape depends on the endpoint. */
interface ResponseEnvelope {
  type: string;
  'status-code'?: number;
  status?: string;
  /** For async responses, the id of the change to wait on. */
  change?: string;
  result?: unknown;
}

/** Daemon error `kind` returned when a refresh finds nothing to update. */
export const ERROR_KIND_NO_UPDATES_AVAILABLE = 'no-updates-available';

/** Thrown when the daemon returns an error envelope or a non-2xx status. */
export class WorkshopApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    /** The daemon error `kind` (e.g. `no-updates-available`), when present. */
    readonly kind?: string,
  ) {
    super(message);
    this.name = 'WorkshopApiError';
  }
}

/**
 * Thrown when the daemon's socket can't be reached at all — typically because
 * Workshop isn't installed, the daemon isn't running, or we lack permission to
 * its socket. Distinct from {@link WorkshopApiError}, which means the daemon
 * answered but rejected the request.
 */
export class WorkshopUnavailableError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'WorkshopUnavailableError';
  }
}

/** Socket errors that mean "the daemon isn't reachable" rather than a bug. */
const UNAVAILABLE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'ECONNRESET']);

/** The daemon socket path used by a system (non-snap) install. */
export const DEFAULT_SOCKET_PATH = '/var/lib/workshop/workshop.socket';

/** The daemon socket path used by the `workshop` snap. */
export const SNAP_SOCKET_PATH = '/var/snap/workshop/common/workshop/workshop.socket';

/**
 * Ordered list of socket paths to probe when none is configured explicitly.
 * `$WORKSHOP_SOCKET` and `$WORKSHOP` (if set) take precedence, followed by the
 * snap location and the system default.
 */
export function socketPathCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  if (env.WORKSHOP_SOCKET) {
    candidates.push(env.WORKSHOP_SOCKET);
  }
  if (env.WORKSHOP) {
    candidates.push(path.join(env.WORKSHOP, 'workshop.socket'));
  }
  candidates.push(SNAP_SOCKET_PATH, DEFAULT_SOCKET_PATH);
  return [...new Set(candidates)];
}

/**
 * Resolve the daemon's socket path: return the first {@link socketPathCandidates}
 * entry that exists on disk, falling back to the first candidate so callers
 * still get a sensible path (and a meaningful error) when none is present.
 */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = socketPathCandidates(env);
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

export interface WorkshopClientOptions {
  /** Override the Unix socket path. Defaults to {@link defaultSocketPath}. */
  socketPath?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export class WorkshopClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  /**
   * Memoized project lookups keyed by directory path. A project's id is stable
   * for a given path, so we cache it to avoid re-POSTing `/v1/projects` on
   * every poll tick and every action.
   */
  private readonly projectCache = new Map<string, Project>();

  constructor(options: WorkshopClientOptions = {}) {
    this.socketPath = options.socketPath ?? defaultSocketPath();
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** The Unix socket path this client talks to. */
  get socket(): string {
    return this.socketPath;
  }

  /** List every project the daemon currently knows about. */
  async projects(): Promise<Project[]> {
    const result = await this.request('GET', '/v1/projects');
    return Array.isArray(result) ? (result as Project[]) : [];
  }

  /**
   * Look up a single project by its daemon ID. Returns `undefined` when no
   * project with that ID is currently registered.
   */
  async getProject(projectId: string): Promise<Project | undefined> {
    const all = await this.projects();
    return all.find((p) => p.id === projectId);
  }

  /**
   * Resolve a directory to a project, registering it with the daemon if it
   * isn't known yet. This is the entry point for any per-directory query.
   *
   * The result is memoized by path: the project id is stable for a directory,
   * so repeat callers (the poller, action handlers) reuse it instead of
   * re-POSTing `/v1/projects` each time.
   */
  async ensureProject(projectPath: string): Promise<Project> {
    const cached = this.projectCache.get(projectPath);
    if (cached) {
      return cached;
    }
    const result = await this.request('POST', '/v1/projects', { path: projectPath });
    const project = result as Project;
    this.projectCache.set(projectPath, project);
    return project;
  }

  /**
   * List the workshops of a project: both launched instances (with a live
   * status) and definition files on disk (which may be `Off`).
   */
  async listWorkshops(projectId: string): Promise<WorkshopsResponse> {
    const result = await this.request(
      'GET',
      `/v1/projects/${encodeURIComponent(projectId)}/workshops?state=available`,
    );
    return (result ?? {}) as WorkshopsResponse;
  }

  /**
   * POST to an async endpoint and return the id of the change to wait on plus
   * the (endpoint-specific) result payload — e.g. an `exec`'s `task-id`.
   */
  async postAsync(
    urlPath: string,
    body?: unknown,
  ): Promise<{ change: string; result: unknown }> {
    const envelope = await this.send('POST', urlPath, body);
    if (!envelope.change) {
      throw new WorkshopApiError('expected an async response with a change id', 0);
    }
    return { change: envelope.change, result: envelope.result };
  }

  /**
   * Fetch the current state of a single workshop.
   * `GET /v1/projects/<projectId>/workshops/<name>`
   */
  async getWorkshop(projectId: string, name: string): Promise<WorkshopInfo> {
    const result = await this.request(
      'GET',
      `/v1/projects/${encodeURIComponent(projectId)}/workshops/${encodeURIComponent(name)}`,
    );
    // The endpoint wraps WorkshopInfo in a Workshop struct with an extra `path`
    // field; WorkshopInfo is embedded so all its fields are top-level.
    return result as WorkshopInfo;
  }

  /**
   * Trigger a lifecycle action on one or more workshops and wait for the
   * change to complete.
   *
   * `POST /v1/projects/<id>/workshops` with `{ names, action, options? }`
   * returns an async change; we wait on it here so callers get back control
   * only once the operation is fully done.
   *
   * When `options.mode` is `'wait-on-error'` the daemon pauses mid-build with
   * status `Wait` instead of failing. In that case the change is returned
   * as-is so the caller can decide whether to continue, abort, or debug.
   */
  async workshopAction(
    projectId: string,
    names: string[],
    action: 'start' | 'launch' | 'stop' | 'refresh' | 'remove',
    options?: {
      mode?: 'transactional' | 'wait-on-error' | 'continue' | 'abort';
      verbose?: boolean;
      refreshOption?: 'update' | 'restore';
    },
  ): Promise<Change> {
    const body: Record<string, unknown> = { names, action };
    if (options) {
      const opts: Record<string, unknown> = {};
      if (options.mode !== undefined) { opts['mode'] = options.mode; }
      if (options.verbose !== undefined) { opts['verbose'] = options.verbose; }
      if (options.refreshOption !== undefined) { opts['refresh-option'] = options.refreshOption; }
      body['options'] = opts;
    }
    const { change } = await this.postAsync(
      `/v1/projects/${encodeURIComponent(projectId)}/workshops`,
      body,
    );
    const result = await this.request(
      'GET',
      `/v1/changes/${encodeURIComponent(change)}/wait`,
    );
    const resolved = result as Change;
    if (resolved.err && !(options?.mode === 'wait-on-error' && resolved.status === 'Wait')) {
      throw new WorkshopApiError(resolved.err, 0);
    }
    return resolved;
  }

  /**
   * Poll the current state of a change without blocking. Pass `verbose: true`
   * to include task log lines in the response — mirrors `cli.Change(id, true)`
   * in the Go CLI.
   *
   * Unlike {@link waitChange}, this returns immediately whether or not the
   * change is still running; callers must loop until `change.ready` is `true`.
   */
  async getChange(changeId: string, verbose = false): Promise<Change> {
    const query = verbose ? '?verbose=true' : '';
    const result = await this.request(
      'GET',
      `/v1/changes/${encodeURIComponent(changeId)}${query}`,
    );
    return result as Change;
  }

  /** Wait for a change to finish and return it, throwing if it errored. */
  async waitChange(changeId: string): Promise<Change> {
    const result = await this.request(
      'GET',
      `/v1/changes/${encodeURIComponent(changeId)}/wait`,
    );
    const change = result as Change;
    if (change.err) {
      throw new WorkshopApiError(change.err, 0);
    }
    return change;
  }

  /** Issue a request over the Unix socket and unwrap the response envelope. */
  private async request(method: string, urlPath: string, body?: unknown): Promise<unknown> {
    const envelope = await this.send(method, urlPath, body);
    return envelope.result;
  }

  /** Issue a request over the Unix socket and return the full envelope. */
  private async send(
    method: string,
    urlPath: string,
    body?: unknown,
  ): Promise<ResponseEnvelope> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: urlPath,
          headers: {
            Accept: 'application/json',
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
              : {}),
          },
          timeout: this.timeoutMs,
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(new Error('workshopd request timed out')));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code && UNAVAILABLE_CODES.has(err.code)) {
          reject(
            new WorkshopUnavailableError(
              `Cannot reach workshopd at ${this.socketPath}. Is Workshop installed and running?`,
              err.code,
            ),
          );
          return;
        }
        reject(err);
      });
      req.end(payload);
    });

    const status = res.statusCode ?? 0;
    const chunks: Buffer[] = [];
    for await (const chunk of res) {
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');

    let envelope: ResponseEnvelope;
    try {
      envelope = JSON.parse(text) as ResponseEnvelope;
    } catch {
      throw new WorkshopApiError(`invalid JSON response from workshopd: ${text}`, status);
    }

    if (envelope.type === 'error' || !isSuccess(status)) {
      const result = isRecord(envelope.result) ? envelope.result : undefined;
      const message =
        (typeof result?.message === 'string' ? result.message : undefined) ??
        `workshopd request failed (${status})`;
      const kind = typeof result?.kind === 'string' ? result.kind : undefined;
      throw new WorkshopApiError(message, status, kind);
    }

    return envelope;
  }
}

/** Whether an HTTP status code is in the 2xx success range. */
function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
