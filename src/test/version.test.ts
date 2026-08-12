import * as assert from 'assert';

import {
  MIN_WORKSHOP_VERSION,
  assertWorkshopVersionCompatible,
  compareVersions,
  getDaemonVersion,
  isWorkshopVersionCompatible,
  WorkshopIncompatibleError,
} from '../version';
import { WorkshopApiError, WorkshopClient, WorkshopUnavailableError } from '../api/client';

function fakeClient(version: string | undefined, statusCode = 200): Pick<WorkshopClient, 'systemInfo'> {
  return {
    systemInfo: version === undefined
      ? () => Promise.reject(new WorkshopApiError('not found', statusCode))
      : async () => ({ version }),
  } as Pick<WorkshopClient, 'systemInfo'>;
}

function fakeLog(): { debug: (m: string) => void; warn: (m: string) => void; messages: { level: string; message: string }[] } {
  const messages: { level: string; message: string }[] = [];
  return {
    messages,
    debug: (m) => messages.push({ level: 'debug', message: m }),
    warn: (m) => messages.push({ level: 'warn', message: m }),
  };
}

suite('compareVersions', () => {
  test('orders by major, minor, then patch', () => {
    assert.ok(compareVersions('0.9.5', '0.9.4') > 0);
    assert.ok(compareVersions('0.9.5', '0.10.0') < 0);
    assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
    assert.strictEqual(compareVersions('0.9.5', '0.9.5'), 0);
  });

  test('treats missing components as zero', () => {
    assert.strictEqual(compareVersions('1', '1.0.0'), 0);
    assert.ok(compareVersions('1.1', '1.0.9') > 0);
  });
});

suite('isWorkshopVersionCompatible', () => {
  test('accepts the minimum version and newer', () => {
    assert.ok(isWorkshopVersionCompatible(MIN_WORKSHOP_VERSION));
    assert.ok(isWorkshopVersionCompatible('0.10.0'));
    assert.ok(isWorkshopVersionCompatible('1.2.3'));
  });

  test('rejects older versions', () => {
    assert.ok(!isWorkshopVersionCompatible('0.9.4'));
    assert.ok(!isWorkshopVersionCompatible('0.8.0'));
  });
});

suite('getDaemonVersion', () => {
  test('returns the version from system-info', async () => {
    assert.strictEqual(await getDaemonVersion(fakeClient('1.2.3') as WorkshopClient), '1.2.3');
  });

  test('logs the version when present', async () => {
    const log = fakeLog();
    await getDaemonVersion(fakeClient('1.2.3') as WorkshopClient, log);
    assert.deepStrictEqual(log.messages, [{ level: 'debug', message: 'Workshop daemon version: 1.2.3' }]);
  });

  test('returns undefined for an empty version string', async () => {
    assert.strictEqual(await getDaemonVersion(fakeClient('') as WorkshopClient), undefined);
  });

  test('throws WorkshopIncompatibleError and logs debug when endpoint is not found', async () => {
    const log = fakeLog();
    await assert.rejects(
      () => getDaemonVersion(fakeClient(undefined, 404) as WorkshopClient, log),
      (err) => err instanceof WorkshopIncompatibleError,
    );
    assert.strictEqual(log.messages.length, 1);
    assert.strictEqual(log.messages[0].level, 'debug');
    assert.ok(log.messages[0].message.includes('predates version reporting'));
  });

  test('returns undefined and logs warn for unexpected API errors', async () => {
    const log = fakeLog();
    const result = await getDaemonVersion(fakeClient(undefined, 500) as WorkshopClient, log);
    assert.strictEqual(result, undefined);
    assert.strictEqual(log.messages.length, 1);
    assert.strictEqual(log.messages[0].level, 'warn');
  });

  test('re-throws WorkshopUnavailableError so unavailability is surfaced normally', async () => {
    const client = {
      systemInfo: () => Promise.reject(new WorkshopUnavailableError('socket missing', 'ENOENT')),
    } as Pick<WorkshopClient, 'systemInfo'>;
    await assert.rejects(
      () => getDaemonVersion(client as WorkshopClient),
      (err) => err instanceof WorkshopUnavailableError,
    );
  });
});

suite('assertWorkshopVersionCompatible', () => {
  test('resolves when the version meets the minimum', async () => {
    await assertWorkshopVersionCompatible(fakeClient(MIN_WORKSHOP_VERSION) as WorkshopClient);
  });

  test('throws WorkshopIncompatibleError when the endpoint is absent (old daemon)', async () => {
    await assert.rejects(
      () => assertWorkshopVersionCompatible(fakeClient(undefined, 404) as WorkshopClient),
      (err) => err instanceof WorkshopIncompatibleError,
    );
  });

  test('throws WorkshopIncompatibleError for an unsupported version', async () => {
    await assert.rejects(
      () => assertWorkshopVersionCompatible(fakeClient('0.9.4') as WorkshopClient),
      /requires Workshop 0\.9\.5 or later.*0\.9\.4 is installed/s,
    );
  });

  test('re-throws WorkshopUnavailableError', async () => {
    const client = {
      systemInfo: () => Promise.reject(new WorkshopUnavailableError('socket missing', 'ENOENT')),
    } as Pick<WorkshopClient, 'systemInfo'>;
    await assert.rejects(
      () => assertWorkshopVersionCompatible(client as WorkshopClient),
      (err) => err instanceof WorkshopUnavailableError,
    );
  });
});
