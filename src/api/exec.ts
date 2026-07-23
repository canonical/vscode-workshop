import WebSocket from 'ws';

import { WorkshopClient } from './client';

/**
 * A one-shot command to run inside a workshop container. Mirrors the subset of
 * the daemon's exec payload this extension needs to plant an SSH key.
 */
export interface ExecSpec {
  /** Command and arguments; the first element is the executable. */
  command: string[];
  /** Optional Workshop-managed prefix prepended before execution. */
  commandPrefix?: string[];
  /** Optional environment variables. */
  environment?: Record<string, string>;
  /** Optional working directory (the daemon defaults to `/project`). */
  workingDir?: string;
  /** Optional uid to run the process as. */
  userId?: number;
  /** Optional gid to run the process as. */
  groupId?: number;
  /** Optional standard input to feed the process. */
  stdin?: string | Buffer;
}

/** The outcome of an {@link execWorkshop} call. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The daemon's exec payload (JSON field names match its Go client). */
interface ExecPayload {
  command: string[];
  'command-prefix'?: string[];
  environment?: Record<string, string>;
  'working-dir'?: string;
  'user-id'?: number;
  'group-id'?: number;
}

/**
 * Run a single command inside a workshop over the daemon socket and return its
 * exit code and captured output.
 *
 * This is a *one-shot* runner, not a long-lived bridge: it POSTs the exec
 * payload, then attaches the `stdio`/`stdout`/`stderr` websockets the daemon
 * requires. The command will not run unless those I/O websockets connect within
 * ~10s, so we open them eagerly, feed `stdin`, collect output, and wait for the
 * change to finish before reading `exit-code`.
 *
 * Layering: this module talks only to {@link WorkshopClient} and `ws`; it never
 * imports `vscode`, so it stays inside the `api/` boundary.
 */
export async function execWorkshop(
  client: WorkshopClient,
  projectId: string,
  name: string,
  spec: ExecSpec,
): Promise<ExecResult> {
  const payload: ExecPayload = {
    command: spec.command,
    'command-prefix': spec.commandPrefix,
    environment: spec.environment,
    'working-dir': spec.workingDir,
    'user-id': spec.userId,
    'group-id': spec.groupId,
  };

  const { change, result } = await client.postAsync(
    `/v1/projects/${encodeURIComponent(projectId)}/workshops/${encodeURIComponent(name)}/exec`,
    payload,
  );

  const taskId = (result as { 'task-id'?: string })['task-id'];
  if (!taskId) {
    throw new Error('exec response did not include a task-id');
  }

  const socketPath = client.socket;
  const control = await openChannel(socketPath, taskId, 'control');
  const stdio = await openChannel(socketPath, taskId, 'stdio');
  const stdout = await openChannel(socketPath, taskId, 'stdout');
  const stderr = await openChannel(socketPath, taskId, 'stderr');

  try {
    sendStdin(stdio.ws, spec.stdin);
    const [outBuf, errBuf] = await Promise.all([stdout.done, stderr.done]);

    const finished = await client.waitChange(change);
    const execTask = finished.tasks?.find((t) => t.kind === 'exec');
    const rawExit = execTask?.data?.['exit-code'];
    const exitCode = typeof rawExit === 'number' ? rawExit : 0;

    return { exitCode, stdout: outBuf.toString('utf8'), stderr: errBuf.toString('utf8') };
  } finally {
    for (const channel of [stdio, stdout, stderr, control]) {
      channel.ws.close();
    }
  }
}

interface Channel {
  ws: WebSocket;
  /** Resolves with all received binary data once the stream ends. */
  done: Promise<Buffer>;
}

/**
 * Open one of a task's I/O websockets over the Unix socket and start buffering
 * any data it sends. The message/close handlers are attached before `open`
 * resolves so no early output is lost.
 */
function openChannel(socketPath: string, taskId: string, id: string): Promise<Channel> {
  const url = `ws+unix://${socketPath}:/v1/tasks/${taskId}/websocket/${id}`;
  const ws = new WebSocket(url);

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      const buf = toBuffer(data);
      if (isBinary) {
        chunks.push(buf);
      } else if (buf.length === 0) {
        // An empty text frame is the daemon's end-of-stream barrier.
        resolve(Buffer.concat(chunks));
      }
    });
    ws.on('close', () => resolve(Buffer.concat(chunks)));
    ws.on('error', reject);
  });

  return new Promise<Channel>((resolve, reject) => {
    ws.once('open', () => resolve({ ws, done }));
    ws.once('error', reject);
  });
}

/** Feed stdin as a binary frame (if any), then the empty-text EOF barrier. */
function sendStdin(ws: WebSocket, stdin: string | Buffer | undefined): void {
  if (stdin && stdin.length > 0) {
    ws.send(typeof stdin === 'string' ? Buffer.from(stdin) : stdin);
  }
  ws.send('');
}

/** Normalize ws's possible message payloads into a single Buffer. */
function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}
