import * as assert from 'assert';

import {
  cliDownloadUrl,
  ensureCachedTarball,
  readClientServerIdentity,
  serverDownloadUrl,
  scpPush,
  sshRun,
  detectRemotePlatform,
  mapUname,
  remoteServerPresent,
  serverLayout,
  buildInstallScript,
  installRemoteServer,
  type CacheFs,
  type ClientServerIdentity,
  type SpawnFn,
  type SpawnedProcess,
  type SshRun,
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

interface FakeFsState {
  files: Set<string>;
  writes: string[];
  removed: string[];
  fs: CacheFs;
}

function fakeFs(existing: string[] = []): FakeFsState {
  const files = new Set(existing);
  const writes: string[] = [];
  const removed: string[] = [];
  return {
    files,
    writes,
    removed,
    fs: {
      existsSync: (p) => files.has(p),
      mkdirSync: () => {},
      writeFileSync: (p) => {
        writes.push(p);
        files.add(p);
      },
      renameSync: (from, to) => {
        files.delete(from);
        files.add(to);
      },
      rmSync: (p) => {
        removed.push(p);
        files.delete(p);
      },
    },
  };
}

suite('ensureCachedTarball', () => {
  test('reuses an existing cached file without fetching', async () => {
    const state = fakeFs(['/cache/server.tgz']);
    let fetched = 0;
    const result = await ensureCachedTarball(
      '/cache/server.tgz',
      'https://dl/server.tgz',
      async () => {
        fetched++;
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
      },
      state.fs,
    );

    assert.strictEqual(result, '/cache/server.tgz');
    assert.strictEqual(fetched, 0);
    assert.deepStrictEqual(state.writes, []);
  });

  test('downloads once to a .part file then renames', async () => {
    const state = fakeFs();
    let fetched = 0;
    await ensureCachedTarball(
      '/cache/server.tgz',
      'https://dl/server.tgz',
      async () => {
        fetched++;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new TextEncoder().encode('payload').buffer,
        };
      },
      state.fs,
    );

    assert.strictEqual(fetched, 1);
    assert.deepStrictEqual(state.writes, ['/cache/server.tgz.part']);
    assert.ok(state.files.has('/cache/server.tgz'));
    assert.ok(!state.files.has('/cache/server.tgz.part'));
  });

  test('cleans up the partial file and throws on HTTP error', async () => {
    const state = fakeFs();
    await assert.rejects(
      ensureCachedTarball(
        '/cache/server.tgz',
        'https://dl/server.tgz',
        async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
        state.fs,
      ),
      /HTTP 404/,
    );
    assert.deepStrictEqual(state.removed, ['/cache/server.tgz.part']);
    assert.ok(!state.files.has('/cache/server.tgz'));
  });
});

interface SpawnCall {
  command: string;
  args: string[];
}

/** A fake spawn that records argv and emits the given exit code and streams. */
function fakeSpawn(
  calls: SpawnCall[],
  outcome: { code: number; stdout?: string; stderr?: string } = { code: 0 },
): SpawnFn {
  return (command, args) => {
    calls.push({ command, args });
    const process: SpawnedProcess = {
      stdout: { on: (_e, listener) => listener(outcome.stdout ?? '') },
      stderr: { on: (_e, listener) => listener(outcome.stderr ?? '') },
      on: (event, listener) => {
        if (event === 'close') {
          queueMicrotask(() => (listener as (code: number | null) => void)(outcome.code));
        }
      },
    };
    return process;
  };
}

suite('sshRun', () => {
  test('passes BatchMode options, hostname, then argv and returns stdout', async () => {
    const calls: SpawnCall[] = [];
    const out = await sshRun(
      fakeSpawn(calls, { code: 0, stdout: 'Linux x86_64\n' }),
      'web.proj-1.wp',
      ['uname', '-sm'],
    );

    assert.strictEqual(out, 'Linux x86_64\n');
    assert.deepStrictEqual(calls, [
      {
        command: 'ssh',
        args: [
          '-o', 'BatchMode=yes',
          '-o', 'ConnectTimeout=10',
          'web.proj-1.wp',
          'uname', '-sm',
        ],
      },
    ]);
  });

  test('throws on non-zero exit', async () => {
    const calls: SpawnCall[] = [];
    await assert.rejects(
      sshRun(fakeSpawn(calls, { code: 255, stderr: 'boom' }), 'host', ['true']),
      /ssh host exited 255: boom/,
    );
  });
});

suite('scpPush', () => {
  test('builds the scp argv with host:remotePath target', async () => {
    const calls: SpawnCall[] = [];
    await scpPush(fakeSpawn(calls), 'host', '/local/x.tgz', '/tmp/x.tgz');

    assert.deepStrictEqual(calls, [
      {
        command: 'scp',
        args: [
          '-o', 'BatchMode=yes',
          '-o', 'ConnectTimeout=10',
          '/local/x.tgz',
          'host:/tmp/x.tgz',
        ],
      },
    ]);
  });

  test('throws on non-zero exit', async () => {
    const calls: SpawnCall[] = [];
    await assert.rejects(
      scpPush(fakeSpawn(calls, { code: 1, stderr: 'no space' }), 'host', '/a', '/b'),
      /scp to host:\/b exited 1: no space/,
    );
  });
});

/** An SshRun that records argv and replies from a script->output map. */
function fakeSsh(
  replies: Record<string, string>,
  calls: string[][] = [],
): SshRun {
  return (argv) => {
    calls.push(argv);
    const key = argv.join(' ');
    return Promise.resolve(replies[key] ?? '');
  };
}

suite('mapUname', () => {
  test('maps supported architectures', () => {
    assert.strictEqual(mapUname('Linux x86_64'), 'linux-x64');
    assert.strictEqual(mapUname('Linux aarch64'), 'linux-arm64');
    assert.strictEqual(mapUname('Linux armv7l'), 'linux-armhf');
  });

  test('returns undefined for non-Linux or unknown machines', () => {
    assert.strictEqual(mapUname('Darwin arm64'), undefined);
    assert.strictEqual(mapUname('Linux sparc'), undefined);
  });
});

suite('detectRemotePlatform', () => {
  test('runs uname -sm and maps the result', async () => {
    const platform = await detectRemotePlatform(fakeSsh({ 'uname -sm': 'Linux aarch64\n' }));
    assert.strictEqual(platform, 'linux-arm64');
  });

  test('throws on an unsupported platform', async () => {
    await assert.rejects(
      detectRemotePlatform(fakeSsh({ 'uname -sm': 'Linux sparc64' })),
      /Unsupported remote platform: Linux sparc64/,
    );
  });
});

suite('serverLayout', () => {
  test('derives legacy and CLI paths from the identity', () => {
    const layout = serverLayout(STABLE);
    assert.strictEqual(layout.legacyLauncher, '$HOME/.vscode-server/bin/abc123/bin/code-server');
    assert.strictEqual(
      layout.cliLauncher,
      '$HOME/.vscode-server/cli/servers/Stable-abc123/server/bin/code-server',
    );
    assert.strictEqual(layout.cliBinary, '$HOME/.vscode-server/code-abc123');
  });

  test('uses the Insiders label for insider quality', () => {
    const layout = serverLayout({ ...STABLE, quality: 'insider' });
    assert.ok(layout.cliServerDir.includes('/Insiders-abc123/'));
  });
});

suite('remoteServerPresent', () => {
  test('returns true when the probe reports present', async () => {
    const present = await remoteServerPresent(
      STABLE,
      () => Promise.resolve('present\n'),
    );
    assert.strictEqual(present, true);
  });

  test('returns false when the probe reports absent', async () => {
    const calls: string[][] = [];
    const present = await remoteServerPresent(STABLE, fakeSsh({}, calls));
    assert.strictEqual(present, false);
    assert.strictEqual(calls[0][0], 'bash');
    assert.strictEqual(calls[0][1], '-c');
    assert.ok(calls[0][2].includes('$HOME/.vscode-server/bin/abc123/bin/code-server'));
    assert.ok(calls[0][2].includes('Stable-abc123/server/bin/code-server'));
  });
});

suite('buildInstallScript', () => {
  test('seeds only the legacy layout when no CLI tarball', () => {
    const script = buildInstallScript(
      STABLE,
      { server: '/tmp/x/server.tar.gz' },
      '/tmp/x',
    );
    assert.ok(script.startsWith('set -eu\n'));
    assert.ok(script.includes('if [ ! -x "$HOME/.vscode-server/bin/abc123/bin/code-server" ]'));
    assert.ok(script.includes(
      'tar -xzf "/tmp/x/server.tar.gz" ' +
      '-C "$HOME/.vscode-server/bin/abc123.staging" --strip-components=1',
    ));
    assert.ok(script.includes(
      'mv "$HOME/.vscode-server/bin/abc123.staging" "$HOME/.vscode-server/bin/abc123"',
    ));
    assert.ok(!script.includes('cli/servers'));
    assert.ok(script.trimEnd().endsWith('rm -rf "/tmp/x"'));
  });

  test('seeds the CLI layout and binary when a CLI tarball is given', () => {
    const script = buildInstallScript(
      STABLE,
      { server: '/tmp/x/server.tar.gz', cli: '/tmp/x/cli.gz' },
      '/tmp/x',
    );
    assert.ok(script.includes(
      'if [ ! -x ' +
      '"$HOME/.vscode-server/cli/servers/Stable-abc123/server/bin/code-server" ]',
    ));
    assert.ok(script.includes(
      'mv "$HOME/.vscode-server/cli/servers/Stable-abc123/server.staging" ' +
      '"$HOME/.vscode-server/cli/servers/Stable-abc123/server"',
    ));
    assert.ok(script.includes('gunzip -c "/tmp/x/cli.gz" > "$HOME/.vscode-server/code-abc123.staging"'));
    assert.ok(script.includes('mv "$HOME/.vscode-server/code-abc123.staging" "$HOME/.vscode-server/code-abc123"'));
  });
});

suite('installRemoteServer', () => {
  test('mktemps, scps the server tarball, then runs the install script', async () => {
    const sshCalls: string[][] = [];
    const scpCalls: [string, string][] = [];
    const ssh: SshRun = (argv) => {
      sshCalls.push(argv);
      return Promise.resolve(argv[0] === 'mktemp' ? '/tmp/seed\n' : '');
    };
    const scp = (local: string, remote: string): Promise<void> => {
      scpCalls.push([local, remote]);
      return Promise.resolve();
    };

    await installRemoteServer(STABLE, { server: '/cache/server.tgz' }, ssh, scp);

    assert.deepStrictEqual(sshCalls[0], ['mktemp', '-d']);
    assert.deepStrictEqual(scpCalls, [['/cache/server.tgz', '/tmp/seed/server.tar.gz']]);
    assert.strictEqual(sshCalls[1][0], 'bash');
    assert.ok(sshCalls[1][2].includes('tar -xzf "/tmp/seed/server.tar.gz"'));
  });

  test('also pushes the CLI tarball when provided', async () => {
    const scpCalls: [string, string][] = [];
    const ssh: SshRun = (argv) => Promise.resolve(argv[0] === 'mktemp' ? '/tmp/seed' : '');
    const scp = (local: string, remote: string): Promise<void> => {
      scpCalls.push([local, remote]);
      return Promise.resolve();
    };

    await installRemoteServer(
      STABLE,
      { server: '/cache/server.tgz', cli: '/cache/cli.gz' },
      ssh,
      scp,
    );

    assert.deepStrictEqual(scpCalls, [
      ['/cache/server.tgz', '/tmp/seed/server.tar.gz'],
      ['/cache/cli.gz', '/tmp/seed/cli.gz'],
    ]);
  });
});
