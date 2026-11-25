// -----------------------------------------------------------------------------
// The REST API of Xen Orchestra (`/rest/v0`), as documented by Vates at
// https://docs.xen-orchestra.com/restapi and in the Swagger shipped with XO.
// Xen Orchestra is AGPL-3.0 software running at the user's: this module only
// calls its documented API; nothing of XO is copied nor ported.
//
// TLS: XO usually shows a self-signed certificate. The CA check is replaced
// by a pin: every connection is a bare TLS handshake first; the certificate
// seen is compared with the pinned SHA-256 fingerprint BEFORE anything is
// written or read. A mismatch closes the socket: the token never reaches
// another server. Then one HTTP request is written on that socket
// (`createConnection`, no agent, `Connection: close`): one request per
// connection, never a pipeline. There is no pin without the user: the first
// one comes from the fingerprint typed in the configuration or from two
// clicks on "Trust the certificate".
//
// Access (docs, "Authentication"): an authentication token in the
// `authenticationToken` cookie of each request. It is never logged nor put
// in an error message; errors never carry the path nor an answer's text
// beyond a short, cleaned reason. Redirections are never followed.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { TOKEN } from './config.js';
import { LIMITS, MAX_OBJECTS, PATHS, TIMINGS } from './constants.js';

export class XoError extends Error {
  /**
   * @param {'nopin'|'pin'|'unauth'|'forbidden'|'notfound'|'rate'|'refused'|'server'|'redirect'|'network'|'timeout'|'size'|'format'|'aborted'|'cancelled'} kind
   * @param {string} message never a token
   * @param {{ status?: number, sent?: boolean, retryAfter?: number, fingerprint?: string, xo?: boolean }} details
   *   sent: the request was written (it may have been done); status: XO answered;
   *   xo: the error came in the JSON envelope of XO (`{ "error": ... }`)
   */
  constructor(kind, message, { status, sent = false, retryAfter, fingerprint, xo = false } = {}) {
    super(message);
    this.name = 'XoError';
    this.kind = kind;
    this.status = status;
    this.sent = sent || status !== undefined;
    this.retryAfter = retryAfter;
    this.fingerprint = fingerprint;
    this.xo = xo;
  }

  /** XO answered (any status): the request reached it. */
  get answered() {
    return this.status !== undefined;
  }
}

const NETWORK = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

const networkError = (err, sent) =>
  err instanceof XoError
    ? err
    : new XoError('network', NETWORK[err?.code] ?? 'network error', { sent });

/** A short text of XO: no control character, nothing that looks like a token or a secret. */
export function cleanReason(text, secrets = []) {
  let out = typeof text === 'string' ? text : '';
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out
    .replace(/[0-9A-Za-z+/=_-]{20,}/g, '***')
    .replace(/[^\x20-\x7e\u00a0-\u024f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Retry-After (seconds, decimals accepted, or an HTTP date) -> ms, or undefined. */
export function retryAfterOf(value, serverDate) {
  if (value === undefined || value === null || value === '') return undefined;
  if (/^\d{1,9}(\.\d+)?$/.test(String(value).trim())) {
    return Math.round(Number(String(value).trim()) * 1000);
  }
  // An HTTP date is compared with XO's own Date header, never with the local
  // clock; without a readable one, the default pause applies.
  const date = Date.parse(String(value));
  const now = Date.parse(String(serverDate ?? ''));
  return Number.isFinite(date) && Number.isFinite(now) ? Math.max(0, date - now) : undefined;
}

export const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An object id of XO (a UUID), small letters; undefined otherwise. */
export const uuidOf = (v) => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : undefined);

/**
 * A TLS connection whose certificate is the pinned one; nothing is written nor
 * read before the check. Without a pin: refused (nothing sent).
 */
export function connectPinned({ host, port, pin, timeout = TIMINGS.connectTimeout, signal }) {
  return new Promise((resolve, reject) => {
    if (!pin) {
      reject(new XoError('nopin', 'certificate not pinned'));
      return;
    }
    let done = false;
    const socket = tls.connect({
      host,
      port,
      servername: isIP(host) ? undefined : host,
      // Self-signed: the CA check cannot pass; the pin below replaces it, on
      // this connection only (never for the whole process).
      rejectUnauthorized: false,
    });
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('secureConnect', onSecure);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(socket);
      }
    };
    const onAbort = () => finish(new XoError('aborted', 'stopped'));
    const onSecure = () => {
      const seen = socket.getPeerCertificate()?.fingerprint256;
      if (seen !== pin) {
        finish(
          new XoError('pin', 'the certificate of Xen Orchestra changed', {
            fingerprint: typeof seen === 'string' && FINGERPRINT.test(seen) ? seen : undefined,
          }),
        );
        return;
      }
      finish();
    };
    const timer = setTimeout(
      () => finish(new XoError('timeout', 'no TLS connection within the delay')),
      timeout,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('secureConnect', onSecure);
    socket.on('error', (err) => finish(networkError(err, false)));
  });
}

/** The fingerprint of the certificate XO shows (a bare handshake: nothing is sent). */
export function readFingerprint({ host, port, timeout = TIMINGS.connectTimeout }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = tls.connect({
      host,
      port,
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
    });
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new XoError('timeout', 'no TLS connection within the delay')),
      timeout,
    );
    socket.once('secureConnect', () => {
      const seen = socket.getPeerCertificate()?.fingerprint256;
      if (typeof seen === 'string' && FINGERPRINT.test(seen)) finish(undefined, seen);
      else finish(new XoError('format', 'no certificate shown'));
    });
    socket.on('error', (err) => finish(networkError(err, false)));
  });
}

/**
 * One request on a pinned connection; resolves { status, headers, body }.
 * `beforeSend()` runs once the certificate is checked, just before the first
 * byte of the request: it may throw to cancel (nothing sent).
 */
export async function pinnedRequest({
  host,
  port,
  pin,
  method,
  path,
  token,
  json,
  timeout = TIMINGS.readTimeout,
  idleTimeout = TIMINGS.idleTimeout,
  maxBytes = LIMITS.objectBytes,
  beforeSend,
  signal,
}) {
  const started = performance.now();
  const socket = await connectPinned({
    host,
    port,
    pin,
    timeout: Math.min(timeout, TIMINGS.connectTimeout),
    signal,
  });
  try {
    beforeSend?.();
  } catch (err) {
    socket.destroy();
    throw err;
  }
  const left = Math.max(1, timeout - (performance.now() - started));
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let idle;
    let req;
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      signal?.removeEventListener('abort', onAbort);
      req?.destroy();
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => settle(new XoError('aborted', 'stopped', { sent }));
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => settle(new XoError('timeout', 'Xen Orchestra stopped answering', { sent })),
        idleTimeout,
      );
    };
    const headers = { Accept: 'application/json', Connection: 'close' };
    if (token) headers.Cookie = `authenticationToken=${token}`;
    let body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    } else if (method === 'POST') {
      headers['Content-Length'] = 0;
    }
    const timer = setTimeout(
      () => settle(new XoError('timeout', 'no answer within the delay', { sent })),
      left,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // No agent: the verified socket is the connection (never `agent: false`).
      req = http.request({
        host,
        port,
        method,
        path,
        headers,
        createConnection: () => socket,
      });
    } catch {
      // An invalid header value (refused by Node before any byte is written).
      settle(new XoError('format', 'request not built'));
      return;
    }
    req.on('response', (res) => {
      armIdle();
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        settle(new XoError('size', 'answer too large', { status: res.statusCode }));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(new XoError('size', 'answer too large', { status: res.statusCode }));
          return;
        }
        chunks.push(chunk);
        armIdle();
      });
      res.on('end', () =>
        settle(undefined, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(networkError(err, true)));
    });
    req.on('error', (err) => settle(networkError(err, sent)));
    sent = true;
    armIdle();
    req.end(body);
  });
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The JSON of an answer, or the XoError it is. Errors of XO come as
 * `{ "error": "..." }` (seen on XO 5.214: 401 "invalid credentials", 404
 * "no such VM ..."). A 401 is "token not taken" for the caller to judge
 * (a refusal of the token only on the main read, and only in the envelope of
 * XO); a 403 is "this token lacks the rights".
 */
export function parseAnswer({ status, headers = {}, body }, { secrets = [] } = {}) {
  let json;
  try {
    json = body ? JSON.parse(body) : undefined;
  } catch {
    json = undefined;
  }
  const xo = isObject(json) && typeof json.error === 'string';
  const reason = xo ? cleanReason(json.error, secrets) : '';
  const at = { status, xo };
  if (status >= 300 && status < 400) {
    throw new XoError('redirect', `redirected (HTTP ${status})`, at);
  }
  if (status === 401) throw new XoError('unauth', 'token not taken (HTTP 401)', at);
  if (status === 403) throw new XoError('forbidden', 'not allowed for this user (HTTP 403)', at);
  if (status === 429) {
    throw new XoError('rate', 'too many requests (HTTP 429)', {
      ...at,
      retryAfter: retryAfterOf(headers['retry-after'], headers.date),
    });
  }
  if (status === 404) throw new XoError('notfound', 'not found (HTTP 404)', at);
  if (status >= 500) throw new XoError('server', `HTTP ${status}`, at);
  if (status >= 400) {
    throw new XoError('refused', reason ? `${reason} (HTTP ${status})` : `HTTP ${status}`, at);
  }
  if (status < 200 || status >= 300) throw new XoError('format', `HTTP ${status}`, at);
  return json;
}

/** The time of XO (its Date header), ms; undefined when unreadable. */
export const serverTime = (headers) => {
  const t = Date.parse(String(headers?.date ?? ''));
  return Number.isFinite(t) ? t : undefined;
};

/**
 * A collection of XO read with `fields`: an array of objects, each with the
 * `href` of its kind. Anything else is not an answer of XO (another web
 * server, an error page): never read as an empty collection.
 */
export function collectionOf(json, kind, max) {
  if (!Array.isArray(json)) throw new XoError('format', 'not an answer of Xen Orchestra');
  const prefix = `/rest/v0/${kind}/`;
  for (const item of json) {
    if (!isObject(item) || typeof item.href !== 'string' || !item.href.startsWith(prefix)) {
      throw new XoError('format', 'not an answer of Xen Orchestra');
    }
  }
  return { items: json.slice(0, max), overflow: json.length > max };
}

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** A name shown in Gladys: printable, no direction override, at most 64 characters (code points). */
export function cleanName(v) {
  if (typeof v !== 'string') return undefined;
  const text = v
    .replace(BIDI, '')
    .replace(/[\p{Cc}\p{Cs}\p{Co}\p{Cn}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return undefined;
  return [...text].slice(0, LIMITS.nameLength).join('').trim();
}

const VM_STATES = ['Running', 'Halted', 'Paused', 'Suspended'];
const HOST_STATES = ['Running', 'Halted', 'Unknown'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const positive = (v) => (num(v) !== undefined && v > 0 ? v : undefined);

/** A VM of `/vms` or `/vms/<uuid>`: strict values, anything else unknown (never 0). */
export function vmOf(item) {
  if (!isObject(item)) return undefined;
  const uuid = uuidOf(item.id);
  if (!uuid) return undefined;
  const memory = isObject(item.memory) ? item.memory : {};
  const ops = item.current_operations;
  return {
    uuid,
    name: cleanName(item.name_label),
    power: VM_STATES.includes(item.power_state) ? item.power_state : undefined,
    memorySize: positive(memory.size),
    startTime: num(item.startTime) ?? (item.startTime === null ? null : undefined),
    busy: isObject(ops) ? Object.keys(ops).length > 0 : undefined,
  };
}

export function hostOf(item) {
  if (!isObject(item)) return undefined;
  const uuid = uuidOf(item.id);
  if (!uuid) return undefined;
  const memory = isObject(item.memory) ? item.memory : {};
  const size = positive(memory.size);
  const usage = num(memory.usage);
  return {
    uuid,
    name: cleanName(item.name_label),
    power: HOST_STATES.includes(item.power_state) ? item.power_state : undefined,
    memoryUsage:
      size !== undefined && usage !== undefined && usage >= 0 && usage <= size
        ? Math.round((usage / size) * 1000) / 10
        : undefined,
    version: cleanName(item.version),
    brand: cleanName(item.productBrand),
  };
}

/** A storage repository; ISO libraries and removable devices are left out (no free space to watch). */
export function srOf(item) {
  if (!isObject(item)) return undefined;
  const uuid = uuidOf(item.id);
  if (!uuid) return undefined;
  if (item.content_type === 'iso' || item.SR_type === 'iso' || item.SR_type === 'udev') {
    return null;
  }
  const size = positive(item.size);
  const used = num(item.physical_usage);
  const valid = size !== undefined && used !== undefined && used >= 0 && used <= size;
  return {
    uuid,
    name: cleanName(item.name_label),
    type: typeof item.SR_type === 'string' ? item.SR_type.slice(0, 20) : undefined,
    size,
    usage: valid ? Math.round((used / size) * 1000) / 10 : undefined,
    free: valid ? size - used : undefined,
  };
}

export function jobOf(item) {
  if (!isObject(item)) return undefined;
  const id = uuidOf(item.id);
  if (!id) return undefined;
  return { id, name: cleanName(item.name), type: cleanName(item.type), mode: cleanName(item.mode) };
}

const LOG_STATES = ['failure', 'interrupted', 'pending', 'success', 'skipped'];
const LOG_ID = /^[0-9a-z]{1,40}$/i;
export function logOf(item) {
  if (!isObject(item)) return undefined;
  const jobId = uuidOf(item.jobId);
  if (!jobId || typeof item.id !== 'string' || !LOG_ID.test(item.id)) return undefined;
  const start = num(item.start);
  if (start === undefined) return undefined;
  const end = num(item.end);
  return {
    id: item.id,
    jobId,
    status: LOG_STATES.includes(item.status) ? item.status : undefined,
    start,
    end: end !== undefined && end >= start ? end : undefined,
  };
}

/** The last number of a series of XAPI samples (null and NaN are gaps). */
const lastOf = (series) => {
  if (!Array.isArray(series)) return undefined;
  for (let i = series.length - 1; i >= Math.max(0, series.length - 6); i -= 1) {
    const v = num(series[i]);
    if (v !== undefined) return v;
  }
  return undefined;
};

/**
 * The CPU (%, the mean of the vCPUs) and memory used (%) of the newest samples
 * of `/vms/<uuid>/stats`. The REST API gives `cpus` per vCPU in percent (its
 * dashboard shows the same VMs at about 1 %, the stats examples at 0.1),
 * `memory` and `memoryFree` in bytes (`memoryFree` only with the guest tools).
 * A vCPU outside 0..105 % is not a measure. `endTimestamp` (s) dates the
 * samples.
 */
export function statsOf(json) {
  if (!isObject(json) || !isObject(json.stats)) {
    throw new XoError('format', 'not statistics of Xen Orchestra');
  }
  const end = num(json.endTimestamp);
  const stats = json.stats;
  let cpu;
  if (isObject(stats.cpus)) {
    const values = Object.values(stats.cpus).slice(0, 256).map(lastOf);
    if (values.length > 0 && values.every((v) => v !== undefined && v >= 0 && v <= 105)) {
      cpu = Math.round(Math.min(100, values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
    }
  }
  const total = lastOf(stats.memory);
  const free = lastOf(stats.memoryFree);
  const memory =
    total !== undefined && total > 0 && free !== undefined && free >= 0 && free <= total
      ? Math.round(((total - free) / total) * 1000) / 10
      : undefined;
  return { cpu, memory, at: end !== undefined && end > 0 ? end * 1000 : undefined };
}

/** A token of `POST /users/authentication_tokens` (201): its value and dates. */
export function newTokenOf(json) {
  const t = isObject(json) && isObject(json.token) ? json.token : undefined;
  if (!t || typeof t.id !== 'string' || !TOKEN.test(t.id)) {
    throw new XoError('format', 'Xen Orchestra answered without a token');
  }
  return { token: t.id, expiration: num(t.expiration), created: num(t.created_at) };
}

/**
 * A client of one Xen Orchestra: its address, pinned certificate and token are
 * frozen for the client's life (a configuration saved meanwhile never sends
 * its token through an older client, nor an older token to another address).
 */
export function createXo({ host, port, pin, token, request, signal }) {
  const send = request ?? pinnedRequest;
  const call = async (method, path, options = {}) => {
    const answer = await send({ host, port, pin, method, path, signal, token, ...options });
    const json = parseAnswer(answer, { secrets: [token] });
    return {
      json,
      status: answer.status,
      date: serverTime(answer.headers),
      headers: answer.headers,
    };
  };
  const collection = async (path, kind, max, parse, o = {}) => {
    const { json, date } = await call('GET', path, { maxBytes: LIMITS.collectionBytes, ...o });
    const { items, overflow } = collectionOf(json, kind, max);
    const out = [];
    let skipped = 0;
    for (const item of items) {
      const v = parse(item);
      if (v === undefined) skipped += 1;
      else if (v !== null) out.push(v);
    }
    return { items: out, overflow, skipped, date };
  };
  return {
    host,
    port,
    pin,
    token,
    vms: (o) => collection(PATHS.vms, 'vms', MAX_OBJECTS.vms, vmOf, o),
    hosts: (o) => collection(PATHS.hosts, 'hosts', MAX_OBJECTS.hosts, hostOf, o),
    srs: (o) => collection(PATHS.srs, 'srs', MAX_OBJECTS.srs, srOf, o),
    jobs: (o) => collection(PATHS.backupJobs, 'backup-jobs', MAX_OBJECTS.jobs, jobOf, o),
    logs: (since, o) =>
      collection(PATHS.backupLogs(since), 'backup-logs', MAX_OBJECTS.logs, logOf, o),
    /** One VM read again (a command decides on it). Another id than asked is refused. */
    vm: async (uuid, o) => {
      const { json, date } = await call('GET', PATHS.vm(uuid), o);
      const vm = vmOf(json);
      if (!vm || vm.uuid !== uuid) throw new XoError('format', 'not the VM asked');
      return { vm, date };
    },
    stats: async (uuid, o) => {
      const { json, date } = await call('GET', PATHS.vmStats(uuid), o);
      return { ...statsOf(json), date };
    },
    /** One action, answered 202 (a task) or 204 once XO took it. */
    action: async (uuid, action, o) => {
      const { status } = await call('POST', PATHS.vmAction(uuid, action), o);
      if (status !== 202 && status !== 204 && status !== 200) {
        throw new XoError('format', `HTTP ${status}`, { status });
      }
      return status;
    },
    /** The id of the token's user, from the 307 of `/users/me` (never followed). */
    userId: async (o) => {
      const answer = await send({
        host,
        port,
        pin,
        method: 'GET',
        path: PATHS.me,
        signal,
        token,
        maxBytes: 16 * 1024,
        ...o,
      });
      if (answer.status !== 307) {
        parseAnswer(answer, { secrets: [token] });
        throw new XoError('format', 'no user in the answer of Xen Orchestra');
      }
      const match = /^\/rest\/v0\/users\/([0-9a-f-]{36})$/i.exec(
        String(answer.headers?.location ?? ''),
      );
      const id = uuidOf(match?.[1]);
      if (!id) throw new XoError('format', 'no user in the answer of Xen Orchestra');
      return id;
    },
    /** The expiry of this client's token, from the token list of its user. */
    tokenInfo: async (userId, o) => {
      const { json, date } = await call('GET', PATHS.tokens(userId), o);
      if (!Array.isArray(json)) throw new XoError('format', 'not an answer of Xen Orchestra');
      const mine = json.find((t) => isObject(t) && t.id === token);
      if (!mine) return { found: false, date };
      return { found: true, expiration: num(mine.expiration), created: num(mine.created_at), date };
    },
    /** A new token for the same user, created with this one (docs: "renew"). */
    renew: async (userId, o) => {
      if (!uuidOf(userId)) throw new XoError('format', 'no user to renew the token of');
      const { json, status, date } = await call('POST', PATHS.tokens(userId), {
        json: { description: 'Gladys Assistant (renewed)' },
        ...o,
      });
      if (status !== 201 && status !== 200) throw new XoError('format', `HTTP ${status}`);
      return { ...newTokenOf(json), date };
    },
  };
}
