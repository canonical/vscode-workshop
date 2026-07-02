import * as assert from 'assert';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { WebSocketServer, WebSocket } from 'ws';

import { WorkshopClient } from '../api/client';
import { execWorkshop } from '../api/exec';

/**
 * A fake workshopd that answers the exec POST + change wait over HTTP and
 * serves the four task websockets, so {@link execWorkshop} can be exercised
 * end-to-end without a real daemon.
 */
suite('execWorkshop over a fake workshopd socket', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let socketPath: string;
  let execBody: unknown;
  let receivedStdin: Buffer;

  setup(async () => {
    socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'workshopd-')), 'workshop.socket');
    execBody = undefined;
    receivedStdin = Buffer.alloc(0);

    server = http.createServer((req, res) => {
      const sync = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'sync', 'status-code': 200, result }));
      };

      if (req.method === 'POST' && req.url === '/v1/projects/p/workshops/web/exec') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          execBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'async',
              'status-code': 202,
              change: '42',
              result: { 'task-id': 'T1' },
            }),
          );
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/changes/42/wait') {
        sync({
          id: '42',
          kind: 'exec',
          status: 'Done',
          ready: true,
          tasks: [{ id: '1', kind: 'exec', status: 'Done', data: { 'exit-code': 7 } }],
        });
        return;
      }

      res.writeHead(404).end();
    });

    wss = new WebSocketServer({ server });
    wss.on('connection', (socket: WebSocket, req: http.IncomingMessage) => {
      switch (req.url) {
        case '/v1/tasks/T1/websocket/stdio':
          socket.on('message', (data: Buffer, isBinary: boolean) => {
            if (isBinary) {
              receivedStdin = Buffer.concat([receivedStdin, data]);
            }
          });
          break;
        case '/v1/tasks/T1/websocket/stdout':
          socket.send(Buffer.from('hello out'));
          socket.send(''); // end-of-stream barrier
          break;
        case '/v1/tasks/T1/websocket/stderr':
          socket.send(Buffer.from('hello err'));
          socket.send('');
          break;
        // control: accept and stay silent.
      }
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  teardown(async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('runs a command and returns exit code and output', async () => {
    const client = new WorkshopClient({ socketPath });
    const result = await execWorkshop(client, 'p', 'web', {
      command: ['tee', '-a', '/home/workshop/.ssh/authorized_keys'],
      commandPrefix: ['sudo', '-u', '#1000'],
      environment: { FOO: 'bar' },
      workingDir: '/project',
      userId: 1000,
      groupId: 1000,
      stdin: 'ssh-ed25519 AAAA key\n',
    });

    assert.deepStrictEqual(result, {
      exitCode: 7,
      stdout: 'hello out',
      stderr: 'hello err',
    });
  });

  test('sends the exec payload with daemon field names', async () => {
    const client = new WorkshopClient({ socketPath });
    await execWorkshop(client, 'p', 'web', {
      command: ['whoami'],
      commandPrefix: ['sudo'],
      environment: { FOO: 'bar' },
      workingDir: '/project',
      userId: 1000,
      groupId: 1000,
    });

    assert.deepStrictEqual(execBody, {
      command: ['whoami'],
      'command-prefix': ['sudo'],
      environment: { FOO: 'bar' },
      'working-dir': '/project',
      'user-id': 1000,
      'group-id': 1000,
    });
  });

  test('forwards stdin to the workshop', async () => {
    const client = new WorkshopClient({ socketPath });
    await execWorkshop(client, 'p', 'web', {
      command: ['cat'],
      stdin: 'planted key\n',
    });

    assert.strictEqual(receivedStdin.toString('utf8'), 'planted key\n');
  });
});
