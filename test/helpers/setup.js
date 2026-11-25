// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the simulated Xen
// Orchestra (test/helpers/fakeXo.js), with the exact wiring of the container
// (src/handlers.js). The app's timers are virtual (the kit's testClock: they
// fire only on `advance`), the network is real (127.0.0.1): every wait on the
// network is bounded in real time, so a test fails, it never hangs.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { XoApp } from '../../src/app.js';
import { KINDS } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { testClock } from '../kit/clock.mjs';
import { TOKEN, fakeXo, uuid } from './fakeXo.js';

/** Real-time wait for a condition, bounded: throws (never hangs) after `timeout` ms. */
export async function waitFor(fn, what = 'the condition', timeout = 4000) {
  const end = performance.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A promise bounded in real time: rejects (never hangs) after `timeout` ms. */
export function within(promise, what = 'the promise', timeout = 6000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} never settled`)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded in real time: runs the due virtual timers (advancing `step` ms each
 * turn) until `fn()` is true; throws (never hangs) after `timeout` real ms.
 */
export async function until(ctx, fn, what = 'the condition', { step = 0, timeout = 4000 } = {}) {
  const end = performance.now() + timeout;
  for (;;) {
    await ctx.clock.advance(step);
    const value = await fn();
    if (value) return value;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The loop is idle: no read in flight, the next one scheduled. */
export const idle = (ctx, what = 'the loop idle') =>
  waitFor(() => !ctx.app.reading && ctx.app.readTimer !== undefined, what);

const PREFIX = 'ext:test-integration';

/** A created device (as a user would create it from the Discovery). */
export function created(kind, id) {
  const ext = `${PREFIX}:${KINDS[kind].type}:${id}`;
  return {
    external_id: ext,
    name: `${kind} ${id}`,
    features: KINDS[kind].features.map(([key]) => ({ external_id: `${ext}:${key}`, name: key })),
  };
}

/** The devices of the default simulated XO, all created. */
export const allCreated = () => [
  created('vm', uuid(1)),
  created('vm', uuid(2)),
  created('host', uuid(101)),
  created('sr', uuid(201)),
  created('backup', uuid(301)),
];

export async function setup(
  t,
  {
    server = {},
    config = {},
    memory,
    store,
    pinned = true,
    connect = true,
    devices = allCreated(),
    getConfig,
    request,
    clock = testClock(),
  } = {},
) {
  const xo = await fakeXo(server);
  t.after(() => xo.close());
  const kept =
    store ??
    memoryStore(
      memory === undefined ? (pinned ? { pins: { [xo.address]: xo.fingerprint } } : null) : memory,
    );
  const raw = { host: xo.address, token: TOKEN, language: 'en', ...config };
  const gladys = createFakeGladys({ config: raw, devices });
  if (getConfig) gladys.getConfig = getConfig;
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  const app = new XoApp({
    gladys,
    logger,
    store: kept,
    now: clock.now,
    mono: clock.monotonic,
    timers: clock.timers,
    request,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.shutdown());
  const device = (kind, n) =>
    devices.find((d) => d.external_id.endsWith(`:${KINDS[kind].type}:${uuid(n)}`));
  const press = (n, key, value = 1) => {
    const d = device('vm', n) ?? created('vm', uuid(n));
    return gladys.fake.setValue(d, { external_id: `${d.external_id}:${key}` }, value);
  };
  const ctx = { xo, gladys, app, clock, store: kept, logs, raw, device, press };
  if (connect) await within(gladys.connect(), 'connect');
  return ctx;
}

/** Starts the app and waits for the first full read. */
export async function online(t, options = {}) {
  const ctx = await setup(t, options);
  await until(ctx, () => ctx.app.online, 'online');
  await idle(ctx);
  return ctx;
}

/** The last state published for a feature of an object. */
export const stateOf = (ctx, kind, n, key) =>
  ctx.gladys.fake.lastState(`${PREFIX}:${KINDS[kind].type}:${uuid(n)}:${key}`);

/** The text of the last connection status, in English. */
export const statusText = (ctx) => {
  const s = ctx.gladys.fake.connectionStatus;
  const m = s?.message;
  return typeof m === 'string' ? m : (m?.en ?? '');
};

/** A press acked, the virtual clock moving `step` ms per turn meanwhile. */
export async function ack(ctx, promise, step = 50) {
  let done;
  promise.then(
    (v) => (done = { v }),
    (e) => (done = { e }),
  );
  await until(ctx, () => done, 'the ack', { step, timeout: 8000 });
  if (done.e) throw done.e;
  return done.v;
}
