import * as assert from 'assert';

import {
  DEFAULT_BASE,
  NAME_EMPTY_MESSAGE,
  NAME_PATTERN_MESSAGE,
  NAME_TOO_LONG_MESSAGE,
  preferredBase,
  REFERENCE_SDKS,
  SDK_CATEGORY_ORDER,
  validateWorkshopName,
} from '../api/sdkCatalog';

suite('REFERENCE_SDKS', () => {
  test('lists exactly the reference SDKs from the design', () => {
    assert.deepStrictEqual(
      REFERENCE_SDKS.map((sdk) => sdk.name),
      [
        'agy', 'claude-code', 'codex', 'copilot', 'opencode',
        'dotnet', 'flutter', 'go', 'gradle', 'maven', 'node', 'openjdk', 'rust', 'uv',
        'cuda-toolkit', 'openvino', 'rocm',
        'comfy-ui', 'ollama',
        'zephyr', 'zephyr-toolchains',
        'ros2-minimal',
        'direnv', 'docker-ce', 'github-runner', 'jupyter',
      ],
    );
  });

  test('is grouped by category in display order and alphabetical within', () => {
    const categories = [...new Set(REFERENCE_SDKS.map((sdk) => sdk.category))];
    assert.deepStrictEqual(categories, SDK_CATEGORY_ORDER);
    for (const category of SDK_CATEGORY_ORDER) {
      const names = REFERENCE_SDKS.filter((sdk) => sdk.category === category).map((sdk) => sdk.name);
      assert.deepStrictEqual(names, [...names].sort(), `category ${category}`);
    }
  });

  test('links to the Canonical repositories', () => {
    const byName = new Map(REFERENCE_SDKS.map((sdk) => [sdk.name, sdk]));
    assert.strictEqual(byName.get('ollama')?.repoUrl, 'https://github.com/canonical/ollama-sdk');
    assert.strictEqual(byName.get('docker-ce')?.repoUrl, 'https://github.com/canonical/docker-sdk');
    assert.strictEqual(byName.get('zephyr-toolchains')?.repoUrl, 'https://github.com/canonical/zephyr-toolchains-sdks');
    assert.strictEqual(byName.get('ollama')?.summary, 'Local LLM runtime for running open-weight models');
  });

  test('each recommendedChannel, when set, matches track/risk', () => {
    const channelPattern = /^[a-z0-9][a-z0-9.-]*\/(?:stable|candidate|beta|edge)$/;
    for (const sdk of REFERENCE_SDKS) {
      if (sdk.recommendedChannel !== undefined) {
        assert.match(sdk.recommendedChannel, channelPattern, `${sdk.name}: ${sdk.recommendedChannel}`);
      }
    }
  });
});

suite('preferredBase', () => {
  test('prefers the default base, else the newest', () => {
    assert.strictEqual(preferredBase(['ubuntu@26.04', 'ubuntu@22.04']), DEFAULT_BASE);
    assert.strictEqual(preferredBase(['ubuntu@24.04', 'ubuntu@22.04']), 'ubuntu@24.04');
    assert.strictEqual(preferredBase([]), undefined);
  });
});

suite('validateWorkshopName', () => {
  test('accepts valid names, ignoring surrounding whitespace', () => {
    for (const name of ['dev', 'dev-2', 'a', '  dev  ', 'a'.repeat(40)]) {
      assert.strictEqual(validateWorkshopName(name), undefined, name);
    }
  });

  test('reports the design messages', () => {
    assert.strictEqual(validateWorkshopName(''), NAME_EMPTY_MESSAGE);
    assert.strictEqual(validateWorkshopName('   '), NAME_EMPTY_MESSAGE);
    for (const name of ['My Dev', '-dev', 'dev--x', 'Dev', 'dev-', '1dev']) {
      assert.strictEqual(validateWorkshopName(name), NAME_PATTERN_MESSAGE, name);
    }
    assert.strictEqual(validateWorkshopName('a'.repeat(41)), NAME_TOO_LONG_MESSAGE);
    assert.strictEqual(NAME_TOO_LONG_MESSAGE, 'Name is too long (max 40).');
  });
});
