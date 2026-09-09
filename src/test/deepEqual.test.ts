import * as assert from 'assert';

import { deepEqual } from '../util/deepEqual';

suite('deepEqual', () => {
  test('primitives', () => {
    assert.ok(deepEqual(1, 1));
    assert.ok(deepEqual('a', 'a'));
    assert.ok(deepEqual(null, null));
    assert.ok(deepEqual(undefined, undefined));
    assert.ok(deepEqual(NaN, NaN));
    assert.ok(!deepEqual(1, 2));
    assert.ok(!deepEqual(1, '1'));
    assert.ok(!deepEqual(null, undefined));
    assert.ok(!deepEqual(0, null));
    assert.ok(!deepEqual({}, null));
  });

  test('arrays compare element-wise in order', () => {
    assert.ok(deepEqual([1, 2, 3], [1, 2, 3]));
    assert.ok(!deepEqual([1, 2, 3], [1, 2]));
    assert.ok(!deepEqual([1, 2, 3], [3, 2, 1]));
    assert.ok(!deepEqual([1, 2], { 0: 1, 1: 2, length: 2 }));
  });

  test('objects compare structurally regardless of key order', () => {
    assert.ok(deepEqual({ a: 1, b: { c: [2] } }, { b: { c: [2] }, a: 1 }));
    assert.ok(!deepEqual({ a: 1 }, { a: 1, b: 2 }));
    assert.ok(!deepEqual({ a: { b: 1 } }, { a: { b: 2 } }));
  });

  test('keys with undefined values are ignored (JSON round-trip parity)', () => {
    assert.ok(deepEqual({ a: 1, b: undefined }, { a: 1 }));
    assert.ok(deepEqual({ a: 1 }, { a: 1, b: undefined }));
    assert.ok(!deepEqual({ a: 1, b: null }, { a: 1 }));
  });

  test('nested daemon-shaped payloads', () => {
    const a = {
      workshops: [{ name: 'web', status: 'On', sdks: [{ name: 'python' }] }],
      files: [],
    };
    const b = {
      workshops: [{ name: 'web', status: 'On', sdks: [{ name: 'python' }] }],
      files: [],
    };
    assert.ok(deepEqual(a, b));
    b.workshops[0].sdks[0].name = 'node';
    assert.ok(!deepEqual(a, b));
  });
});
