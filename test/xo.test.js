// -----------------------------------------------------------------------------
// The client of the REST API: the pinned TLS connection, the answers of XO
// (envelope, errors, sizes) and the strict parsers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certs } from './kit/certs.mjs';
import { TOKEN, fakeXo, uuid } from './helpers/fakeXo.js';
import {
  XoError,
  cleanName,
  collectionOf,
  createXo,
  hostOf,
  logOf,
  parseAnswer,
  readFingerprint,
  srOf,
  statsOf,
  vmOf,
} from '../src/xo.js';
import { within } from './helpers/setup.js';

async function server(t, options) {
  const xo = await fakeXo(options);
  t.after(() => xo.close());
  return xo;
}

test('another certificate than the pinned one: refused at the handshake, nothing written', async (t) => {
  const xo = await server(t, { cert: certs.impostor });
  const client = createXo({
    host: '127.0.0.1',
    port: xo.port,
    pin: certs.device.fingerprint256,
    token: TOKEN,
  });
  const err = await within(
    client.vms().catch((e) => e),
    'vms',
  );
  assert.equal(err.kind, 'pin');
  assert.equal(err.sent, false);
  assert.equal(err.fingerprint, certs.impostor.fingerprint256);
  assert.equal(xo.requests.length, 0);
});

test('no pin: refused before any connection', async (t) => {
  const xo = await server(t);
  const client = createXo({ host: '127.0.0.1', port: xo.port, pin: undefined, token: TOKEN });
  const err = await client.vms().catch((e) => e);
  assert.equal(err.kind, 'nopin');
  assert.equal(xo.requests.length, 0);
});

test('readFingerprint: a bare handshake, nothing sent', async (t) => {
  const xo = await server(t);
  const fp = await within(readFingerprint({ host: '127.0.0.1', port: xo.port }), 'fp');
  assert.equal(fp, xo.fingerprint);
  assert.equal(xo.requests.length, 0);
});

test('beforeSend can cancel at the last moment: nothing written', async (t) => {
  const xo = await server(t);
  const client = createXo({ host: '127.0.0.1', port: xo.port, pin: xo.fingerprint, token: TOKEN });
  const err = await within(
    client
      .action(uuid(2), 'start', {
        beforeSend: () => {
          throw new XoError('cancelled', 'no');
        },
      })
      .catch((e) => e),
    'action',
  );
  assert.equal(err.kind, 'cancelled');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(xo.requests.length, 0);
});

test('a frozen answer (no byte for 2 s) is cut', async (t) => {
  const xo = await server(t, { replyFor: () => 'silent' });
  const client = createXo({ host: '127.0.0.1', port: xo.port, pin: xo.fingerprint, token: TOKEN });
  const started = performance.now();
  const err = await within(
    client.vms({ timeout: 8000 }).catch((e) => e),
    'vms',
  );
  assert.equal(err.kind, 'timeout');
  assert.equal(err.sent, true);
  assert.equal(err.answered, false);
  assert.ok(performance.now() - started < 3000);
});

test('the errors of XO: 401 in its envelope (refusal material) or not (a proxy)', () => {
  const xo = (status, body) => {
    try {
      parseAnswer({ status, headers: {}, body: JSON.stringify(body) });
    } catch (err) {
      return err;
    }
    return undefined;
  };
  assert.deepEqual(
    [xo(401, { error: 'invalid credentials' }).kind, xo(401, { error: 'x' }).xo],
    ['unauth', true],
  );
  const proxy = (() => {
    try {
      parseAnswer({ status: 401, headers: {}, body: '<html>' });
    } catch (err) {
      return err;
    }
  })();
  assert.equal(proxy.xo, false);
  assert.equal(xo(403, {}).kind, 'forbidden');
  assert.equal(xo(404, { error: 'no such VM' }).kind, 'notfound');
  assert.equal(xo(307, {}).kind, 'redirect');
  assert.equal(xo(500, { error: 'VM_BAD_POWER_STATE' }).kind, 'server');
  assert.equal(xo(422, { error: 'halted' }).kind, 'refused');
  const rate = xo(429, {});
  assert.equal(rate.kind, 'rate');
  const r2 = (() => {
    try {
      parseAnswer({ status: 429, headers: { 'retry-after': '90' }, body: '' });
    } catch (e) {
      return e;
    }
  })();
  assert.equal(r2.retryAfter, 90_000);
  const reason = xo(400, { error: `bad ${TOKEN} here` });
  assert.ok(!reason.message.includes(TOKEN), 'a token in an error is never repeated');
});

test('a collection must be an array of objects with the href of their kind', () => {
  assert.throws(() => collectionOf({}, 'vms', 10), /not an answer/);
  assert.throws(() => collectionOf([{ id: 1 }], 'vms', 10), /not an answer/);
  assert.throws(() => collectionOf([{ href: '/rest/v0/hosts/x' }], 'vms', 10), /not an answer/);
  assert.deepEqual(collectionOf([], 'vms', 10), { items: [], overflow: false });
  const two = [{ href: '/rest/v0/vms/a' }, { href: '/rest/v0/vms/b' }];
  assert.equal(collectionOf(two, 'vms', 1).overflow, true);
});

test('vmOf: strict values; unknown stays unknown, never 0', () => {
  assert.equal(vmOf({ id: 'not-a-uuid' }), undefined);
  const v = vmOf({ id: uuid(1).toUpperCase(), power_state: 'Running', memory: { size: '1' } });
  assert.equal(v.uuid, uuid(1));
  assert.equal(v.memorySize, undefined);
  assert.equal(vmOf({ id: uuid(1), power_state: 'running' }).power, undefined);
  assert.equal(vmOf({ id: uuid(1), current_operations: { a: 'x' } }).busy, true);
  assert.equal(vmOf({ id: uuid(1) }).busy, undefined);
});

test('hostOf, srOf: percentages only from coherent numbers; ISO and removable left out', () => {
  assert.equal(hostOf({ id: uuid(1), memory: { usage: 5, size: 0 } }).memoryUsage, undefined);
  assert.equal(hostOf({ id: uuid(1), memory: { usage: 50, size: 100 } }).memoryUsage, 50);
  assert.equal(srOf({ id: uuid(1), SR_type: 'iso' }), null);
  assert.equal(srOf({ id: uuid(1), SR_type: 'udev' }), null);
  const sr = srOf({ id: uuid(1), SR_type: 'lvm', size: 100, physical_usage: 120 });
  assert.equal(sr.usage, undefined, 'used beyond the size is not a measure');
  assert.equal(srOf({ id: uuid(1), size: 0, physical_usage: 0 }).usage, undefined);
});

test('logOf: a run needs its job, an id and a start; an end before its start is dropped', () => {
  assert.equal(logOf({ id: '1', jobId: 'x', start: 1 }), undefined);
  assert.equal(logOf({ id: '../1', jobId: uuid(1), start: 1 }), undefined);
  assert.equal(logOf({ id: '1', jobId: uuid(1), start: 10, end: 5 }).end, undefined);
  assert.equal(logOf({ id: '1', jobId: uuid(1), start: 10, status: 'weird' }).status, undefined);
});

test('statsOf: the newest samples, gaps skipped, nonsense refused', () => {
  const s = statsOf({
    endTimestamp: 100,
    stats: { cpus: { 0: [0.5, null], 1: [0.1, 0.3] }, memory: [100], memoryFree: [25] },
  });
  assert.deepEqual(s, { cpu: 40, memory: 75, at: 100_000 });
  assert.equal(statsOf({ stats: { cpus: { 0: [2] } } }).cpu, undefined);
  assert.equal(statsOf({ stats: { memory: [100], memoryFree: [200] } }).memory, undefined);
  assert.throws(() => statsOf([]), /not statistics/);
});

test('cleanName: no control nor direction override, 64 characters at most', () => {
  assert.equal(cleanName('a‮b\u0000c'), 'ab c');
  assert.equal(cleanName('   '), undefined);
  assert.equal([...cleanName('é'.repeat(100))].length, 64);
  assert.equal(cleanName(42), undefined);
});

test('an oversized answer without Content-Length (chunked) is cut while it streams', async (t) => {
  const xo = await server(t, {
    replyFor: () => ({
      status: 200,
      body: 'x'.repeat(300 * 1024),
      headers: { 'transfer-encoding': 'chunked' },
    }),
  });
  const client = createXo({ host: '127.0.0.1', port: xo.port, pin: xo.fingerprint, token: TOKEN });
  const err = await within(
    client.vm(uuid(1)).catch((e) => e),
    'vm',
  );
  assert.equal(err.kind, 'size');
});
