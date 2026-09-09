import * as assert from 'assert';

import { loadDeclaredConnections, parseDeclaredConnections } from '../mounts/declared';

suite('parseDeclaredConnections', () => {
  test('parses <sdk>:<name> pairs from a real-shaped definition', () => {
    // Mirrors a real definition from this machine (~/workshop/test/workshop.yaml).
    const yaml = [
      'name: dev',
      'base: ubuntu@24.04',
      'sdks:',
      '  - name: jupyter',
      '  - name: uv',
      'connections:',
      '  - plug: jupyter:venv',
      '    slot: uv:venv',
    ].join('\n');

    assert.deepStrictEqual(parseDeclaredConnections(yaml), [
      { plug: { sdk: 'jupyter', name: 'venv' }, slot: { sdk: 'uv', name: 'venv' } },
    ]);
  });

  test('an empty sdk part means system (the :mount shorthand)', () => {
    const yaml = [
      'connections:',
      '  - plug: node:npm-cache',
      // A YAML scalar starting with ':' must be quoted to stay a string.
      '    slot: ":mount"',
    ].join('\n');

    assert.deepStrictEqual(parseDeclaredConnections(yaml), [
      { plug: { sdk: 'node', name: 'npm-cache' }, slot: { sdk: 'system', name: 'mount' } },
    ]);
  });

  test('malformed entries are skipped, valid ones kept', () => {
    const yaml = [
      'connections:',
      '  - plug: a:b',
      '    slot: c:d',
      '  - plug: no-colon', // not a two-part ref
      '    slot: c:d',
      '  - plug: "a:b:c"', // too many parts
      '    slot: c:d',
      '  - plug: "a:"', // empty name (quoted; bare `a:` is invalid YAML)
      '    slot: c:d',
      '  - plug: a:b', // slot missing entirely
      '  - not-a-mapping',
      '  - 42',
    ].join('\n');

    assert.deepStrictEqual(parseDeclaredConnections(yaml), [
      { plug: { sdk: 'a', name: 'b' }, slot: { sdk: 'c', name: 'd' } },
    ]);
  });

  test('never throws: malformed YAML and wrong shapes yield []', () => {
    assert.deepStrictEqual(parseDeclaredConnections('{{ not yaml'), []);
    assert.deepStrictEqual(parseDeclaredConnections(''), []);
    assert.deepStrictEqual(parseDeclaredConnections('just a scalar'), []);
    assert.deepStrictEqual(parseDeclaredConnections('connections: not-a-list'), []);
    assert.deepStrictEqual(parseDeclaredConnections('name: dev'), []);
  });
});

suite('loadDeclaredConnections', () => {
  test('reads through the injected readFile', async () => {
    const pairings = await loadDeclaredConnections('/defs/dev.yaml', async (p) => {
      assert.strictEqual(p, '/defs/dev.yaml');
      return 'connections:\n  - plug: a:b\n    slot: c:d';
    });

    assert.deepStrictEqual(pairings, [
      { plug: { sdk: 'a', name: 'b' }, slot: { sdk: 'c', name: 'd' } },
    ]);
  });

  test('a missing or unreadable file degrades to []', async () => {
    assert.deepStrictEqual(
      await loadDeclaredConnections('/gone.yaml', async () => {
        throw new Error('ENOENT');
      }),
      [],
    );
  });
});
