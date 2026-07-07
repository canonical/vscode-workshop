import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { ensureInclude } from '../remote/sshConfig';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-sshconfig-'));
}

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
