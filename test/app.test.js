// -----------------------------------------------------------------------------
// Reading Xen Orchestra: Discovery, states, freshness, secondary reads, the
// token refused, pauses, /data, the configuration lifecycle, secrets.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { TOKEN, uuid, vm } from './helpers/fakeXo.js';
import { idle, online, pause, setup, stateOf, statusText, until, within } from './helpers/setup.js';

const DAY = 24 * 3_600_000;

test('first read: Discovery of hosts, VMs, storages (ISO left out), backup jobs; states', async (t) => {
  const ctx = await online(t);
  const found = ctx.gladys.fake.discoveredDevices.map((d) =>
    d.external_id.split(':').slice(2, 4).join(':'),
  );
  assert.deepEqual(found.sort(), [
    `xo-backup:${uuid(301)}`,
    `xo-host:${uuid(101)}`,
    `xo-sr:${uuid(201)}`,
    `xo-vm:${uuid(1)}`,
    `xo-vm:${uuid(2)}`,
  ]);
  assert.equal(stateOf(ctx, 'vm', 1, 'running'), 1);
  assert.equal(stateOf(ctx, 'vm', 2, 'running'), 0);
  assert.equal(stateOf(ctx, 'vm', 1, 'power_state'), 'Running');
  assert.equal(stateOf(ctx, 'vm', 2, 'power_state'), 'Halted');
  assert.equal(stateOf(ctx, 'vm', 1, 'memory_size'), 2048);
  assert.equal(stateOf(ctx, 'vm', 1, 'cpu_usage'), 50);
  assert.equal(stateOf(ctx, 'vm', 1, 'memory_usage'), 75);
  assert.equal(stateOf(ctx, 'vm', 2, 'cpu_usage'), undefined, 'a halted VM has no sample');
  assert.equal(stateOf(ctx, 'host', 101, 'running'), 1);
  assert.equal(stateOf(ctx, 'host', 101, 'memory_usage'), 25);
  assert.equal(stateOf(ctx, 'sr', 201, 'usage'), 25);
  assert.equal(stateOf(ctx, 'sr', 201, 'free'), 375);
  assert.equal(stateOf(ctx, 'sr', 201, 'size'), 500);
  assert.match(statusText(ctx), /Connected: 1 host\(s\), 2 VM\(s\) \(1 running\), 1 storage/);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  // Every request carried the token in the cookie, and only there.
  for (const r of ctx.xo.requests) assert.equal(r.token, TOKEN);
});

test('backup runs: last status, success and hours since the last success, by the time of XO', async (t) => {
  const now = Date.now();
  const ctx = await online(t, {
    server: {
      logs: [
        {
          id: '1',
          jobId: uuid(301),
          status: 'success',
          start: now - 30 * 3_600_000,
          end: now - 29 * 3_600_000,
        },
        {
          id: '2',
          jobId: uuid(301),
          status: 'failure',
          start: now - 5 * 3_600_000,
          end: now - 4 * 3_600_000,
        },
        {
          id: '3',
          jobId: uuid(301),
          status: 'success',
          start: now - 10 * DAY,
          end: now - 10 * DAY + 1000,
        },
      ],
    },
  });
  assert.equal(stateOf(ctx, 'backup', 301, 'last_ok'), 0);
  assert.equal(stateOf(ctx, 'backup', 301, 'last_status'), 'Failure');
  const age = stateOf(ctx, 'backup', 301, 'last_success_age');
  assert.ok(age >= 28.9 && age <= 29.2, `age ${age}`);
  const logs = ctx.xo.requests.find((r) => r.path === '/rest/v0/backup-logs');
  assert.match(logs.query.filter, /^start:>\d+$/);
  const since = Number(logs.query.filter.slice(7));
  assert.ok(Math.abs(now - 8 * DAY - since) < 120_000, 'an 8-day window by the Date of XO');
});

test('a running backup shows "Running" without changing the last result', async (t) => {
  const now = Date.now();
  const ctx = await online(t, {
    server: {
      logs: [
        {
          id: '1',
          jobId: uuid(301),
          status: 'success',
          start: now - 3_600_000,
          end: now - 3_000_000,
        },
        { id: '2', jobId: uuid(301), status: 'pending', start: now - 60_000 },
      ],
    },
  });
  assert.equal(stateOf(ctx, 'backup', 301, 'last_status'), 'Running');
  assert.equal(stateOf(ctx, 'backup', 301, 'last_ok'), 1);
});

test('statistics older than 5 min by the Date of XO are not published', async (t) => {
  const ctx = await online(t, {
    server: {
      stats: { [uuid(1)]: { cpus: [50], memory: 1e9, memoryFree: 5e8, ageMs: 10 * 60_000 } },
    },
  });
  assert.equal(stateOf(ctx, 'vm', 1, 'cpu_usage'), undefined);
  assert.equal(stateOf(ctx, 'vm', 1, 'memory_usage'), undefined);
});

test('without guest tools (no memoryFree): the memory used stays unknown, never 0', async (t) => {
  const ctx = await online(t, {
    server: { stats: { [uuid(1)]: { cpus: [20, 40], memory: 1e9, memoryFree: undefined } } },
  });
  assert.equal(stateOf(ctx, 'vm', 1, 'cpu_usage'), 30);
  assert.equal(stateOf(ctx, 'vm', 1, 'memory_usage'), undefined);
});

test('a secondary read failing (5xx on stats, 403 on backups) never stops the VM reads', async (t) => {
  const ctx = await setup(t);
  ctx.xo.replyFor = (r) => {
    if (r.path.endsWith('/stats')) return { status: 500, body: { error: 'XENAPI error' } };
    if (r.path.startsWith('/rest/v0/backup')) return { status: 403, body: { error: 'forbidden' } };
    if (r.path === '/rest/v0/hosts') return { status: 401, body: { error: 'invalid credentials' } };
    return undefined;
  };
  await until(ctx, () => ctx.app.online, 'online');
  await idle(ctx);
  assert.equal(stateOf(ctx, 'vm', 1, 'running'), 1);
  assert.equal(ctx.app.blocked, false, 'a 401 on a secondary route is never a refusal');
  assert.equal(ctx.app.paused(), false, 'a 5xx of one VM statistics pauses nothing');
  assert.equal(stateOf(ctx, 'host', 101, 'running'), undefined);
  assert.equal(stateOf(ctx, 'backup', 301, 'last_ok'), undefined);
  // Held: not asked again at the next read.
  const before = ctx.xo.count('GET /rest/v0/backup-jobs');
  await until(
    ctx,
    () => ctx.xo.requests.filter((r) => r.path === '/rest/v0/vms').length >= 2,
    'second read',
    {
      step: 10_000,
    },
  );
  await idle(ctx);
  assert.equal(ctx.xo.count('GET /rest/v0/backup-jobs'), before);
});

test('the token refused (401 of XO on the VM list): kept in /data as a mark, never tried alone', async (t) => {
  const ctx = await setup(t, { server: { tokens: new Map() } });
  await until(ctx, () => ctx.app.blocked, 'refused');
  assert.match(statusText(ctx), /refused the token/);
  const mark = ctx.store.data.refused;
  assert.ok(Number.isInteger(mark.mark) && mark.mark < 65536);
  assert.doesNotMatch(JSON.stringify(ctx.store.data), new RegExp(TOKEN));
  const asked = ctx.xo.requests.length;
  await ctx.clock.advance(3_600_000);
  await ctx.clock.advance(3_600_000);
  assert.equal(ctx.xo.requests.length, asked, 'nothing asked while refused');
  // After a restart too.
  const again = await setup(t, {
    connect: false,
    store: memoryStore(ctx.store.data),
    server: { tokens: new Map() },
  });
  again.store.data.pins = { [again.xo.address]: again.xo.fingerprint };
  again.store.data.refused.address = again.xo.address;
  await within(again.gladys.connect(), 'connect');
  await again.clock.advance(1000);
  assert.equal(again.app.blocked, true);
  assert.equal(again.xo.requests.length, 0);
});

test('a refused token is lifted by a new token saved (read at once)', async (t) => {
  const ctx = await setup(t, { server: { tokens: new Map() } });
  await until(ctx, () => ctx.app.blocked, 'refused');
  const fresh = 'AnotherValidTokenForTheTests_0123456789abcd';
  ctx.xo.tokens.set(fresh, { created_at: Date.now(), expiration: Date.now() + 30 * DAY });
  await within(ctx.gladys.fake.configUpdated({ ...ctx.raw, token: fresh }), 'config');
  await until(ctx, () => ctx.app.online, 'online', { step: 10 });
  assert.equal(ctx.app.blocked, false);
});

test('the Test button tries a refused token again; accepted: reads start again', async (t) => {
  const ctx = await setup(t, { server: { tokens: new Map() } });
  await until(ctx, () => ctx.app.blocked, 'refused');
  ctx.xo.tokens.set(TOKEN, { created_at: Date.now(), expiration: Date.now() + 30 * DAY });
  const res = await within(ctx.gladys.fake.action('test_connection'), 'test');
  assert.match(JSON.stringify(res), /token accepted/);
  await until(ctx, () => ctx.app.online && !ctx.app.blocked, 'online', { step: 10 });
});

test('a 401 without the envelope of XO (a proxy) is not a refusal', async (t) => {
  const ctx = await setup(t);
  ctx.xo.replyFor = () => ({ status: 401, body: 'Unauthorized' });
  await until(ctx, () => ctx.app.lastError, 'failed');
  assert.equal(ctx.app.blocked, false);
  assert.equal(ctx.store.data.refused, null);
});

test('429 pauses every read (Retry-After honoured, bounded, kept in /data)', async (t) => {
  const ctx = await setup(t);
  ctx.xo.replyFor = () => ({
    status: 429,
    body: { error: 'slow down' },
    headers: { 'retry-after': '120' },
  });
  await until(ctx, () => ctx.app.paused(), 'paused');
  assert.ok(ctx.store.data.pausedUntil > ctx.clock.now());
  ctx.xo.replyFor = undefined;
  const asked = ctx.xo.requests.length;
  await ctx.clock.advance(100_000);
  assert.equal(ctx.xo.requests.length, asked, 'nothing during the pause');
  await until(ctx, () => ctx.app.online, 'online again', { step: 5000 });
});

test('a 5xx on the VM list pauses (60 s at least)', async (t) => {
  const ctx = await setup(t);
  ctx.xo.replyFor = () => ({ status: 503, body: 'down' });
  await until(ctx, () => ctx.app.paused(), 'paused');
  assert.ok(ctx.app.pauseLeft() >= 59_000);
});

test('never faster than the interval: a restart reads after the last read kept in /data', async (t) => {
  const ctx = await online(t);
  const kept = ctx.store.data;
  assert.ok(Number.isFinite(kept.lastReadAt));
  const again = await setup(t, { connect: false, store: memoryStore({ ...kept }) });
  again.store.data.pins = { [again.xo.address]: again.xo.fingerprint };
  again.clock.advance(0);
  await within(again.gladys.connect(), 'connect');
  await again.clock.advance(5_000);
  await pause(300);
  assert.equal(again.xo.requests.length, 0, 'no read 5 s after the last one');
});

test('the Test button within the interval reads nothing, it says the last result', async (t) => {
  const ctx = await online(t);
  const asked = ctx.xo.requests.length;
  const res = await within(ctx.gladys.fake.action('test_connection'), 'test');
  assert.match(JSON.stringify(res), /next read in/);
  assert.equal(ctx.xo.requests.length, asked);
});

test('getConfig() failing in connected: retried, spaced, without end; then the reads start', async (t) => {
  let fail = 0;
  const ctx = await setup(t, {
    getConfig: async () => {
      if (fail > 0) {
        fail -= 1;
        throw new Error('gladys busy');
      }
      return ctx.raw;
    },
    connect: false,
  });
  await within(ctx.gladys.connect(), 'connect');
  await until(ctx, () => ctx.app.online, 'online');
  // A reconnection (the handler of 'connected') whose getConfig fails twice.
  fail = 2;
  await within(
    ctx.app.connectedWith(() => ctx.gladys.getConfig()),
    'connected',
  );
  assert.match(statusText(ctx), /did not give the configuration: tried again in 5 s/);
  await ctx.clock.advance(5000);
  await until(ctx, () => /tried again in 15 s/.test(statusText(ctx)), 'second failure');
  await until(ctx, () => /Connected/.test(statusText(ctx)), 'back', { step: 5000 });
  assert.equal(fail, 0);
});

test('/data unreadable: no pin learnt, read again every 10 s, then the session starts', async (t) => {
  const store = memoryStore(null);
  store.failLoad = true;
  const ctx = await setup(t, { store, pinned: false });
  await until(ctx, () => ctx.app.memoryState === 'unreadable', 'unreadable');
  assert.match(statusText(ctx), /\/data is unreadable/);
  const res = await within(ctx.gladys.fake.action('trust_certificate'), 'trust');
  assert.match(JSON.stringify(res), /Click again/);
  const second = await within(ctx.gladys.fake.action('trust_certificate'), 'trust 2');
  assert.match(JSON.stringify(second), /could not keep it/);
  store.failLoad = false;
  store.data = { pins: { [ctx.xo.address]: ctx.xo.fingerprint } };
  await until(ctx, () => ctx.app.online, 'online', { step: 10_000 });
});

test('trust in two clicks: the first sends nothing, the second pins and reads', async (t) => {
  const ctx = await setup(t, { pinned: false });
  await ctx.clock.advance(10);
  assert.match(statusText(ctx), /not pinned yet/);
  assert.equal(ctx.xo.requests.length, 0);
  const first = await within(ctx.gladys.fake.action('trust_certificate'), 'trust');
  assert.match(JSON.stringify(first), new RegExp(ctx.xo.fingerprint));
  assert.equal(ctx.xo.requests.length, 0, 'nothing written on the first click');
  await within(ctx.gladys.fake.action('trust_certificate'), 'trust 2');
  assert.equal(ctx.store.data.pins[ctx.xo.address], ctx.xo.fingerprint);
  await until(ctx, () => ctx.app.online, 'online', { step: 10 });
});

test('a device created later gets the values of the last read only while it is recent', async (t) => {
  const ctx = await online(t, { devices: [] });
  assert.equal(ctx.gladys.fake.states.length, 0);
  const { created } = await import('./helpers/setup.js');
  const d = created('vm', uuid(1));
  ctx.gladys.devices.push(d);
  await within(ctx.gladys.fake.deviceCreated(d), 'created');
  assert.equal(stateOf(ctx, 'vm', 1, 'running'), 1);
  // Older than the interval: nothing republished as new.
  const d2 = created('vm', uuid(2));
  ctx.xo.replyFor = () => 'silent';
  await ctx.clock.advance(61_000);
  ctx.gladys.devices.push(d2);
  const count = ctx.gladys.fake.states.length;
  await within(ctx.gladys.fake.deviceCreated(d2), 'created 2');
  assert.equal(ctx.gladys.fake.states.length, count);
});

test('a VM gone from XO: its device shows a degraded badge, nothing published for it', async (t) => {
  const ctx = await online(t);
  ctx.xo.vms = [vm(1)];
  await until(ctx, () => ctx.app.inventory.vms.length === 1, 'second read', { step: 10_000 });
  await idle(ctx);
  const badge = ctx.gladys.fake.transports.findLast((b) => b.device_external_id.endsWith(uuid(2)));
  assert.equal(badge.degraded, true);
});

test('an answer that is not XO (HTML page, object instead of a list) is never an empty list', async (t) => {
  const ctx = await setup(t);
  ctx.xo.replyFor = (r) =>
    r.path === '/rest/v0/vms' ? { status: 200, body: { hello: 1 } } : undefined;
  await until(ctx, () => ctx.app.lastError, 'failed');
  assert.equal(ctx.app.lastError.kind, 'format');
  assert.equal(ctx.app.online, false);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
});

test('an oversized answer is cut before it is read whole', async (t) => {
  const ctx = await setup(t);
  ctx.xo.replyFor = (r) =>
    r.path === '/rest/v0/vms' ? { status: 200, body: 'x'.repeat(1_100_000) } : undefined;
  await until(ctx, () => ctx.app.lastError, 'failed');
  assert.equal(ctx.app.lastError.kind, 'size');
});

test('the token never appears in the logs, /data, the statuses nor the Discovery', async (t) => {
  const ctx = await online(t);
  ctx.xo.replyFor = () => ({ status: 400, body: { error: `bad cookie ${TOKEN}` } });
  await until(ctx, () => ctx.app.lastError, 'failed', { step: 10_000 });
  const everything = JSON.stringify([
    ctx.logs,
    ctx.store.data,
    ctx.gladys.fake.connectionStatuses,
    ctx.gladys.fake.discoveredDevices,
    ctx.gladys.fake.states,
  ]);
  assert.ok(!everything.includes(TOKEN));
});

test('more than 200 VMs: 200 read, the status says the rest is left out', async (t) => {
  const many = Array.from({ length: 205 }, (_, i) => vm(i + 1000, { power_state: 'Halted' }));
  const ctx = await online(t, { server: { vms: many } });
  assert.equal(ctx.app.inventory.vms.length, 200);
  assert.match(statusText(ctx), /left out/);
  const asked = ctx.xo.requests.find((r) => r.path === '/rest/v0/vms');
  assert.equal(asked.query.limit, '201');
});

test('statistics in turn: at most 10 VMs per read, every running VM reached', async (t) => {
  const many = Array.from({ length: 15 }, (_, i) => vm(i + 1));
  const ctx = await online(t, { server: { vms: many } });
  assert.equal(ctx.xo.count('/stats'), 10);
  await until(ctx, () => ctx.xo.count('/stats') >= 20, 'second read', { step: 10_000 });
  const asked = new Set(
    ctx.xo.requests.filter((r) => r.path.endsWith('/stats')).map((r) => r.path),
  );
  assert.equal(asked.size, 15);
});

test('stop() leaves no timer and no request behind', async (t) => {
  const ctx = await online(t);
  await ctx.app.shutdown();
  const asked = ctx.xo.requests.length;
  await ctx.clock.advance(3_600_000);
  assert.equal(ctx.xo.requests.length, asked);
  assert.equal(ctx.app.readTimer, undefined);
});

test('the CPU of a VM is read in percent: 40 % is 40, an idle 0.8 % is 0.8 (never 80)', async (t) => {
  const ctx = await online(t, {
    server: {
      vms: [vm(1), vm(2)],
      stats: {
        [uuid(1)]: { cpus: [40, 40], memory: 1e9, memoryFree: 5e8 },
        [uuid(2)]: { cpus: [0.8], memory: 1e9, memoryFree: 5e8 },
      },
    },
  });
  assert.equal(stateOf(ctx, 'vm', 1, 'cpu_usage'), 40);
  assert.equal(stateOf(ctx, 'vm', 2, 'cpu_usage'), 0.8);
});

test('a host not running: its memory used is not published (unknown, not 0 %)', async (t) => {
  const ctx = await online(t, {
    server: {
      hosts: [
        {
          id: uuid(101),
          name_label: 'xcp-1',
          power_state: 'Halted',
          memory: { usage: 0, size: 32e9 },
        },
      ],
    },
  });
  assert.equal(stateOf(ctx, 'host', 101, 'running'), 0);
  assert.equal(stateOf(ctx, 'host', 101, 'memory_usage'), undefined);
});

test('Retry-After without end: the pause and its timer are bounded to 6 h', async (t) => {
  const ctx = await setup(t);
  ctx.xo.replyFor = () => ({ status: 429, body: {}, headers: { 'retry-after': '999999999' } });
  await until(ctx, () => ctx.app.paused(), 'paused');
  assert.ok(ctx.app.pauseLeft() <= 6 * 3_600_000);
  assert.ok(ctx.store.data.pausedUntil - ctx.clock.now() <= 6 * 3_600_000 + 1000);
  ctx.xo.replyFor = undefined;
  await ctx.clock.advance(6 * 3_600_000 + 1000);
  await until(ctx, () => ctx.app.online, 'read again after 6 h at most', { step: 1000 });
});

test('a 503 on a secondary read (hosts) pauses every path', async (t) => {
  const ctx = await setup(t);
  ctx.xo.replyFor = (r) =>
    r.path === '/rest/v0/hosts' ? { status: 503, body: 'busy' } : undefined;
  await until(ctx, () => ctx.app.paused(), 'paused');
  assert.ok(ctx.app.pauseLeft() >= 59_000);
});

test('another token saved while running lifts the refusal at once (never 1 time in 65536 kept)', async (t) => {
  const ctx = await setup(t, { server: { tokens: new Map() } });
  await until(ctx, () => ctx.app.blocked, 'refused');
  const fresh = 'AnotherValidTokenForTheTests_0123456789abcd';
  await within(ctx.gladys.fake.configUpdated({ ...ctx.raw, token: fresh }), 'config');
  assert.equal(ctx.store.data.refused, null);
});
