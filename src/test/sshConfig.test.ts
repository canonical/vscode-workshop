import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { upsertHostBlock, ensureInclude } from '../remote/sshConfig';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-sshconfig-'));
}

suite('upsertHostBlock', () => {
  test('creates the file with a well-formed Host block', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'workshop');

    upsertHostBlock(file, 'demo.p.wp', '/storage/id_ed25519');

    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('Host demo.p.wp'));
    assert.ok(content.includes('HostName demo.p.wp'));
    assert.ok(content.includes('User workshop'));
    assert.ok(content.includes('IdentityFile /storage/id_ed25519'));
    assert.ok(content.includes('IdentitiesOnly yes'));
    assert.ok(content.includes('StrictHostKeyChecking no'));
    assert.ok(content.includes('UserKnownHostsFile /dev/null'));
  });

  test('is idempotent: second call with same hostname produces one block', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'workshop');

    upsertHostBlock(file, 'demo.p.wp', '/storage/id_ed25519');
    upsertHostBlock(file, 'demo.p.wp', '/storage/id_ed25519');

    const content = fs.readFileSync(file, 'utf8');
    const count = (content.match(/^Host demo\.p\.wp$/m) ?? []).length;
    assert.strictEqual(count, 1, 'exactly one Host block for the hostname');
  });

  test('updates an existing block when the identity file changes', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'workshop');

    upsertHostBlock(file, 'demo.p.wp', '/old/id_ed25519');
    upsertHostBlock(file, 'demo.p.wp', '/new/id_ed25519');

    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!content.includes('/old/id_ed25519'), 'old path removed');
    assert.ok(content.includes('/new/id_ed25519'), 'new path present');
  });

  test('preserves other hostnames when upserting', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'workshop');

    upsertHostBlock(file, 'alpha.p.wp', '/storage/id_ed25519');
    upsertHostBlock(file, 'beta.p.wp', '/storage/id_ed25519');

    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('Host alpha.p.wp'), 'alpha preserved');
    assert.ok(content.includes('Host beta.p.wp'), 'beta present');
  });

  test('file mode is 0600', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'workshop');

    upsertHostBlock(file, 'demo.p.wp', '/storage/id_ed25519');

    const mode = fs.statSync(file).mode & 0o777;
    assert.strictEqual(mode, 0o600);
  });
});

suite('ensureInclude', () => {
  test('prepends the Include directive to a non-existent config', () => {
    const dir = tmpDir();
    const config = path.join(dir, 'config');

    ensureInclude(config, '~/.ssh/config.d/*');

    const content = fs.readFileSync(config, 'utf8');
    assert.ok(content.startsWith('Include ~/.ssh/config.d/*'));
  });

  test('is idempotent: calling twice adds the directive only once', () => {
    const dir = tmpDir();
    const config = path.join(dir, 'config');

    ensureInclude(config, '~/.ssh/config.d/*');
    ensureInclude(config, '~/.ssh/config.d/*');

    const content = fs.readFileSync(config, 'utf8');
    const count = (content.match(/^Include/m) ?? []).length;
    assert.strictEqual(count, 1);
  });

  test('prepends to existing content without clobbering it', () => {
    const dir = tmpDir();
    const config = path.join(dir, 'config');
    fs.writeFileSync(config, 'Host existing\n    User me\n');

    ensureInclude(config, '~/.ssh/config.d/*');

    const content = fs.readFileSync(config, 'utf8');
    const includePos = content.indexOf('Include');
    const hostPos = content.indexOf('Host existing');
    assert.ok(includePos < hostPos, 'Include comes before existing Host');
    assert.ok(content.includes('Host existing'), 'existing content preserved');
  });
});
