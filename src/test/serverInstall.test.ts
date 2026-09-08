import * as assert from 'assert';

import { readClientServerIdentity } from '../serverInstall';

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
