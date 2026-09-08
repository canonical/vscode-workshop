import * as assert from 'assert';

import {
  cliDownloadUrl,
  readClientServerIdentity,
  serverDownloadUrl,
  type ClientServerIdentity,
} from '../serverInstall';

function reader(files: Record<string, string>) {
  return (filePath: string): string => {
    const content = files[filePath];
    if (content === undefined) {
      throw new Error(`ENOENT: ${filePath}`);
    }
    return content;
  };
}

suite('readClientServerIdentity', () => {
  test('parses a stable build', () => {
    const identity = readClientServerIdentity(
      '/app',
      reader({
        '/app/product.json': JSON.stringify({
          commit: 'abc123',
          quality: 'stable',
          serverApplicationName: 'code-server',
          serverDataFolderName: '.vscode-server',
          serverDownloadUrlTemplate: 'https://example/${quality}/${commit}/${os}-${arch}',
        }),
      }),
    );

    assert.deepStrictEqual(identity, {
      commit: 'abc123',
      quality: 'stable',
      serverApplicationName: 'code-server',
      serverDataFolderName: '.vscode-server',
      serverDownloadUrlTemplate: 'https://example/${quality}/${commit}/${os}-${arch}',
    });
  });

  test('parses an insiders build', () => {
    const identity = readClientServerIdentity(
      '/app',
      reader({
        '/app/product.json': JSON.stringify({
          commit: 'def456',
          quality: 'insider',
          serverApplicationName: 'code-server-insiders',
          serverDataFolderName: '.vscode-server-insiders',
        }),
      }),
    );

    assert.strictEqual(identity?.quality, 'insider');
    assert.strictEqual(identity?.serverApplicationName, 'code-server-insiders');
    assert.strictEqual(identity?.serverDownloadUrlTemplate, undefined);
  });

  test('applies defaults for missing optional fields', () => {
    const identity = readClientServerIdentity(
      '/app',
      reader({ '/app/product.json': JSON.stringify({ commit: 'abc123' }) }),
    );

    assert.strictEqual(identity?.quality, 'stable');
    assert.strictEqual(identity?.serverDataFolderName, '.vscode-server');
    assert.strictEqual(identity?.serverApplicationName, 'code-server');
  });

  test('returns undefined when commit is absent (OSS/dev build)', () => {
    const identity = readClientServerIdentity(
      '/app',
      reader({ '/app/product.json': JSON.stringify({ quality: 'stable' }) }),
    );
    assert.strictEqual(identity, undefined);
  });

  test('returns undefined when product.json is missing', () => {
    assert.strictEqual(readClientServerIdentity('/app', reader({})), undefined);
  });

  test('returns undefined when product.json is unparseable', () => {
    const identity = readClientServerIdentity(
      '/app',
      reader({ '/app/product.json': 'not json' }),
    );
    assert.strictEqual(identity, undefined);
  });
});

const STABLE: ClientServerIdentity = {
  commit: 'abc123',
  quality: 'stable',
  serverDataFolderName: '.vscode-server',
  serverApplicationName: 'code-server',
};

suite('serverDownloadUrl', () => {
  test('uses the update fallback keyed by commit when no template', () => {
    assert.strictEqual(
      serverDownloadUrl(STABLE, 'linux-x64'),
      'https://update.code.visualstudio.com/commit:abc123/server-linux-x64/stable',
    );
    assert.strictEqual(
      serverDownloadUrl(STABLE, 'linux-arm64'),
      'https://update.code.visualstudio.com/commit:abc123/server-linux-arm64/stable',
    );
  });

  test('interpolates the product.json template placeholders', () => {
    const identity: ClientServerIdentity = {
      ...STABLE,
      serverDownloadUrlTemplate:
        'https://dl/${quality}/${commit}/vscode-server-${os}-${arch}.tar.gz',
    };
    assert.strictEqual(
      serverDownloadUrl(identity, 'linux-armhf'),
      'https://dl/stable/abc123/vscode-server-linux-armhf.tar.gz',
    );
  });
});

suite('cliDownloadUrl', () => {
  test('builds the CLI binary URL keyed by commit and platform', () => {
    assert.strictEqual(
      cliDownloadUrl(STABLE, 'linux-x64'),
      'https://update.code.visualstudio.com/commit:abc123/cli-linux-x64/stable',
    );
  });
});
