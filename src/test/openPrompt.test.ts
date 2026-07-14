import * as assert from 'assert';
import { createOpenPrompt, pickWorkshop } from '../ui/openPrompt';
import { Workshop } from '../api/workshops';

function makeWorkshop(name: string, definitionPath: string): Workshop {
  return { name, status: 'Off', definitionPath, projectId: 'proj-1' };
}

// ---------------------------------------------------------------------------
// pickWorkshop — pure logic, no VS Code UI
// ---------------------------------------------------------------------------

suite('pickWorkshop', () => {
  test('returns undefined for an empty list', async () => {
    // We can't call the real showQuickPick in a headless test, but pickWorkshop
    // short-circuits before reaching it when the list is empty.
    const result = await pickWorkshop([]);
    assert.strictEqual(result, undefined);
  });

  test('returns the only workshop without showing a picker', async () => {
    const w = makeWorkshop('dev', '/repo/workshop.yaml');
    const result = await pickWorkshop([w]);
    assert.strictEqual(result, w);
  });
});

// ---------------------------------------------------------------------------
// createOpenPrompt — injectable deps keep VS Code out of the hot path
// ---------------------------------------------------------------------------

suite('createOpenPrompt', () => {
  function makeShowMessage(answer: string | undefined) {
    return async (_msg: string, ..._items: string[]) => answer;
  }

  function makeNoPickNeeded(): (ws: Workshop[]) => Promise<Workshop | undefined> {
    return async () => { throw new Error('pickWorkshop should not be called'); };
  }

  test('returns false and shows nothing when there are no definitions', async () => {
    const workshops: Workshop[] = [
      { name: 'x', status: 'Off', projectId: 'proj-1' }, // no definitionPath
    ];
    let shown = false;
    const result = await createOpenPrompt({
      workshops,
      reopen: async () => { shown = true; },
      showMessage: async () => { throw new Error('should not be called'); },
    });

    assert.strictEqual(result, false);
    assert.strictEqual(shown, false);
  });

  test('returns true and does not reopen when user picks "Not now"', async () => {
    const workshops = [makeWorkshop('dev', '/repo/workshop.yaml')];
    let reopened = false;

    const result = await createOpenPrompt({
      workshops,
      reopen: async () => { reopened = true; },
      showMessage: makeShowMessage('Not now'),
      pick: makeNoPickNeeded(),
    });

    assert.strictEqual(result, true);
    assert.strictEqual(reopened, false);
  });

  test('returns true and does not reopen when user dismisses the message', async () => {
    const workshops = [makeWorkshop('dev', '/repo/workshop.yaml')];
    let reopened = false;

    const result = await createOpenPrompt({
      workshops,
      reopen: async () => { reopened = true; },
      showMessage: makeShowMessage(undefined),
      pick: makeNoPickNeeded(),
    });

    assert.strictEqual(result, true);
    assert.strictEqual(reopened, false);
  });

  test('calls reopen with the single workshop when user clicks "Reopen in Workshop"', async () => {
    const w = makeWorkshop('dev', '/repo/workshop.yaml');
    const reopened: Workshop[] = [];

    await createOpenPrompt({
      workshops: [w],
      reopen: async (chosen) => { reopened.push(chosen); },
      showMessage: makeShowMessage('Reopen in Workshop'),
      pick: async (ws) => ws[0], // auto-select first
    });

    assert.strictEqual(reopened.length, 1);
    assert.strictEqual(reopened[0].name, 'dev');
  });

  test('passes all candidates to pick and reopens the chosen one', async () => {
    const w1 = makeWorkshop('alpha', '/repo/.workshop/alpha.yaml');
    const w2 = makeWorkshop('beta', '/repo/.workshop/beta.yaml');
    const reopened: Workshop[] = [];

    await createOpenPrompt({
      workshops: [w1, w2],
      reopen: async (chosen) => { reopened.push(chosen); },
      showMessage: makeShowMessage('Reopen in Workshop'),
      pick: async (ws) => {
        assert.strictEqual(ws.length, 2);
        return ws[1]; // user picks 'beta'
      },
    });

    assert.strictEqual(reopened.length, 1);
    assert.strictEqual(reopened[0].name, 'beta');
  });

  test('does not call reopen when pick returns undefined (user dismisses quick pick)', async () => {
    const workshops = [
      makeWorkshop('alpha', '/repo/.workshop/alpha.yaml'),
      makeWorkshop('beta', '/repo/.workshop/beta.yaml'),
    ];
    let reopened = false;

    const result = await createOpenPrompt({
      workshops,
      reopen: async () => { reopened = true; },
      showMessage: makeShowMessage('Reopen in Workshop'),
      pick: async () => undefined,
    });

    assert.strictEqual(result, true);
    assert.strictEqual(reopened, false);
  });

  test('filters out workshops without a definitionPath', async () => {
    // The running workshop (no definitionPath) should not be offered.
    const running: Workshop = { name: 'ci', status: 'On', rawStatus: 'ready', hostname: 'ci.wp', projectId: 'proj-1' };
    const defined = makeWorkshop('dev', '/repo/workshop.yaml');

    const passed: Workshop[][] = [];
    await createOpenPrompt({
      workshops: [running, defined],
      reopen: async () => { /* noop */ },
      showMessage: makeShowMessage('Reopen in Workshop'),
      pick: async (ws) => { passed.push(ws); return ws[0]; },
    });

    assert.strictEqual(passed.length, 1);
    assert.strictEqual(passed[0].length, 1);
    assert.strictEqual(passed[0][0].name, 'dev');
  });
});
