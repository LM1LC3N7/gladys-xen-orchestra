// -----------------------------------------------------------------------------
// The token of XO: its expiry read on XO's own clock, renewed with itself
// (docs: "renew by calling the same endpoint with your existing token"), the
// new one given back to Gladys; never a refusal from a secondary route.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN, USER_ID } from './helpers/fakeXo.js';
import { online, pause, setup, statusText, until } from './helpers/setup.js';

const DAY = 24 * 3_600_000;
const life = (left, total = 30 * DAY) => {
  const now = Date.now();
  return new Map([[TOKEN, { created_at: now + left - total, expiration: now + left }]]);
};

test('29 days left of 30: not renewed; the expiry is read again only after 12 h', async (t) => {
  const ctx = await online(t, { server: { tokens: life(29 * DAY) } });
  assert.equal(ctx.xo.count('GET /rest/v0/users/me'), 1);
  assert.equal(ctx.xo.count(`GET /rest/v0/users/${USER_ID}/authentication_tokens`), 1);
  assert.equal(ctx.xo.created.length, 0);
  await until(ctx, () => ctx.xo.count('GET /rest/v0/vms') >= 3, 'two more reads', { step: 30_000 });
  assert.equal(ctx.xo.count(`/authentication_tokens`), 1);
});

test('5 days left: renewed with the token itself, given back to Gladys, used from then on', async (t) => {
  const ctx = await online(t, { server: { tokens: life(5 * DAY) } });
  assert.equal(ctx.xo.created.length, 1);
  const post = ctx.xo.requests.find((r) => r.method === 'POST');
  assert.equal(
    post.path,
    `/rest/v0/users/${USER_ID}/authentication_tokens`,
    'the documented route, with the user id (never the deprecated one, never me)',
  );
  assert.equal(ctx.xo.count('/rest/v0/users/me/'), 0);
  assert.equal(post.token, TOKEN, 'renewed with the current token, never a password');
  const fresh = ctx.xo.created[0];
  assert.equal(ctx.gladys.fake.config.token, fresh);
  const before = ctx.xo.requests.length;
  await until(ctx, () => ctx.xo.requests.length > before + 2, 'next read', { step: 30_000 });
  for (const r of ctx.xo.requests.slice(before)) assert.equal(r.token, fresh);
  // The configuration saved later with the new token keeps the session.
  await ctx.gladys.fake.configUpdated({ ...ctx.raw, token: fresh });
  assert.equal(ctx.app.online, true);
  assert.equal(ctx.xo.created.length, 1, 'renewed once');
  assert.ok(!JSON.stringify([ctx.logs, ctx.store.data]).includes(fresh));
});

test('a 1-hour token is renewed at half its life', async (t) => {
  const ctx = await online(t, { server: { tokens: life(20 * 60_000, 3_600_000) } });
  assert.equal(ctx.xo.created.length, 1);
});

test('the time of XO decides, never the local clock (XO 26 days ahead)', async (t) => {
  const ctx = await online(t, {
    server: { tokens: life(30 * DAY - 60_000), dateOffset: 26 * DAY },
  });
  assert.equal(ctx.xo.created.length, 1);
});

test('without a readable Date of XO, the token is never taken for expiring', async (t) => {
  const ctx = await online(t, {
    server: {
      tokens: life(DAY),
      replyFor: (r) =>
        r.path.endsWith('/authentication_tokens') && r.method === 'GET'
          ? {
              status: 200,
              headers: { date: 'not a date' },
              body: [{ id: TOKEN, user_id: USER_ID, created_at: 0, expiration: Date.now() + DAY }],
            }
          : undefined,
    },
  });
  assert.equal(ctx.xo.created.length, 0);
});

test('Gladys cannot keep the new token: it is used meanwhile, the status says so, kept 10 min later', async (t) => {
  const c = await setup(t, { connect: false, server: { tokens: life(2 * DAY) } });
  let fail = true;
  const real = c.gladys.setConfig.bind(c.gladys);
  c.gladys.setConfig = async (partial) => {
    if (fail) throw new Error('gladys busy');
    return real(partial);
  };
  await c.gladys.connect();
  await until(c, () => c.app.online && c.xo.created.length === 1, 'renewed', { step: 10 });
  await until(c, () => /could not keep the new one/.test(statusText(c)), 'status');
  const fresh = c.xo.created[0];
  assert.notEqual(c.gladys.fake.config.token, fresh);
  // Meanwhile the new token is the one used (the old one is left to expire).
  const before = c.xo.requests.length;
  await until(c, () => c.xo.requests.length > before, 'next read', { step: 30_000 });
  await pause(200);
  for (const r of c.xo.requests.slice(before)) assert.equal(r.token, fresh);
  fail = false;
  await c.clock.advance(10 * 60_000);
  await until(c, () => c.gladys.fake.config.token === fresh, 'kept', { step: 60_000 });
  assert.equal(c.xo.created.length, 1, 'never a second token for the same renewal');
});

test('renewal refused (403) or the token list refused (401): never a refusal of the token', async (t) => {
  const ctx = await online(t, {
    server: {
      tokens: life(3 * DAY),
      replyFor: (r) =>
        r.method === 'POST' && r.path.endsWith('/authentication_tokens')
          ? { status: 403, body: { error: 'not allowed' } }
          : undefined,
    },
  });
  assert.equal(ctx.app.blocked, false);
  assert.match(statusText(ctx), /expires in [23] day\(s\) and could not be renewed/);
  const other = await online(t, {
    server: {
      replyFor: (r) =>
        r.path.includes('/users/')
          ? { status: 401, body: { error: 'invalid credentials' } }
          : undefined,
    },
  });
  assert.equal(other.app.blocked, false);
  assert.equal(other.store.data.refused, null);
});

test('a 12-hour token: its expiry read again within the quarter of the time left, renewed in time', async (t) => {
  const ctx = await online(t, {
    config: { poll_interval: 3600 },
    server: { tokens: life(12 * 3_600_000, 12 * 3_600_000) },
  });
  assert.equal(ctx.xo.created.length, 0, '12 h left of 12: not yet');
  // XO's clock moves with the virtual one.
  for (let h = 1; h <= 7 && ctx.xo.created.length === 0; h += 1) {
    ctx.xo.dateOffset = h * 3_600_000;
    await ctx.clock.advance(3_600_000);
    await until(ctx, () => !ctx.app.reading, 'read done');
    await pause(100);
  }
  assert.equal(ctx.xo.created.length, 1, 'renewed before it expires');
  assert.equal(ctx.app.blocked, false);
});

test('the token list holds other tokens: the expiry read is the one of the token in use', async (t) => {
  const now = Date.now();
  const tokens = new Map([
    [
      'OtherTokenOfTheSameUser_abcdefghijklmnopqrstuvw',
      { created_at: now - 29 * DAY, expiration: now + DAY },
    ],
    [TOKEN, { created_at: now - DAY, expiration: now + 29 * DAY }],
  ]);
  const ctx = await online(t, { server: { tokens } });
  assert.equal(ctx.xo.created.length, 0, 'the other, expiring, token is not ours');
});

test('the token list refused twice (a user without the right): the status says it', async (t) => {
  const ctx = await online(t, {
    server: {
      replyFor: (r) =>
        r.method === 'GET' && r.path.endsWith('/authentication_tokens')
          ? { status: 403, body: { error: 'not enough permissions' } }
          : undefined,
    },
  });
  assert.doesNotMatch(statusText(ctx), /cannot be read/);
  await until(ctx, () => /expiry of the token cannot be read/.test(statusText(ctx)), 'status', {
    step: 600_000,
    timeout: 8000,
  });
  assert.equal(ctx.app.blocked, false);
});

test('a 503 on the renewal pauses every path', async (t) => {
  const ctx = await online(t, {
    server: {
      tokens: life(3 * DAY),
      replyFor: (r) => (r.method === 'POST' ? { status: 503, body: 'busy' } : undefined),
    },
  });
  assert.ok(ctx.app.paused());
  assert.equal(ctx.xo.created.length, 0);
});

test('another token saved while the renewed one is being written: the saved one wins in Gladys', async (t) => {
  const c = await setup(t, { connect: false, server: { tokens: life(2 * DAY) } });
  const real = c.gladys.setConfig.bind(c.gladys);
  let release;
  const gate = new Promise((r) => (release = r));
  let held = false;
  c.gladys.setConfig = async (partial) => {
    if (!held) {
      held = true;
      await gate;
    }
    return real(partial);
  };
  await c.gladys.connect();
  await until(c, () => held, 'renewed token being written', { step: 10 });
  const typed = 'TokenTypedByTheUser_0123456789abcdefghijklm';
  c.xo.tokens.set(typed, { created_at: Date.now(), expiration: Date.now() + 30 * DAY });
  c.gladys.fake.config.token = typed;
  await c.gladys.fake.configUpdated({ ...c.raw, token: typed });
  release();
  await until(c, () => c.gladys.fake.config.token === typed && c.app.online, 'written back', {
    step: 10,
  });
  await pause(100);
  assert.equal(c.gladys.fake.config.token, typed);
  assert.equal(c.app.config.token, typed);
});
