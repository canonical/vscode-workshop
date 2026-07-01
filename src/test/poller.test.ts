import * as assert from 'assert';
import { WorkshopPoller } from '../poller';

suite('WorkshopPoller', () => {
  test('fires onDidUpdate on first poll', async () => {
    const poller = new WorkshopPoller(() => Promise.resolve([1, 2, 3]), 50_000);
    const updates: number[][] = [];
    poller.onDidUpdate((v) => updates.push(v));

    await poller.poll();

    assert.deepStrictEqual(updates, [[1, 2, 3]]);
    poller.dispose();
  });

  test('does not fire onDidUpdate when result is unchanged', async () => {
    const poller = new WorkshopPoller(() => Promise.resolve(['same']), 50_000);
    const updates: string[][] = [];
    poller.onDidUpdate((v) => updates.push(v));

    await poller.poll();
    await poller.poll();
    await poller.poll();

    assert.strictEqual(updates.length, 1);
    poller.dispose();
  });

  test('fires onDidUpdate again when result changes', async () => {
    let counter = 0;
    const poller = new WorkshopPoller(() => Promise.resolve(counter++), 50_000);
    const updates: number[] = [];
    poller.onDidUpdate((v) => updates.push(v));

    await poller.poll();
    await poller.poll();
    await poller.poll();

    assert.deepStrictEqual(updates, [0, 1, 2]);
    poller.dispose();
  });

  test('fires onDidError when fn rejects', async () => {
    const boom = new Error('daemon down');
    const poller = new WorkshopPoller(() => Promise.reject(boom), 50_000);
    const errors: Error[] = [];
    poller.onDidError((e) => errors.push(e));

    await poller.poll();

    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].message, 'daemon down');
    poller.dispose();
  });

  test('does not fire onDidUpdate when fn rejects', async () => {
    const poller = new WorkshopPoller(() => Promise.reject(new Error('err')), 50_000);
    const updates: unknown[] = [];
    poller.onDidUpdate((v) => updates.push(v));
    poller.onDidError(() => { /* ignore */ });

    await poller.poll();

    assert.deepStrictEqual(updates, []);
    poller.dispose();
  });

  test('timer starts on first activate and triggers a tick', async () => {
    let calls = 0;
    const poller = new WorkshopPoller(async () => ++calls, 20);
    const updates: number[] = [];
    poller.onDidUpdate((v) => updates.push(v));

    const handle = poller.activate();
    // Wait for at least 2 ticks (immediate + one interval tick).
    await new Promise<void>((r) => setTimeout(r, 60));

    assert.ok(updates.length >= 2, `Expected >=2 updates, got ${updates.length}`);
    handle.dispose();
    poller.dispose();
  });

  test('timer stops when the last handle is disposed', async () => {
    let calls = 0;
    const poller = new WorkshopPoller(async () => ++calls, 20);
    poller.onDidUpdate(() => { /* ignore */ });

    const handle = poller.activate();
    await new Promise<void>((r) => setTimeout(r, 60));
    const callsAtStop = calls;
    handle.dispose();

    // No more calls after dispose.
    await new Promise<void>((r) => setTimeout(r, 60));
    assert.strictEqual(calls, callsAtStop);
    poller.dispose();
  });

  test('multiple handles: timer only stops when all are disposed', async () => {
    let calls = 0;
    const poller = new WorkshopPoller(async () => ++calls, 20);
    poller.onDidUpdate(() => { /* ignore */ });

    const h1 = poller.activate();
    const h2 = poller.activate();

    await new Promise<void>((r) => setTimeout(r, 60));
    h1.dispose();

    const callsAfterFirst = calls;
    await new Promise<void>((r) => setTimeout(r, 60));
    // Timer still running after only h1 is disposed.
    assert.ok(calls > callsAfterFirst, 'Expected polling to continue after first handle disposed');

    h2.dispose();
    const callsAfterAll = calls;
    await new Promise<void>((r) => setTimeout(r, 60));
    assert.strictEqual(calls, callsAfterAll, 'Expected polling to stop after last handle disposed');

    poller.dispose();
  });

  test('dispose stops the timer', async () => {
    let calls = 0;
    const poller = new WorkshopPoller(async () => ++calls, 20);
    poller.onDidUpdate(() => { /* ignore */ });

    poller.activate();
    await new Promise<void>((r) => setTimeout(r, 60));
    const callsAtDispose = calls;
    poller.dispose();

    await new Promise<void>((r) => setTimeout(r, 60));
    assert.strictEqual(calls, callsAtDispose);
  });
});
