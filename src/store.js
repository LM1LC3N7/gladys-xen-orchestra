// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in one small JSON file readable by the container user only:
//   - the certificate pinned for each Xen Orchestra address (a public value);
//   - a token refused by XO, as a 16-bit salted mark only (it can never tell
//     the token, it only says "the same one was refused");
//   - the end of a 429 / 5xx pause, the time of the last read;
//   - the stop guards: after a shutdown or forced shutdown of a VM, its Start
//     is refused until then (per VM, with the address of its XO).
// No token, no personal data.
//
// `load()` tells "no file" (null) from "a file that cannot be read" (throws):
// an unreadable /data is never taken for an empty one (no pin is learnt over
// it). A special file (FIFO, device, directory) is refused without opening
// it. Writes go one at a time (temporary file, then rename).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/xen-orchestra-state.json';
const MAX_SIZE = 64 * 1024;

export function fileStore(path = STATE_FILE) {
  let chain = Promise.resolve();
  return {
    async load() {
      let info;
      try {
        info = await lstat(path);
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw new Error(`state file unreadable (${err?.code ?? 'error'})`, { cause: err });
      }
      if (!info.isFile()) throw new Error('state file unreadable (not a regular file)');
      if (info.size > MAX_SIZE) throw new Error('state file too large');
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        throw new Error(`state file unreadable (${err?.code ?? 'error'})`, { cause: err });
      }
      if (text.length > MAX_SIZE) throw new Error('state file too large');
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('state file not JSON');
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        if (text.length > MAX_SIZE) throw new Error('state too large');
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip; `failLoad`, `failSave`, `hang`, `hangLoad` break it. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failLoad: false,
    failSave: false,
    hang: false,
    hangLoad: false,
    async load() {
      if (this.hangLoad) return new Promise(() => {});
      if (this.failLoad) throw new Error('state file unreadable (EIO)');
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.failSave) throw new Error('EROFS');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/**
 * The 16-bit mark of a refused token with a salt (0 to 65535): it only says
 * "the same one was refused"; a token of XO is 256 random bits, 16 of them
 * never help to find it.
 */
export const tokenMark = (salt, token) =>
  createHash('sha256').update(`${salt}\n${token}`, 'utf8').digest().readUInt16BE(0);

export const newSalt = () => randomBytes(8).toString('hex');

const ADDRESS = /^[a-z0-9.:[\]-]{1,260}$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An empty memory. */
export const emptyMemory = () => ({
  pins: {},
  refused: null,
  pausedUntil: null,
  lastReadAt: null,
  stopGuards: {},
});

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * The persisted state, repaired and bounded. A date in the future is not
 * trusted: the last read counts as now, a pause is at most 6 h from now, a
 * stop guard at most its full length from now.
 */
export function normalizeMemory(raw, now) {
  const data = isObject(raw) ? raw : {};
  const out = emptyMemory();
  for (const [address, fp] of isObject(data.pins) ? Object.entries(data.pins).slice(0, 8) : []) {
    if (ADDRESS.test(address) && typeof fp === 'string' && FINGERPRINT.test(fp)) {
      out.pins[address] = fp;
    }
  }
  const r = data.refused;
  if (
    isObject(r) &&
    typeof r.address === 'string' &&
    ADDRESS.test(r.address) &&
    typeof r.salt === 'string' &&
    /^[0-9a-f]{16}$/.test(r.salt) &&
    Number.isInteger(r.mark) &&
    r.mark >= 0 &&
    r.mark < 65536
  ) {
    out.refused = { address: r.address, salt: r.salt, mark: r.mark };
  }
  if (Number.isFinite(data.pausedUntil) && data.pausedUntil > now) {
    out.pausedUntil = Math.min(data.pausedUntil, now + TIMINGS.rateLimitMax);
  }
  if (Number.isFinite(data.lastReadAt)) out.lastReadAt = Math.min(data.lastReadAt, now);
  const guards = isObject(data.stopGuards) ? Object.entries(data.stopGuards) : [];
  for (const [uuid, g] of guards.slice(0, LIMITS.guards)) {
    if (
      UUID.test(uuid) &&
      isObject(g) &&
      typeof g.address === 'string' &&
      ADDRESS.test(g.address) &&
      Number.isFinite(g.until) &&
      g.until > now
    ) {
      out.stopGuards[uuid] = {
        address: g.address,
        until: Math.min(g.until, now + TIMINGS.stopGuard),
      };
    }
  }
  return out;
}
