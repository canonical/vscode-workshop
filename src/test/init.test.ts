import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildInitArgs,
  definitionPath,
  InitError,
  InitSpec,
  parseInitFailure,
  runWorkshopInit,
  WORKSHOP_NOT_FOUND_REASON,
} from '../api/init';

/**
 * A stand-in `workshop` CLI: records its arguments, then either creates the
 * definition (like `workshop init`) or fails with Workshop-style stderr when
 * a `FAIL` file exists next to it.
 */
const FAKE_CLI = `#!/bin/sh
dir=$(dirname "$0")
printf '%s\\n' "$@" > "$dir/args.txt"
if [ -f "$dir/FAIL" ]; then
  echo "error: $(cat "$dir/FAIL")" >&2
  exit 1
fi
name=$2
project=
while [ $# -gt 0 ]; do
  if [ "$1" = "-p" ]; then project=$2; fi
  shift
done
mkdir -p "$project/.workshop"
printf 'name: %s\\n' "$name" > "$project/.workshop/$name.yaml"
`;

suite('workshop init runner', () => {
  let tmp: string;
  let executable: string;
  let project: string;

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-init-'));
    executable = path.join(tmp, 'workshop');
    fs.writeFileSync(executable, FAKE_CLI, { mode: 0o755 });
    project = path.join(tmp, 'proj');
    fs.mkdirSync(project);
  });

  teardown(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const spec: InitSpec = {
    folder: '/proj',
    name: 'dev',
    base: 'ubuntu@22.04',
    sdks: [{ name: 'node' }, { name: 'ollama', channel: 'vulkan/stable' }],
  };

  test('builds the init command line', () => {
    assert.deepStrictEqual(buildInitArgs(spec), [
      'init', 'dev', '--sdks', 'node,ollama/vulkan/stable', '--base', 'ubuntu@22.04', '-p', '/proj',
    ]);
    assert.deepStrictEqual(buildInitArgs({ ...spec, sdks: [] }), [
      'init', 'dev', '--base', 'ubuntu@22.04', '-p', '/proj',
    ]);
    assert.strictEqual(definitionPath('/proj', 'dev'), '/proj/.workshop/dev.yaml');
  });

  test('runs the CLI and the definition appears', async () => {
    await runWorkshopInit({ ...spec, folder: project }, { executable });
    const recorded = fs.readFileSync(path.join(tmp, 'args.txt'), 'utf8').trim().split('\n');
    assert.deepStrictEqual(recorded, buildInitArgs({ ...spec, folder: project }));
    assert.ok(fs.existsSync(path.join(project, '.workshop', 'dev.yaml')));
  });

  test('surfaces the CLI reason without the error: prefix', async () => {
    fs.writeFileSync(path.join(tmp, 'FAIL'), 'cannot init: "dev" workshop already exists at "/x/.workshop/dev.yaml"');
    await assert.rejects(
      runWorkshopInit({ ...spec, folder: project }, { executable }),
      (err: unknown) => {
        assert.ok(err instanceof InitError);
        assert.strictEqual(err.reason, 'cannot init: "dev" workshop already exists at "/x/.workshop/dev.yaml"');
        assert.strictEqual(err.exitCode, 1);
        assert.ok(err.stderr.startsWith('error: '));
        return true;
      },
    );
    assert.ok(!fs.existsSync(path.join(project, '.workshop', 'dev.yaml')));
  });

  test('reports a missing executable', async () => {
    await assert.rejects(
      runWorkshopInit({ ...spec, folder: project }, { executable: path.join(tmp, 'missing') }),
      (err: unknown) => err instanceof InitError && err.reason === WORKSHOP_NOT_FOUND_REASON,
    );
  });

  test('parses stderr into a reason', () => {
    assert.strictEqual(parseInitFailure('error: base "ubuntu@18.04" not supported\n', 1), 'base "ubuntu@18.04" not supported');
    assert.strictEqual(parseInitFailure('warning: something\nerror:   spaced\n', 1), 'spaced');
    assert.strictEqual(parseInitFailure('panic: boom\n', 2), 'panic: boom');
    assert.strictEqual(parseInitFailure('', 3), 'workshop init exited with code 3');
    assert.strictEqual(parseInitFailure('', undefined), 'workshop init did not complete');
  });
});
