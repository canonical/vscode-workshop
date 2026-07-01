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

/** The daemon's response envelope. `result` shape depends on the endpoint. */
interface ResponseEnvelope {
  type: string;
  'status-code'?: number;
  status?: string;
  result?: unknown;
}

/** Thrown when the daemon returns an error envelope or a non-2xx status. */
export class WorkshopApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
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
   * Resolve a directory to a project, registering it with the daemon if it
   * isn't known yet. This is the entry point for any per-directory query.
   */
  async ensureProject(projectPath: string): Promise<Project> {
    const result = await this.request('POST', '/v1/projects', { path: projectPath });
    return result as Project;
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

  /** Issue a request over the Unix socket and unwrap the response envelope. */
  private async request(method: string, urlPath: string, body?: unknown): Promise<unknown> {
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
      const message =
        (isRecord(envelope.result) && typeof envelope.result.message === 'string'
          ? envelope.result.message
          : undefined) ?? `workshopd request failed (${status})`;
      throw new WorkshopApiError(message, status);
    }

    return envelope.result;
  }
}

/** Whether an HTTP status code is in the 2xx success range. */
function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
