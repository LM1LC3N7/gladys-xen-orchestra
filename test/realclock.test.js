// -----------------------------------------------------------------------------
// The real clock against the simulated Xen Orchestra: the period of the reads
// measured (20 times faster, wide margins: a timer is late under load, never
// early), and a command acked within the 3.5 s budget when XO never answers.
// The app is stopped in t.after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { XoApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { TOKEN, fakeXo, uuid } from './helpers/fakeXo.js';
import { allCreated, waitFor, within } from './helpers/setup.js';

async function start(t, { speed = 20, config = {} } = {}) {
  const xo = await fakeXo();
  t.after(() => xo.close());
  const clock = realClock({ speed });
  t.after(() => clock.close());
  const raw = { host: xo.address, token: TOKEN, poll_interval: 30, ...config };
  const devices = allCreated();
  const gladys = createFakeGladys({ config: raw, devices });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new XoApp({
    gladys,
    logger,
    store: memoryStore({ pins: { [xo.address]: xo.fingerprint } }),
    now: clock.now,
    mono: clock.monotonic,
    timers: clock.timers,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.shutdown());
  return { xo, clock, gladys, app, devices };
}

test('real clock x20: the reads come at the interval (30 s), measured', async (t) => {
  const { clock, gladys, app } = await start(t);
  const spy = spyOn(app, 'tick', clock);
  t.after(() => spy.restore());
  await within(gladys.connect(), 'connect');
  const gaps = await measurePeriod(spy, { count: 4, period: 30_000 });
  assert.equal(gaps.length, 3);
});

test('real clock: a stop XO never answers is acked within the 3.5 s budget, sent once', async (t) => {
  const { xo, gladys, app, devices } = await start(t, {
    speed: 1,
    config: { allow_shutdown: true },
  });
  await within(gladys.connect(), 'connect');
  await waitFor(() => app.online, 'online', 6000);
  xo.replyFor = (r) => (r.method === 'POST' ? 'silent' : undefined);
  xo.latencyMs = (r) => (r.method === 'GET' ? 400 : 0);
  const vm = devices.find((d) => d.external_id.endsWith(uuid(1)));
  const started = performance.now();
  const res = await within(
    gladys.fake.setValue(vm, { external_id: `${vm.external_id}:shutdown` }, 1),
    'ack',
  );
  const took = performance.now() - started;
  assert.equal(res.success, false);
  assert.ok(took < 3600, `acked after ${Math.round(took)} ms`);
  assert.equal(xo.count('POST'), 1);
});

test('real clock: stop() leaves no timer: no request after shutdown', async (t) => {
  const { xo, gladys, app } = await start(t);
  await within(gladys.connect(), 'connect');
  await waitFor(() => app.online, 'online', 6000);
  await app.shutdown();
  const asked = xo.requests.length;
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(xo.requests.length, asked);
});
