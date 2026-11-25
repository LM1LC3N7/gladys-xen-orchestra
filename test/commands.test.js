// -----------------------------------------------------------------------------
// The VM buttons: Start (allowed), Shut down, Force shutdown, Restart (off by
// default), decided on a fresh read, checked again right before the first
// byte, confirmed only by a later read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { pinnedRequest } from '../src/xo.js';
import { testClock } from './kit/clock.mjs';
import { uuid, vm } from './helpers/fakeXo.js';
import {
  ack,
  waitFor,
  pause,
  allCreated,
  created,
  online,
  setup,
  statusText,
  until,
  within,
} from './helpers/setup.js';

const ALL_ON = { allow_shutdown: true, allow_force_off: true, allow_reboot: true };
const posts = (ctx) => ctx.xo.requests.filter((r) => r.method === 'POST');

test('Start is allowed without option: decided on a fresh read, then confirmed by a later read', async (t) => {
  const ctx = await online(t);
  const reads = ctx.xo.count(`GET /rest/v0/vms/${uuid(2)}`);
  const res = await within(ctx.press(2, 'start'), 'ack');
  assert.equal(res.success, true);
  assert.equal(ctx.xo.count(`GET /rest/v0/vms/${uuid(2)}`), reads + 1, 'read after the click');
  assert.deepEqual(
    ctx.xo.actions.map((a) => [a.vm, a.action]),
    [[uuid(2), 'start']],
  );
  const post = posts(ctx)[0];
  assert.equal(post.query.sync, undefined, 'never a blocking sync=true');
  assert.match(statusText(ctx), /Start: taken by Xen Orchestra; done once a read shows it/);
  await until(ctx, () => /Start: done/.test(statusText(ctx)), 'confirmed', { step: 1000 });
});

test('Start on a running VM: nothing sent', async (t) => {
  const ctx = await online(t);
  const res = await within(ctx.press(1, 'start'), 'ack');
  assert.equal(res.success, true);
  assert.equal(posts(ctx).length, 0);
  assert.match(statusText(ctx), /already running, nothing sent/);
});

for (const key of ['shutdown', 'force_off', 'reboot']) {
  test(`${key} is off by default: refused, nothing read nor sent`, async (t) => {
    const ctx = await online(t);
    const asked = ctx.xo.requests.length;
    const res = await within(ctx.press(1, key), 'ack');
    assert.equal(res.success, false);
    assert.match(res.error, /off in the configuration/);
    assert.equal(ctx.xo.requests.length, asked);
  });
}

test('Shut down allowed: clean_shutdown, after a fresh read; done only once a read shows Halted', async (t) => {
  const ctx = await online(t, { config: ALL_ON, server: { applyDelayMs: 3_600_000 } });
  const res = await within(ctx.press(1, 'shutdown'), 'ack');
  assert.equal(res.success, true);
  const order = ctx.xo.requests.slice(-2).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(order, [
    `GET /rest/v0/vms/${uuid(1)}`,
    `POST /rest/v0/vms/${uuid(1)}/actions/clean_shutdown`,
  ]);
  // The read at 5 s still shows Running: not done.
  await ctx.clock.advance(5000);
  await until(ctx, () => ctx.xo.count(`GET /rest/v0/vms/${uuid(1)}`) >= 2, 'follow-up');
  assert.doesNotMatch(statusText(ctx), /Shut down: done/);
  ctx.xo.vm(1).power_state = 'Halted';
  await until(ctx, () => /Shut down: done/.test(statusText(ctx)), 'confirmed', {
    step: 1000,
    timeout: 8000,
  });
});

test('a read equal to the state before stays "not applied yet" after the last follow-up', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.xo.replyFor = (r) =>
    r.method === 'POST' ? { status: 202, body: { taskId: 'x' } } : undefined;
  const res = await within(ctx.press(1, 'force_off'), 'ack');
  assert.equal(res.success, true);
  await until(
    ctx,
    () => /not applied yet \(VM read: Running\)/.test(statusText(ctx)),
    'unapplied',
    {
      step: 2000,
      timeout: 8000,
    },
  );
  assert.doesNotMatch(statusText(ctx), /done/);
});

test('Restart is confirmed by a new start time, not by "Running" alone', async (t) => {
  const ctx = await online(t, { config: ALL_ON, server: { applyDelayMs: 3_600_000 } });
  const res = await within(ctx.press(1, 'reboot'), 'ack');
  assert.equal(res.success, true);
  await ctx.clock.advance(10_000);
  await until(ctx, () => ctx.xo.count(`GET /rest/v0/vms/${uuid(1)}`) >= 2, 'read at 10 s');
  await pause(200);
  assert.doesNotMatch(statusText(ctx), /Restart: done/);
  assert.match(statusText(ctx), /Restart: taken/);
  ctx.xo.vm(1).startTime += 30;
  await until(ctx, () => /Restart: done/.test(statusText(ctx)), 'confirmed', {
    step: 2000,
    timeout: 8000,
  });
});

test('the option is checked again right before the first byte (turned off during the read)', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.xo.latencyMs = (r) => (r.method === 'GET' && r.path.endsWith(uuid(1)) ? 400 : 0);
  const saves = ctx.store.saves;
  const pending = ctx.press(1, 'shutdown');
  await new Promise((r) => setTimeout(r, 100));
  await within(
    ctx.gladys.fake.configUpdated({ ...ctx.raw, ...ALL_ON, allow_shutdown: false }),
    'save',
  );
  const res = await within(pending, 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /off in the configuration/);
  assert.equal(posts(ctx).length, 0);
  assert.equal(ctx.store.saves, saves, 'decided after the read: no guard written');
});

/** The writes of the store wait for `open()` (a slow /data), to act between the read and the send. */
function slow(store) {
  const save = store.save.bind(store);
  let release;
  store.hold = () => {
    store.gate = new Promise((r) => (release = r));
    store.waiting = false;
  };
  store.open = () => release?.();
  store.save = async (data) => {
    if (store.gate) {
      store.waiting = true;
      await store.gate;
      store.gate = undefined;
    }
    return save(data);
  };
  return store;
}

test('between the guard and the first byte: the option turned off is seen, the guard withdrawn', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  const store = slow(ctx.store);
  store.hold();
  const pending = ctx.press(1, 'force_off');
  await waitFor(() => store.waiting, 'the guard being written');
  await within(
    ctx.gladys.fake.configUpdated({ ...ctx.raw, ...ALL_ON, allow_force_off: false }),
    'save',
  );
  store.open();
  const res = await within(pending, 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /off in the configuration/);
  assert.equal(posts(ctx).length, 0);
  assert.equal(ctx.app.guardLeft(uuid(1)), 0, 'never left: the guard is withdrawn');
  await waitFor(() => ctx.store.data.stopGuards[uuid(1)] === undefined, 'withdrawn in /data');
});

test('another token saved between the guard and the first byte: nothing sent on the old session', async (t) => {
  // A transport that ignores the stop of the session (to see the check at the first byte).
  const request = (o) => pinnedRequest({ ...o, signal: undefined });
  const ctx = await online(t, { config: ALL_ON, request });
  const store = slow(ctx.store);
  store.hold();
  const pending = ctx.press(1, 'shutdown');
  await waitFor(() => store.waiting, 'the guard being written');
  const other = 'AnotherValidTokenForTheTests_0123456789abcd';
  ctx.gladys.fake.configUpdated({ ...ctx.raw, ...ALL_ON, token: other }).catch(() => {});
  store.open();
  const res = await within(pending, 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /configuration changed/);
  assert.equal(posts(ctx).length, 0);
});

test('the first byte after the deadline: nothing sent ("too slowly")', async (t) => {
  const clock = testClock();
  let slow = false;
  const request = async (o) => {
    if (slow && o.method === 'POST') await clock.advance(3400);
    return pinnedRequest(o);
  };
  const ctx = await online(t, { request, clock });
  slow = true;
  const res = await within(ctx.press(2, 'start'), 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /too slowly/);
  assert.equal(posts(ctx).length, 0);
});

test('the token refused: every button refused, nothing read nor sent', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.app.blocked = true;
  const asked = ctx.xo.requests.length;
  for (const key of ['start', 'shutdown']) {
    const res = await within(ctx.press(2, key), key);
    assert.match(res.error, /refused the token/);
  }
  assert.equal(ctx.xo.requests.length, asked);
});

test('Shut down or Restart of a halted VM: nothing sent', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  assert.match((await within(ctx.press(2, 'shutdown'), 'stop')).error ?? '', /^$/);
  assert.match(statusText(ctx), /already halted, nothing sent/);
  const r = await within(ctx.press(2, 'reboot'), 'reboot');
  assert.match(r.error, /not running/);
  assert.equal(posts(ctx).length, 0);
});

test('a stop of the same VM cancels a Start not sent yet; nothing leaves after the stop', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.xo.latencyMs = (r) => (r.method === 'GET' && r.path.endsWith(uuid(2)) ? 400 : 0);
  const start = ctx.press(2, 'start');
  await new Promise((r) => setTimeout(r, 100));
  const stop = await within(ctx.press(2, 'force_off'), 'stop ack');
  assert.equal(stop.success, false);
  assert.match(stop.error, /Start of this VM not sent yet is cancelled/);
  const res = await within(start, 'start ack');
  assert.equal(res.success, false);
  assert.match(res.error, /A stop of this VM came after this command/);
  assert.equal(posts(ctx).length, 0);
});

test('after a forced shutdown, Start of that VM is refused 60 s (guard in /data, kept across a restart)', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  const res = await within(ctx.press(1, 'force_off'), 'ack');
  assert.equal(res.success, true);
  assert.ok(ctx.store.data.stopGuards[uuid(1)].until > ctx.clock.now());
  await ctx.clock.advance(16_000);
  const again = await within(ctx.press(1, 'start'), 'start');
  assert.equal(again.success, false);
  assert.match(again.error, /shut down less than a minute ago/);
  assert.equal(posts(ctx).length, 1);
  // Another VM is not held by it.
  const other = await within(ctx.press(2, 'start'), 'other');
  assert.equal(other.success, true);
  // A restart within the minute keeps the guard.
  const next = await setup(t, {
    connect: false,
    store: memoryStore(ctx.store.data),
    config: ALL_ON,
  });
  next.store.data.pins = { [next.xo.address]: next.xo.fingerprint };
  for (const g of Object.values(next.store.data.stopGuards)) g.address = next.xo.address;
  next.xo.vm(1).power_state = 'Halted';
  await within(next.gladys.connect(), 'connect');
  const after = await within(next.press(1, 'start'), 'after restart');
  assert.equal(after.success, false);
  assert.match(after.error, /less than a minute ago/);
  assert.equal(next.xo.requests.length, 0, 'refused before any read');
});

test('the stop guard not written to /data: the stop is refused, nothing sent', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.store.failSave = true;
  const res = await within(ctx.press(1, 'shutdown'), 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /could not keep the guard/);
  assert.equal(posts(ctx).length, 0);
  assert.equal(ctx.app.guardLeft(uuid(1)), 0, 'the guard is withdrawn');
});

test('a stop that never leaves (the send is cut) withdraws its guard: Start stays possible', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.xo.replyFor = (r) =>
    r.method === 'POST' ? { status: 500, body: { error: 'VM_BAD_POWER_STATE' } } : undefined;
  const res = await within(ctx.press(1, 'shutdown'), 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /Refused by Xen Orchestra/);
  assert.equal(ctx.app.guardLeft(uuid(1)), 0);
  assert.equal(ctx.store.data.stopGuards[uuid(1)], undefined);
  assert.equal(ctx.app.paused(), false, 'a 500 of XAPI about one VM pauses nothing');
});

test('sent without an answer: "sent, without confirmation", never sent again, reads follow', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.xo.replyFor = (r) => (r.method === 'POST' ? 'silent' : undefined);
  const started = performance.now();
  const res = await ack(ctx, ctx.press(1, 'shutdown'), 0);
  assert.ok(performance.now() - started < 4500);
  assert.equal(res.success, false);
  assert.match(res.error, /Sent, without confirmation/);
  assert.equal(posts(ctx).length, 1);
  assert.ok(ctx.app.guardLeft(uuid(1)) > 0, 'the guard stays: the stop may be done');
  ctx.xo.replyFor = undefined;
  ctx.xo.vm(1).power_state = 'Halted';
  await until(ctx, () => /Shut down: done/.test(statusText(ctx)), 'confirmed', { step: 1000 });
  assert.equal(posts(ctx).length, 1);
});

test('nothing sent when the certificate changed: "nothing sent"', async (t) => {
  const ctx = await online(t);
  ctx.app.memory.pins[ctx.xo.address] = 'AA:'.repeat(31) + 'AA';
  ctx.app.client = null;
  const res = await within(ctx.press(2, 'start'), 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /nothing sent/);
  assert.equal(posts(ctx).length, 0);
});

test('one command at a time per VM, one per 15 s per VM; other VMs are not held', async (t) => {
  const ctx = await online(t, {
    config: ALL_ON,
    server: { vms: [vm(1), vm(2, { power_state: 'Halted' }), vm(3, { power_state: 'Halted' })] },
    devices: [...allCreated(), created('vm', uuid(3))],
  });
  ctx.xo.latencyMs = (r) => (r.method === 'GET' && r.path.endsWith(uuid(2)) ? 300 : 0);
  const first = ctx.press(2, 'start');
  await new Promise((r) => setTimeout(r, 50));
  const second = await within(ctx.press(2, 'start'), 'second');
  assert.match(second.error, /Another command of this VM is running/);
  const third = await within(ctx.press(3, 'start'), 'other VM');
  assert.equal(third.success, true);
  assert.equal((await within(first, 'first')).success, true);
  ctx.xo.vm(2).power_state = 'Halted';
  const soon = await within(ctx.press(2, 'start'), 'soon');
  assert.match(soon.error, /One command per VM per 15 s/);
});

test('a scene on 5 slow VMs (500-900 ms) starts all 5; one VM in error stops none of the others', async (t) => {
  const vms = [1, 2, 3, 4, 5, 6].map((n) => vm(n, { power_state: 'Halted', startTime: null }));
  const devices = vms.map((v) => created('vm', v.id));
  const ctx = await online(t, { server: { vms }, devices });
  ctx.xo.latencyMs = (r) => (r.path.includes('/vms/') ? 500 + Math.floor(Math.random() * 400) : 0);
  ctx.xo.replyFor = (r) =>
    r.method === 'POST' && r.path.includes(uuid(6))
      ? { status: 500, body: { error: 'HOST_NOT_ENOUGH_FREE_MEMORY' } }
      : undefined;
  const results = await within(
    Promise.all([1, 2, 3, 4, 5, 6].map((n) => ctx.press(n, 'start'))),
    'scene',
    10_000,
  );
  assert.deepEqual(
    results.map((r) => r.success),
    [true, true, true, true, true, false],
  );
  assert.equal(ctx.xo.actions.length, 5);
  assert.equal(ctx.app.paused(), false);
});

test('during a 429 pause: refused, nothing sent', async (t) => {
  const ctx = await online(t);
  ctx.app.pauseEnd = ctx.clock.monotonic() + 600_000;
  const asked = ctx.xo.requests.length;
  const res = await within(ctx.press(2, 'start'), 'ack');
  assert.match(res.error, /asked to wait/);
  assert.equal(ctx.xo.requests.length, asked);
});

test('a VM with an operation running, or gone (404), or paused: refused, nothing sent', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.xo.vm(2).current_operations = { abc: 'migrate_send' };
  assert.match((await within(ctx.press(2, 'start'), 'busy')).error, /operation of Xen Orchestra/);
  ctx.xo.vm(2).current_operations = {};
  ctx.xo.vm(2).power_state = 'Paused';
  assert.match((await within(ctx.press(2, 'start'), 'paused')).error, /resume it/);
  ctx.xo.vms = ctx.xo.vms.filter((v) => v.id !== uuid(1));
  assert.match((await within(ctx.press(1, 'shutdown'), 'gone')).error, /does not know this VM/);
  assert.equal(posts(ctx).length, 0);
});

test('only a press: other values, read-only features and unknown ids are refused', async (t) => {
  const ctx = await online(t);
  assert.match((await within(ctx.press(2, 'start', 0), 'zero')).error, /only takes a press/);
  assert.match((await within(ctx.press(2, 'start', 'true'), 'true')).error, /only takes a press/);
  assert.match((await within(ctx.press(2, 'running'), 'ro')).error, /read only/);
  const host = created('host', uuid(101));
  const r = await within(
    ctx.gladys.fake.setValue(host, { external_id: `${host.external_id}:running` }, 1),
    'host',
  );
  assert.match(r.error, /read only/);
  const bad = await within(
    ctx.gladys.fake.setValue(host, { external_id: 'ext:test-integration:xo-vm:../x:start' }, 1),
    'bad',
  );
  assert.match(bad.error, /Unknown device/);
  assert.equal(posts(ctx).length, 0);
});

test('the read of the VM answered too slowly: nothing sent, acked within the budget', async (t) => {
  const ctx = await online(t);
  ctx.xo.latencyMs = (r) => (r.method === 'GET' && r.path.endsWith(uuid(2)) ? 3000 : 0);
  const started = performance.now();
  const res = await within(ctx.press(2, 'start'), 'ack');
  assert.ok(performance.now() - started < 3600, 'within the 3.5 s budget');
  assert.equal(res.success, false);
  assert.equal(posts(ctx).length, 0);
});

test('a 502 of a proxy after the stop left: "sent, without confirmation", guard kept, reads follow', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.xo.replyFor = (r) => (r.method === 'POST' ? { status: 502, body: 'Bad Gateway' } : undefined);
  const res = await within(ctx.press(1, 'shutdown'), 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /Sent, without confirmation/);
  assert.ok(ctx.app.guardLeft(uuid(1)) > 0, 'the stop may be done: the guard stays');
  assert.ok(ctx.store.data.stopGuards[uuid(1)]);
  assert.equal(posts(ctx).length, 1);
});
