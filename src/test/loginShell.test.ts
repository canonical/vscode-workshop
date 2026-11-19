import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { WebSocket, WebSocketServer } from 'ws';

import { WorkshopClient } from '../api/client';
import { ensureLoginShellTerminals } from '../api/loginShell';

suite('ensureLoginShellTerminals over a fake workshopd socket', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let socketPath: string;
  let execBody: { command: string[] } | undefined;
  let stdin: Buffer;
  let exitCode: number;

  setup(async () => {
    socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'workshopd-')), 'workshop.socket');
    execBody = undefined;
    stdin = Buffer.alloc(0);
    exitCode = 0;

    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/projects/p/workshops/web/exec') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          execBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'async', 'status-code': 202, change: '1', result: { 'task-id': 'T1' } }));
        });
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/changes/1/wait') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'sync',
          'status-code': 200,
          result: { id: '1', status: 'Done', ready: true, tasks: [{ id: '1', kind: 'exec', status: 'Done', data: { 'exit-code': exitCode } }] },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    wss = new WebSocketServer({ server });
    wss.on('connection', (socket: WebSocket, req: http.IncomingMessage) => {
      if (req.url === '/v1/tasks/T1/websocket/stdio') {
        socket.on('message', (data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            stdin = Buffer.concat([stdin, data]);
          }
        });
      } else if (req.url?.endsWith('/stdout') || req.url?.endsWith('/stderr')) {
        socket.send(exitCode === 0 ? '' : Buffer.from('boom'));
        socket.send('');
      }
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  teardown(async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('writes a login-shell default profile only when machine settings are absent', async () => {
    await ensureLoginShellTerminals(new WorkshopClient({ socketPath }), 'p', 'web');

    const [shell, flag, script] = execBody!.command;
    assert.deepStrictEqual([shell, flag], ['sh', '-c']);
    assert.match(script, /\.vscode-server\/data\/Machine\/settings\.json/);
    assert.match(script, /\[ -e "\$f" \] \|\|/);
    assert.deepStrictEqual(JSON.parse(stdin.toString('utf8')), {
      'terminal.integrated.profiles.linux': { bash: { path: 'bash', args: ['-l'] } },
      'terminal.integrated.defaultProfile.linux': 'bash',
    });
  });

  test('rejects with stderr when the command fails', async () => {
    exitCode = 1;
    await assert.rejects(ensureLoginShellTerminals(new WorkshopClient({ socketPath }), 'p', 'web'), /boom/);
  });
});
