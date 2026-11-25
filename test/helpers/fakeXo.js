// -----------------------------------------------------------------------------
// A simulated Xen Orchestra (REST API `/rest/v0` as documented at
// docs.xen-orchestra.com/restapi and seen on XO 5.214 in a container) over
// real HTTPS on 127.0.0.1, with the kit's self-signed device certificate.
// Every request is recorded (method, path, query, headers, body); answers can
// be replaced per request (`replyFor`), delayed (`latencyMs`) or held
// (`silent`). VM actions apply after `applyDelayMs`. The Date header follows
// `serverNow()` (the time of XO, moved by `dateOffset`).
// -----------------------------------------------------------------------------

import { createServer } from 'node:https';
import { certs } from '../kit/certs.mjs';

export const TOKEN = 'Gl4dysT0kenForTestsOnly_abcdefghijklmnopqr';
export const USER_ID = '66062793-0548-4435-bc40-e2e8cb43b9e5';
const DAY = 24 * 3_600_000;

export const uuid = (n) => `0000000${n}`.slice(-8) + '-0000-4000-8000-000000000000';

export const vm = (n, extra = {}) => ({
  id: uuid(n),
  name_label: `vm-${n}`,
  power_state: 'Running',
  CPUs: { number: 2, max: 2 },
  memory: { size: 2 * 1024 * 1024 * 1024, static: [0, 0], dynamic: [0, 0] },
  startTime: 1_700_000_000,
  current_operations: {},
  ...extra,
});

const unauthorized = { status: 401, body: { error: 'invalid credentials' } };

export async function fakeXo({ cert = certs.device, ...options } = {}) {
  const sockets = new Set();
  const timers = new Set();
  const xo = {
    vms: [vm(1), vm(2, { power_state: 'Halted', startTime: null })],
    hosts: [
      {
        id: uuid(101),
        name_label: 'xcp-1',
        power_state: 'Running',
        memory: { usage: 8e9, size: 32e9 },
        version: '8.3.0',
        productBrand: 'XCP-ng',
      },
    ],
    srs: [
      {
        id: uuid(201),
        name_label: 'Local storage',
        SR_type: 'ext',
        content_type: 'user',
        size: 500e9,
        physical_usage: 125e9,
      },
      {
        id: uuid(202),
        name_label: 'ISO',
        SR_type: 'iso',
        content_type: 'iso',
        size: 1e9,
        physical_usage: 0,
      },
    ],
    jobs: [{ id: uuid(301), name: 'nightly', type: 'backup', mode: 'delta' }],
    logs: [],
    /** uuid -> { cpus, memory, memoryFree, ageMs } */
    stats: {},
    tokens: new Map([[TOKEN, { created_at: Date.now() - DAY, expiration: Date.now() + 29 * DAY }]]),
    created: [],
    dateOffset: 0,
    applyDelayMs: 0,
    latencyMs: 0,
    /** (request) => { status, body, headers } | 'silent' | 'drop' | undefined */
    replyFor: undefined,
    requests: [],
    actions: [],
    fingerprint: cert.fingerprint256,
    ...options,
    serverNow() {
      return Date.now() + this.dateOffset;
    },
    count(match) {
      return this.requests.filter((r) => `${r.method} ${r.path}`.includes(match)).length;
    },
    vm(n) {
      return this.vms.find((v) => v.id === uuid(n));
    },
  };

  const tokenOf = (req) => /authenticationToken=([^;\s]+)/.exec(req.headers.cookie ?? '')?.[1];
  const authorized = (req) => {
    const t = xo.tokens.get(tokenOf(req));
    return Boolean(t && t.expiration > xo.serverNow());
  };
  const withHref = (kind, items) => items.map((o) => ({ ...o, href: `/rest/v0/${kind}/${o.id}` }));
  const limited = (r, items) => {
    const limit = Number(r.query.limit);
    return Number.isFinite(limit) ? items.slice(0, limit) : items;
  };

  const route = (r) => {
    if (!authorized(r)) return unauthorized;
    const p = r.path;
    const get = r.method === 'GET';
    if (get && p === '/rest/v0/vms')
      return { status: 200, body: limited(r, withHref('vms', xo.vms)) };
    if (get && p === '/rest/v0/hosts') {
      return { status: 200, body: limited(r, withHref('hosts', xo.hosts)) };
    }
    if (get && p === '/rest/v0/srs')
      return { status: 200, body: limited(r, withHref('srs', xo.srs)) };
    if (get && p === '/rest/v0/backup-jobs') {
      return { status: 200, body: limited(r, withHref('backup-jobs', xo.jobs)) };
    }
    if (get && p === '/rest/v0/backup-logs') {
      const m = /^start:>(\d+)$/.exec(r.query.filter ?? '');
      if (r.query.filter !== undefined && !m)
        return { status: 400, body: { error: 'parse error' } };
      const since = m ? Number(m[1]) : -Infinity;
      return {
        status: 200,
        body: limited(
          r,
          withHref(
            'backup-logs',
            xo.logs.filter((l) => l.start > since),
          ),
        ),
      };
    }
    if (get && p === '/rest/v0/users/me') {
      return {
        status: 307,
        body: `Temporary Redirect. Redirecting to /rest/v0/users/${USER_ID}`,
        headers: { location: `/rest/v0/users/${USER_ID}` },
      };
    }
    if (get && p === `/rest/v0/users/${USER_ID}/authentication_tokens`) {
      return {
        status: 200,
        body: [...xo.tokens].map(([id, t]) => ({ ...t, user_id: USER_ID, id })),
      };
    }
    // The route without the user id is deprecated in the Swagger: this XO no longer has it.
    if (r.method === 'POST' && p === `/rest/v0/users/${USER_ID}/authentication_tokens`) {
      const id = `Renewed${Math.random().toString(36).slice(2).padEnd(12, 'x')}_${xo.tokens.size}abcdefghijklmnop`;
      const now = xo.serverNow();
      const t = { created_at: now, expiration: now + 30 * DAY };
      xo.tokens.set(id, t);
      xo.created.push(id);
      return { status: 201, body: { token: { ...t, user_id: USER_ID, id } } };
    }
    const vmPath = /^\/rest\/v0\/vms\/([0-9a-f-]+)(\/stats|\/actions\/([a-z_]+))?$/.exec(p);
    if (vmPath) {
      const target = xo.vms.find((v) => v.id === vmPath[1]);
      if (!target) {
        return {
          status: 404,
          body: { error: `no such VM ${vmPath[1]}`, data: { id: vmPath[1], type: 'VM' } },
        };
      }
      if (get && !vmPath[2]) return { status: 200, body: { type: 'VM', ...target } };
      if (get && vmPath[2] === '/stats') {
        if (target.power_state !== 'Running') {
          return { status: 422, body: { error: 'VM is halted' } };
        }
        // cpus in percent per vCPU, memory in bytes.
        const s = xo.stats[target.id] ?? { cpus: [25, 75], memory: 2e9, memoryFree: 5e8 };
        const end = Math.floor((xo.serverNow() - (s.ageMs ?? 0)) / 1000);
        return {
          status: 200,
          body: {
            endTimestamp: end,
            interval: 5,
            stats: {
              cpus: Object.fromEntries(s.cpus.map((c, i) => [String(i), [10, c]])),
              memory: [s.memory, s.memory],
              ...(s.memoryFree === undefined ? {} : { memoryFree: [s.memoryFree, s.memoryFree] }),
            },
          },
        };
      }
      if (r.method === 'POST' && vmPath[3]) {
        const action = vmPath[3];
        const state = target.power_state;
        const valid =
          (action === 'start' && state === 'Halted') ||
          (action === 'clean_shutdown' && state === 'Running') ||
          (action === 'hard_shutdown' && state !== 'Halted') ||
          (action === 'clean_reboot' && state === 'Running');
        if (!valid) {
          return { status: 500, body: { error: `VM_BAD_POWER_STATE(${state})` } };
        }
        xo.actions.push({ vm: target.id, action, at: performance.now() });
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (action === 'start') {
            target.power_state = 'Running';
            target.startTime = Math.floor(xo.serverNow() / 1000);
          }
          if (action === 'clean_shutdown' || action === 'hard_shutdown') {
            target.power_state = 'Halted';
            target.startTime = null;
          }
          if (action === 'clean_reboot') target.startTime = Math.floor(xo.serverNow() / 1000) + 1;
        }, xo.applyDelayMs);
        timers.add(timer);
        return {
          status: 202,
          body: { taskId: `t${xo.actions.length}` },
          headers: { location: `/rest/v0/tasks/t${xo.actions.length}` },
        };
      }
    }
    return { status: 404, body: 'Cannot GET' };
  };

  const server = createServer({ key: cert.key, cert: cert.cert }, async (req, res) => {
    res.on('error', () => {});
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'https://127.0.0.1');
    const r = {
      at: performance.now(),
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      token: tokenOf(req),
      body: Buffer.concat(chunks).toString('utf8'),
    };
    xo.requests.push(r);
    const latency = typeof xo.latencyMs === 'function' ? xo.latencyMs(r) : xo.latencyMs;
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    if (res.destroyed) return;
    const answer = xo.replyFor?.(r) ?? route(r);
    if (answer === 'silent') return;
    if (answer === 'drop') {
      req.socket.destroy();
      return;
    }
    const text = typeof answer.body === 'string';
    const payload = text ? answer.body : JSON.stringify(answer.body);
    res.writeHead(answer.status, {
      'content-type': text ? 'text/plain' : 'application/json; charset=utf-8',
      date: new Date(xo.serverNow()).toUTCString(),
      ...(answer.headers ?? {}),
    });
    res.end(payload);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  xo.port = server.address().port;
  xo.address = `127.0.0.1:${xo.port}`;
  xo.close = async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  };
  return xo;
}
