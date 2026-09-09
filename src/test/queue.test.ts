import * as assert from 'assert';

import { WorkshopOperationQueue } from '../interfaces/queue';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

suite('WorkshopOperationQueue', () => {
  test('operations on one workshop run strictly one at a time, in call order', async () => {
    const queue = new WorkshopOperationQueue();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const op = (name: string) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${name}`);
      await new Promise<void>((r) => setTimeout(r, 5));
      events.push(`end:${name}`);
      active -= 1;
    };

    await Promise.all([
      queue.run('p1', 'dev', op('a')),
      queue.run('p1', 'dev', op('b')),
      queue.run('p1', 'dev', op('c')),
    ]);

    assert.strictEqual(maxActive, 1, 'the daemon never sees more than one change in flight');
    assert.deepStrictEqual(events, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  test('a rejected operation propagates to its caller but never breaks the chain', async () => {
    const queue = new WorkshopOperationQueue();
    const ran: string[] = [];

    const first = queue.run('p1', 'dev', async () => {
      throw new Error('boom');
    });
    const second = queue.run('p1', 'dev', async () => {
      ran.push('second');
    });

    await assert.rejects(() => first, /boom/);
    await second;
    assert.deepStrictEqual(ran, ['second']);
  });

  test('different workshops queue independently', async () => {
    const queue = new WorkshopOperationQueue();
    const blockerA = deferred<void>();
    let bRan = false;

    const a = queue.run('p1', 'dev', () => blockerA.promise);
    const b = queue.run('p1', 'other', async () => {
      bRan = true;
    });

    await b;
    assert.ok(bRan, 'the other workshop was not blocked behind dev');
    blockerA.resolve();
    await a;
  });
});
