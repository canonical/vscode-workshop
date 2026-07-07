import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';

import { daemonSshConfigPath } from '../remote/ssh';
import { DEFAULT_SOCKET_PATH, SNAP_SOCKET_PATH } from '../api/client';

suite('daemonSshConfigPath', () => {
  const uid = String(os.userInfo().uid);

  test('returns the snap SSH dir path for the snap socket', () => {
    const result = daemonSshConfigPath(SNAP_SOCKET_PATH);
    assert.strictEqual(result, `/var/snap/workshop/current/ssh/${uid}/config`);
  });

  test('returns the system SSH dir path for the default socket', () => {
    const result = daemonSshConfigPath(DEFAULT_SOCKET_PATH);
    assert.strictEqual(result, `/var/lib/workshop/ssh/${uid}/config`);
  });

  test('uses the snap path for any socket under /var/snap/workshop/', () => {
    const result = daemonSshConfigPath('/var/snap/workshop/42/workshop/workshop.socket');
    assert.strictEqual(result, path.join('/var/snap/workshop/current/ssh', uid, 'config'));
  });

  test('uses the system path for a custom $WORKSHOP socket', () => {
    const result = daemonSshConfigPath('/home/user/.workshop/workshop.socket');
    assert.strictEqual(result, path.join('/var/lib/workshop/ssh', uid, 'config'));
  });

  test('$WORKSHOP env var takes precedence over socket path heuristic', () => {
    const result = daemonSshConfigPath(SNAP_SOCKET_PATH, { WORKSHOP: '/tmp/myworkshop' });
    assert.strictEqual(result, path.join('/tmp/myworkshop', 'ssh', uid, 'config'));
  });

  test('$WORKSHOP overrides snap heuristic even for snap socket', () => {
    const result = daemonSshConfigPath(SNAP_SOCKET_PATH, { WORKSHOP: '/home/user/.workshop' });
    assert.strictEqual(result, path.join('/home/user/.workshop', 'ssh', uid, 'config'));
  });
});
