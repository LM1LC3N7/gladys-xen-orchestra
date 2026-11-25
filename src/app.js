// -----------------------------------------------------------------------------
// The integration: one Xen Orchestra (REST API `/rest/v0`, local HTTPS,
// pinned certificate, an authentication token of XO), its hosts, VMs,
// storage repositories and backup jobs, as Gladys devices (Discovery).
//
// Access: the token of the configuration in the `authenticationToken` cookie.
// Refused (401 in the envelope of XO on the main read, the VM list): kept as a
// 6-bit mark in /data, never tried again alone (a new token saved, or the Test
// button, tries again). A 401/403 on any other route is never a refusal.
// The token is renewed before it expires (docs: a POST with the current token
// creates a new one), and the new one is given back to Gladys (setConfig of
// the `token` field): the user never types a password here.
//
// Reads, at the interval (60 s by default), never sooner after the last one,
// even across a restart (/data): the VMs (the main read), then the hosts, the
// storage repositories, the backup jobs and their recent runs, and the
// statistics of up to 10 running VMs in turn. Every read but the VMs is
// secondary: its failure never stops the others. A 429, or a 5xx on a
// collection, pauses every path (bounded, kept in /data).
//
// VM buttons (`button`/`push`, never a switch):
//   - Start is allowed; Shut down (clean), Force shutdown and Restart (clean)
//     are off by default, one option each.
//   - Each decides on a read of the VM made after the click, is checked again
//     right before its first byte (option, pause, a newer stop of the VM,
//     the stop guard, the deadline), runs one at a time per VM, one per 15 s
//     per VM, and leaves within 3.5 s or not at all.
//   - A shutdown or forced shutdown refuses Start of that VM for 60 s (a
//     guard written to /data BEFORE the first byte; not written: nothing
//     sent). A Start not sent yet is cancelled by a stop of the same VM.
//   - A command is "done" only once a later read shows it (power state, or a
//     new start time for a restart); reads follow at 5 s, 20 s, ...
//
// Clocks: wall time only for /data; XO's Date header (moved on by the
// monotonic clock) for the ages of XO's data; monotonic for every decision.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseAddress, sameConfig, sameSession } from './config.js';
import { BUTTONS, FEATURES, LIMITS, PRESSED, TIMINGS } from './constants.js';
import { buildDevice, idsOf, parseExternalId } from './devices.js';
import { T, powerWord, statusWord, word } from './i18n.js';
import { emptyMemory, fileStore, newSalt, normalizeMemory, tokenMark } from './store.js';
import { XoError, createXo, readFingerprint } from './xo.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const DAY = 24 * 3_600_000;
const MIB = 1024 * 1024;
const GB = 1e9;
const round1 = (n) => Math.round(n * 10) / 10;

/** A command refused or failed, with the text the user reads (in the configured language). */
export class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
  }
}

/**
 * A 429, or a 5xx that is not an error of XO itself (a proxy, XO overloaded:
 * 502, 503, 504, or no envelope of XO): every path waits. A 500 in the
 * envelope of XO is an error of XAPI about one object (a VM in the wrong
 * state): it pauses nothing.
 */
export const pausing = (err) =>
  err?.kind === 'rate' || (err?.kind === 'server' && !(err.status === 500 && err.xo));

/** The power state a command reaches (undefined for a restart: its start time changes). */
const WANTED = { start: 'Running', clean_shutdown: 'Halted', hard_shutdown: 'Halted' };

export class XoApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'xen-orchestra' }),
    store = fileStore(),
    now = Date.now,
    mono = () => performance.now(),
    timers = globalThis,
    fingerprint = readFingerprint,
    request,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.mono = mono;
    this.timers = timers;
    this.readFingerprint = fingerprint;
    this.request = request;
    this.raw = {};
    this.config = normalizeConfig();
    this.memory = emptyMemory();
    /** 'unloaded' | 'loaded' | 'unreadable' */
    this.memoryState = 'unloaded';
    this.generation = 0;
    this.started = false;
    this.closed = false;
    this.connectSeq = 0;
    this.configFailures = 0;
    this.configTimer = undefined;
    this.memoryTimer = undefined;
    // Session (reset at each start).
    this.client = null;
    this.abort = new AbortController();
    this.online = false;
    this.lastError = undefined;
    this.failures = 0;
    this.reading = false;
    this.readTimer = undefined;
    this.lastReadMono = -Infinity;
    this.blocked = false;
    this.pauseEnd = -Infinity;
    this.pinError = undefined;
    // Token renewal (memory only: the token itself is never in /data).
    /** { from, to }: the token `from` of the configuration was renewed into `to`. */
    this.renewed = null;
    this.keepTimer = undefined;
    /** { token, userId, due (mono), hold: { n, until } } */
    this.tokenCheck = undefined;
    /** { expiresIn (ms at `at`), at (mono) } of the token in use, when read. */
    this.tokenExpiry = undefined;
    this.tokenTrouble = undefined;
    // What was read.
    this.inventory = { hosts: [], vms: [], srs: [], jobs: [] };
    this.overflow = false;
    /** The date of XO (its Date header) and the monotonic time it was read. */
    this.serverClock = undefined;
    this.readAt = -Infinity;
    /** Fresh reads of this cycle: { hosts, srs, backups } true when read now. */
    this.fresh = { hosts: false, srs: false, backups: false };
    /** jobId -> { last, lastSuccessEnd } of the recent runs. */
    this.runs = new Map();
    /** uuid -> { cpu, memory, at (mono) } */
    this.stats = new Map();
    this.statsCursor = 0;
    this.holds = new Map();
    // Commands, per VM.
    /** uuid -> { busy, last (mono), epoch } */
    this.vmCommands = new Map();
    /** uuid -> end (mono) of the stop guard */
    this.guards = new Map();
    this.followUps = new Set();
    this.unconfirmed = new Set();
    /** The last command result shown in the status: { text, at } */
    this.note = undefined;
    // Gladys side.
    this.created = new Set();
    this.discoveredKey = undefined;
    this.transports = new Map();
    this.lastStatus = undefined;
    this.published = new Map();
    this.stateWindow = [];
    this.stateCursor = 0;
    // Buttons of the configuration screen.
    this.lastTest = undefined;
    this.pendingTrust = undefined;
    this.lastAttemptSaved = -Infinity;
  }

  /** A timer of the app: never armed for an endless or a negative delay. */
  later(ms, fn) {
    const delay = Number.isFinite(ms) ? clamp(ms, 0, TIMINGS.rateLimitMax) : TIMINGS.retryMax;
    return this.timers.setTimeout(fn, delay);
  }

  // --- /data ---------------------------------------------------------------------

  /** A promise bounded in time: a slow /data never holds what waits on it. */
  bounded(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => reject(new Error('timed out')), ms);
      Promise.resolve(promise).then(
        (v) => {
          this.timers.clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          this.timers.clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /** One read of /data at a time (a slow one is waited for by the next try). */
  readStore() {
    if (!this.loading) {
      this.loading = Promise.resolve()
        .then(() => this.store.load())
        .finally(() => {
          this.loading = undefined;
        });
    }
    return this.loading;
  }

  async loadMemory() {
    if (this.memoryState !== 'unloaded') return;
    try {
      const raw = await this.bounded(this.readStore(), TIMINGS.dataWait);
      this.memory = normalizeMemory(raw, this.now());
      this.memoryState = 'loaded';
    } catch (err) {
      // Unreadable is not empty: nothing learnt is written over it; read again
      // every 10 s (one read at a time), the start goes on meanwhile.
      this.memoryState = 'unreadable';
      this.logger.warn(
        `Xen Orchestra: /data unreadable (${err?.message ?? 'error'}): read again in 10 s`,
      );
      this.armMemoryRetry();
    }
    this.memoryTimes();
  }

  /** The pause, the last read and the stop guards kept in /data, applied to the clocks of this run. */
  memoryTimes() {
    const now = this.now();
    const mono = this.mono();
    const left = (this.memory.pausedUntil ?? 0) - now;
    if (left > 0) {
      this.pauseEnd = Math.max(this.pauseEnd, mono + Math.min(left, TIMINGS.rateLimitMax));
    }
    // Written at most once a minute: it may have been up to a minute later than kept.
    if (this.memory.lastReadAt !== null) {
      const ago = Math.max(0, now - this.memory.lastReadAt - TIMINGS.attemptWriteEvery);
      this.lastReadMono = Math.max(this.lastReadMono, mono - ago);
    }
    for (const [uuid, guard] of Object.entries(this.memory.stopGuards)) {
      if (guard.until > now) {
        const end = mono + Math.min(guard.until - now, TIMINGS.stopGuard);
        this.guards.set(uuid, Math.max(this.guards.get(uuid) ?? -Infinity, end));
      }
    }
  }

  armMemoryRetry() {
    if (this.memoryTimer !== undefined || this.closed) return;
    this.memoryTimer = this.later(TIMINGS.dataRetry, async () => {
      this.memoryTimer = undefined;
      if (this.memoryState !== 'unreadable' || this.closed) return;
      let raw;
      try {
        raw = await this.bounded(this.readStore(), TIMINGS.dataWait);
      } catch {
        this.armMemoryRetry();
        return;
      }
      if (this.memoryState !== 'unreadable' || this.closed) return;
      this.adoptLateMemory(raw);
    });
  }

  /** /data read at last: what this run decided meanwhile wins; the session starts again with it. */
  adoptLateMemory(raw) {
    const late = normalizeMemory(raw, this.now());
    const mine = this.memory;
    late.pins = { ...late.pins, ...mine.pins };
    if (mine.refused) late.refused = mine.refused;
    late.pausedUntil = Math.max(late.pausedUntil ?? 0, mine.pausedUntil ?? 0) || null;
    late.lastReadAt = Math.max(late.lastReadAt ?? 0, mine.lastReadAt ?? 0) || null;
    for (const [uuid, guard] of Object.entries(mine.stopGuards)) {
      if (!late.stopGuards[uuid] || guard.until > late.stopGuards[uuid].until) {
        late.stopGuards[uuid] = guard;
      }
    }
    this.memory = late;
    this.memoryState = 'loaded';
    this.memoryTimes();
    this.logger.info('Xen Orchestra: /data read');
    this.saveSoon().catch(() => {});
    if (this.started && !this.closed) this.background(this.start(this.raw));
  }

  /** Writes /data in the background (never awaited on a command path). */
  saveSoon() {
    if (this.memoryState !== 'loaded') return Promise.reject(new Error('/data unreadable'));
    const write = Promise.resolve(this.store.save(this.memory));
    write.catch((err) => this.logger.warn(`Xen Orchestra: writing /data failed (${err?.message})`));
    return write;
  }

  /** Writes /data and waits for it, bounded: for what must be kept before going on. */
  async saveNow(ms = TIMINGS.dataWait) {
    if (this.memoryState !== 'loaded') throw new Error('/data unreadable');
    await this.bounded(this.store.save(this.memory), ms);
  }

  // --- Lifecycle -----------------------------------------------------------------

  /**
   * Connected to Gladys (the first time and after every reconnection): the
   * configuration is read; when that fails, it is tried again, spaced (5 s,
   * 15 s, 30 s, then every minute), without end, the status saying so.
   */
  async connectedWith(getConfig) {
    const seq = ++this.connectSeq;
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (seq !== this.connectSeq || this.closed) return;
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures, TIMINGS.configRetry.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `Xen Orchestra: reading the configuration failed (${err?.message ?? 'error'}); next try in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(Math.round(wait / 1000)));
      if (seq !== this.connectSeq || this.closed) return;
      this.configTimer = this.later(wait, () => {
        this.configTimer = undefined;
        this.connectedWith(getConfig).catch(() => this.logger.error('Xen Orchestra: start failed'));
      });
      return;
    }
    if (seq !== this.connectSeq || this.closed) return;
    this.configFailures = 0;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw);
  }

  async configUpdated(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw);
  }

  /** The same configuration keeps the session; options only keep it too; another one starts again. */
  async applyConfig(raw) {
    const next = normalizeConfig(raw);
    if (sameConfig(next, this.config)) {
      this.raw = { ...(raw ?? {}) };
      // Gladys may have restarted: what it keeps in memory only is sent again
      // (status, Discovery, badges), never an old value as a new one.
      this.lastStatus = undefined;
      this.discoveredKey = undefined;
      this.transports.clear();
      this.refreshCreated();
      await this.publishDiscovery();
      await this.showStatus();
      await this.publishTransports();
      return;
    }
    if (sameSession(next, this.config)) {
      // Options only (buttons, language, interval): the session goes on.
      this.raw = { ...(raw ?? {}) };
      this.config = next;
      this.discoveredKey = undefined;
      await this.publishDiscovery();
      if (this.online && !this.reading) {
        const interval = this.readInterval();
        this.scheduleRead(
          this.generation,
          clamp(this.lastReadMono + interval - this.mono(), 0, interval),
        );
      }
      await this.showStatus();
      return;
    }
    this.logger.info('Xen Orchestra: configuration changed, starting again');
    await this.start(raw);
  }

  /**
   * A new session. The first read is `tick`'s to time: never sooner than the
   * interval after the last read (this run, or /data after a restart), nor
   * during a pause; another address or token reads at once.
   */
  async start(raw = {}) {
    this.stop();
    const generation = this.generation;
    this.raw = { ...(raw ?? {}) };
    const previous = this.config;
    this.config = normalizeConfig(raw);
    await this.loadMemory();
    if (!this.current(generation)) return;
    const c = this.config;
    // A renewed token belongs to the token it replaced; another one typed drops it.
    if (this.renewed && c.token !== this.renewed.from && c.token !== this.renewed.to) {
      this.renewed = null;
    }
    if (this.renewed && c.token === this.renewed.to) this.renewed = null;
    const accountChanged =
      previous.address !== undefined &&
      (previous.address !== c.address || previous.token !== c.token);
    if (accountChanged) {
      this.lastReadMono = -Infinity;
      this.holds.clear();
    }
    if (previous.address !== c.address) {
      this.inventory = { hosts: [], vms: [], srs: [], jobs: [] };
      this.runs.clear();
      this.stats.clear();
      this.serverClock = undefined;
    }
    if (this.tokenCheck?.token !== this.token()) {
      this.tokenCheck = undefined;
      this.tokenExpiry = undefined;
      this.tokenTrouble = undefined;
    }
    this.abort = new AbortController();
    this.online = false;
    this.lastError = undefined;
    this.failures = 0;
    this.pinError = undefined;
    this.lastStatus = undefined;
    this.discoveredKey = undefined;
    this.transports.clear();
    this.refreshCreated();
    this.adoptConfigPin();
    this.blocked = this.refusalKept();
    if (c.error) {
      await this.showStatus();
      return;
    }
    if (this.renewed) this.armKeep(0);
    await this.publishDiscovery();
    await this.showStatus();
    if (!this.current(generation)) return;
    this.scheduleRead(generation, 0);
  }

  /** The reads and the timers of this run end. */
  stop({ shutdown = false } = {}) {
    this.generation += 1;
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    for (const timer of this.followUps) this.timers.clearTimeout(timer);
    this.followUps.clear();
    this.unconfirmed.clear();
    this.timers.clearTimeout(this.keepTimer);
    this.keepTimer = undefined;
    this.abort.abort();
    this.client = null;
    this.online = false;
    this.reading = false;
    if (shutdown) {
      this.closed = true;
      this.timers.clearTimeout(this.configTimer);
      this.timers.clearTimeout(this.memoryTimer);
      this.memoryTimer = undefined;
      this.configTimer = undefined;
    }
  }

  /** The container stops: everything ends; /data keeps the last state (bounded wait). */
  async shutdown() {
    this.stop({ shutdown: true });
    if (this.memoryState === 'loaded') await this.saveNow().catch(() => {});
  }

  current(generation) {
    return generation === this.generation && !this.closed;
  }

  pauseLeft() {
    return Math.max(0, this.pauseEnd - this.mono());
  }

  paused() {
    return this.pauseLeft() > 0;
  }

  // --- Pin, token, refusal ---------------------------------------------------------

  /** The pin of the configuration's address: the field typed by the user, else /data. */
  pin(address = this.config.address) {
    if (address === this.config.address && this.config.fingerprint) return this.config.fingerprint;
    return this.memory.pins[address];
  }

  /** A fingerprint typed in the configuration is kept in /data (it is the pin from then on). */
  adoptConfigPin() {
    const { address, fingerprint } = this.config;
    if (!address || !fingerprint || this.memory.pins[address] === fingerprint) return;
    this.memory.pins[address] = fingerprint;
    this.saveSoon().catch(() => {});
  }

  /** The token in use for configuration `c`: the renewed one when it replaced c's. */
  token(c = this.config) {
    if (c.error || !c.token) return '';
    if (this.renewed && this.renewed.from === c.token) return this.renewed.to;
    return c.token;
  }

  refusalKept() {
    const r = this.memory.refused;
    const c = this.config;
    const token = this.token();
    if (!r || r.address !== c.address || !token) return false;
    return tokenMark(r.salt, token) === r.mark;
  }

  /** The token was refused (401 of XO on the VM list): kept, never tried alone. */
  refuseToken(address, token) {
    if (address !== this.config.address || token !== this.token()) return;
    if (this.blocked) return;
    this.blocked = true;
    this.logger.warn(
      'Xen Orchestra: the token was refused; waiting for a new one or the Test button',
    );
    const salt = newSalt();
    this.memory.refused = { address, salt, mark: tokenMark(salt, token) };
    this.saveSoon().catch(() => {});
  }

  clearRefusal() {
    this.blocked = false;
    if (this.memory.refused) {
      this.memory.refused = null;
      this.saveSoon().catch(() => {});
    }
  }

  /** A client of this session (address, pin and token frozen). */
  sessionClient() {
    if (!this.client) this.client = this.newClient(this.abort.signal);
    return this.client;
  }

  /**
   * A client of one XO: its address, pin and token are those of `c` when it
   * is built, for its whole life. A configuration saved meanwhile never sends
   * its token through it, nor this token elsewhere.
   */
  newClient(signal, c = this.config, pin = this.pin()) {
    return createXo({
      host: c.host,
      port: c.port,
      pin,
      token: this.token(c),
      request: this.request,
      signal,
    });
  }

  // --- Reading -------------------------------------------------------------------

  readInterval() {
    return this.config.pollInterval * 1000;
  }

  scheduleRead(generation, ms) {
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = this.later(ms, () => {
      this.readTimer = undefined;
      if (this.current(generation)) {
        this.tick(generation).catch((err) =>
          this.logger.error(`Xen Orchestra loop: ${err?.message}`),
        );
      }
    });
  }

  /** Records the time of a read before it leaves (in /data at most once a minute). */
  noteAttempt() {
    const now = this.mono();
    this.lastReadMono = now;
    if (this.memoryState !== 'loaded') return;
    if (now - this.lastAttemptSaved < TIMINGS.attemptWriteEvery) return;
    this.lastAttemptSaved = now;
    this.memory.lastReadAt = this.now();
    this.saveSoon().catch(() => {});
  }

  /** Why no read can leave now (nothing sent), or undefined. */
  readBlocker() {
    if (this.config.error) return 'config';
    if (!this.pin()) return 'nopin';
    if (this.blocked) return 'token';
    return undefined;
  }

  /** XO's time now: its last Date header moved on by the monotonic clock (undefined: unknown). */
  serverNow() {
    if (!this.serverClock) return undefined;
    return this.serverClock.date + (this.mono() - this.serverClock.at);
  }

  noteServerDate(date) {
    if (date !== undefined) this.serverClock = { date, at: this.mono() };
  }

  async tick(generation) {
    if (!this.current(generation) || this.reading) return;
    if (this.readBlocker()) {
      this.online = false;
      await this.showStatus();
      await this.publishTransports();
      return;
    }
    if (this.paused()) {
      await this.showStatus();
      this.scheduleRead(generation, this.pauseLeft());
      return;
    }
    // Never sooner than the interval after the last read, whoever made it.
    const early = this.lastReadMono + this.readInterval() - this.mono();
    if (early > 0) {
      this.scheduleRead(generation, early);
      return;
    }
    this.reading = true;
    const client = this.sessionClient();
    const previousRead = this.lastReadMono;
    const address = this.config.address;
    this.noteAttempt();
    try {
      const vms = await client.vms();
      if (!this.current(generation)) return;
      this.noteServerDate(vms.date);
      this.inventory.vms = vms.items;
      await this.readSecondary(client, generation);
      if (!this.current(generation)) return;
      await this.takeRead(vms);
    } catch (err) {
      // A certificate refused at the handshake: nothing reached XO, so it does
      // not count as a read.
      if (err?.kind === 'pin' || err?.kind === 'nopin') this.lastReadMono = previousRead;
      if (this.current(generation)) await this.fail(generation, err, address, client.token);
      return;
    } finally {
      if (this.current(generation)) this.reading = false;
    }
    if (!this.current(generation)) return;
    this.scheduleRead(generation, this.readInterval());
  }

  /** A secondary path refused or failing: spaced (doubling up to 1 h); true while held. */
  held(name) {
    const hold = this.holds.get(name);
    return Boolean(hold && this.mono() < hold.until);
  }

  hold(name, err) {
    const n = (this.holds.get(name)?.n ?? 0) + 1;
    const base = Math.max(this.readInterval(), TIMINGS.retryMin);
    this.holds.set(name, {
      n,
      until: this.mono() + Math.min(TIMINGS.secondaryMax, base * 2 ** n),
    });
    this.logger.debug?.(`Xen Orchestra: ${name} not read (${err?.message})`);
  }

  /**
   * A secondary read: its failure never stops the others. A certificate
   * changed or a stop ends the cycle; a 429 pauses every path; a 5xx of a
   * collection too. A 401/403 here is never a refusal of the token.
   */
  async secondary(name, generation, fn, { pauseOn5xx = true } = {}) {
    if (this.held(name)) return undefined;
    try {
      const value = await fn();
      this.holds.delete(name);
      return value;
    } catch (err) {
      if (['pin', 'nopin', 'aborted'].includes(err?.kind)) throw err;
      if (err?.kind === 'rate' || (pauseOn5xx && pausing(err))) this.pause(err);
      if (this.current(generation)) this.hold(name, err);
      return undefined;
    }
  }

  async readSecondary(client, generation) {
    this.fresh = { hosts: false, srs: false, backups: false };
    const hosts = await this.secondary('hosts', generation, () => client.hosts());
    if (!this.current(generation)) return;
    if (hosts) {
      this.inventory.hosts = hosts.items;
      this.fresh.hosts = true;
    }
    if (this.paused()) return;
    const srs = await this.secondary('srs', generation, () => client.srs());
    if (!this.current(generation)) return;
    if (srs) {
      this.inventory.srs = srs.items;
      this.fresh.srs = true;
    }
    if (this.paused()) return;
    await this.readBackups(client, generation);
    if (!this.current(generation) || this.paused()) return;
    await this.readStats(client, generation);
    if (!this.current(generation) || this.paused()) return;
    await this.checkToken(client, generation);
  }

  /** The backup jobs and their runs started within 8 days (by XO's own time). */
  async readBackups(client, generation) {
    const jobs = await this.secondary('jobs', generation, () => client.jobs());
    if (!this.current(generation) || !jobs) return;
    this.inventory.jobs = jobs.items;
    const now = this.serverNow();
    // Without a readable time of XO, no window: the runs are not read.
    if (now === undefined) return;
    const since = Math.floor(now - TIMINGS.backupWindow);
    const logs = await this.secondary('logs', generation, () => client.logs(since));
    if (!this.current(generation) || !logs) return;
    const runs = new Map();
    for (const log of logs.items) {
      const r = runs.get(log.jobId) ?? {
        last: undefined,
        done: undefined,
        lastSuccessEnd: undefined,
      };
      if (!r.last || log.start > r.last.start) r.last = log;
      if (
        log.status !== 'pending' &&
        log.status !== undefined &&
        (!r.done || log.start > r.done.start)
      ) {
        r.done = log;
      }
      if (log.status === 'success' && log.end !== undefined) {
        r.lastSuccessEnd = Math.max(r.lastSuccessEnd ?? 0, log.end);
      }
      runs.set(log.jobId, r);
    }
    this.runs = runs;
    this.fresh.backups = true;
  }

  /** CPU and memory of up to 10 running VMs per cycle, in turn (each failure stays its own). */
  async readStats(client, generation) {
    const running = this.inventory.vms.filter((v) => v.power === 'Running');
    const keep = new Set(running.map((v) => v.uuid));
    for (const uuid of this.stats.keys()) if (!keep.has(uuid)) this.stats.delete(uuid);
    if (running.length === 0) return;
    const count = Math.min(LIMITS.statsPerCycle, running.length);
    const start = this.statsCursor % running.length;
    this.statsCursor = start + count;
    for (let i = 0; i < count; i += 1) {
      if (!this.current(generation) || this.paused()) return;
      const vm = running[(start + i) % running.length];
      const s = await this.secondary(`stats:${vm.uuid}`, generation, () => client.stats(vm.uuid), {
        pauseOn5xx: false,
      });
      if (!this.current(generation)) return;
      if (!s) continue;
      // Samples older than 5 min by XO's own clock are not a measure of now.
      const at = s.date ?? this.serverNow();
      const fresh = s.at !== undefined && at !== undefined && at - s.at <= TIMINGS.statsMaxAge;
      if (fresh) this.stats.set(vm.uuid, { cpu: s.cpu, memory: s.memory, at: this.mono() });
      else this.stats.delete(vm.uuid);
    }
  }

  // --- Token renewal -----------------------------------------------------------------

  /**
   * The expiry of the token in use, read at most every 12 h (its user's token
   * list, a secondary read). Renewed when less than half its life, or 7 days,
   * is left, by XO's own time; without a readable time, never "expired".
   */
  async checkToken(client, generation) {
    const token = client.token;
    if (!token || token !== this.token()) return;
    const check = this.tokenCheck?.token === token ? this.tokenCheck : { token };
    this.tokenCheck = check;
    if (check.due !== undefined && this.mono() < check.due) return;
    if (this.held('token')) return;
    check.due = this.mono() + TIMINGS.tokenCheckEvery;
    const info = await this.secondary('token', generation, async () => {
      if (!check.userId) check.userId = await client.userId();
      return client.tokenInfo(check.userId);
    });
    if (!this.current(generation)) return;
    if (!info) {
      check.due = this.mono() + Math.min(TIMINGS.tokenCheckEvery, 3_600_000);
      return;
    }
    if (!info.found || info.expiration === undefined) {
      this.tokenExpiry = info.found ? { never: true } : undefined;
      return;
    }
    if (info.date === undefined) return;
    const left = info.expiration - info.date;
    this.tokenExpiry = { left, at: this.mono() };
    const life = info.created !== undefined ? info.expiration - info.created : 30 * DAY;
    if (left > Math.min(life / 2, 7 * DAY)) return;
    await this.renewToken(client, generation);
  }

  async renewToken(client, generation) {
    const from = this.config.token;
    let fresh;
    try {
      fresh = await client.renew();
    } catch (err) {
      if (['pin', 'nopin', 'aborted'].includes(err?.kind)) throw err;
      if (err?.kind === 'rate') this.pause(err);
      this.tokenTrouble = err;
      // Tried again at the next check (the token list is read again then).
      this.tokenCheck.due = this.mono() + Math.min(TIMINGS.tokenCheckEvery, 3_600_000);
      this.logger.warn(`Xen Orchestra: renewing the token failed (${err?.message})`);
      return;
    }
    if (!this.current(generation) || this.config.token !== from) return;
    this.tokenTrouble = undefined;
    this.renewed = { from, to: fresh.token };
    this.tokenExpiry =
      fresh.expiration !== undefined && fresh.date !== undefined
        ? { left: fresh.expiration - fresh.date, at: this.mono() }
        : undefined;
    this.tokenCheck = {
      token: fresh.token,
      userId: this.tokenCheck?.userId,
      due: this.mono() + TIMINGS.tokenCheckEvery,
    };
    // The next requests use the new token (the old one stays valid until it expires).
    this.client = null;
    this.logger.info('Xen Orchestra: token renewed');
    await this.keepRenewed();
  }

  /** Gives the renewed token back to Gladys (the `token` field); failed: again every 10 min. */
  async keepRenewed() {
    const renewed = this.renewed;
    if (!renewed || this.closed) return;
    try {
      await this.bounded(this.gladys.setConfig({ token: renewed.to }), 5000);
    } catch (err) {
      this.logger.warn(
        `Xen Orchestra: the renewed token could not be kept by Gladys (${err?.message})`,
      );
      if (this.renewed === renewed) this.armKeep(TIMINGS.tokenKeepRetry);
      return;
    }
    if (this.renewed !== renewed) return;
    // Gladys keeps the new token: it is the configuration's from now on.
    this.raw = { ...this.raw, token: renewed.to };
    this.config = { ...this.config, token: renewed.to };
    this.renewed = null;
  }

  armKeep(ms) {
    this.timers.clearTimeout(this.keepTimer);
    this.keepTimer = this.later(ms, () => {
      this.keepTimer = undefined;
      this.background(this.keepRenewed());
    });
  }

  // --- After a read ------------------------------------------------------------------

  /** A VM list read (by the loop or the Test button): online, Discovery, states, status. */
  async takeRead(vms) {
    const wasOnline = this.online;
    this.inventory.vms = vms.items;
    this.overflow = vms.overflow;
    this.readAt = this.mono();
    this.online = true;
    this.failures = 0;
    this.lastError = undefined;
    this.pinError = undefined;
    if (!wasOnline) this.logger.info('Xen Orchestra: connected');
    await this.publishDiscovery();
    await this.publishStates();
    await this.showStatus();
    await this.publishTransports();
  }

  retryDelay(err) {
    if (err?.kind === 'rate' || err?.kind === 'server') {
      return clamp(
        err.retryAfter ?? TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMax,
      );
    }
    const backoff = Math.min(
      TIMINGS.retryMax,
      TIMINGS.retryMin * 2 ** Math.max(0, this.failures - 1),
    );
    return Math.max(backoff, this.readInterval());
  }

  /** A 429 or a 5xx: every path waits (bounded, kept in /data). */
  pause(err) {
    const delay = this.retryDelay(err);
    this.pauseEnd = Math.max(this.pauseEnd, this.mono() + delay);
    this.memory.pausedUntil = this.now() + delay;
    this.saveSoon().catch(() => {});
    return delay;
  }

  async fail(generation, err, address, token) {
    this.online = false;
    this.lastError = err;
    // A 401 in the envelope of XO on the VM list: the token is refused.
    if (err?.kind === 'unauth' && err.xo) {
      this.refuseToken(address, token);
      if (this.readBlocker()) {
        await this.showStatus();
        await this.publishTransports();
        return;
      }
    }
    if (err?.kind === 'pin' || err?.kind === 'nopin') this.pinError = err;
    this.failures += 1;
    const delay = pausing(err) ? this.pause(err) : this.retryDelay(err);
    if (err instanceof XoError) {
      this.logger.warn(
        `Xen Orchestra: ${err.message} (next read in ${Math.round(delay / 1000)} s)`,
      );
    } else {
      this.logger.error('Xen Orchestra: unexpected failure', err);
    }
    await this.showStatus();
    await this.publishTransports();
    if (this.current(generation)) this.scheduleRead(generation, delay);
  }

  /** A request that failed on a side path (command, follow-up): a 429 or 5xx pauses. */
  sideError(err) {
    if (pausing(err)) this.pause(err);
  }

  // --- Discovery, states, badges, status ------------------------------------------

  devices() {
    const language = this.config.language;
    const { hosts, vms, srs, jobs } = this.inventory;
    return [
      ...hosts.map((h) =>
        buildDevice(this.gladys, 'host', h, {
          language,
          model: [h.brand, h.version].filter(Boolean).join(' ') || undefined,
        }),
      ),
      ...vms.map((v) => buildDevice(this.gladys, 'vm', v, { language })),
      ...srs.map((s) => buildDevice(this.gladys, 'sr', s, { language })),
      ...jobs.map((j) => buildDevice(this.gladys, 'backup', j, { language })),
    ];
  }

  async publishDiscovery() {
    if (this.config.error || this.closed) return;
    const devices = this.devices();
    if (devices.length === 0 && !this.online) return;
    const key = JSON.stringify(devices);
    if (key === this.discoveredKey) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discoveredKey = key;
    } catch (err) {
      this.logger.warn(`Xen Orchestra: publishing the Discovery failed (${err?.message})`);
    }
  }

  /** The values of this read for the created features; never a stale value as new. */
  collectStates() {
    const states = [];
    const add = (id, value) => {
      if (value === undefined || value === null || !this.created.has(id)) return;
      if (typeof value === 'number') {
        if (Number.isFinite(value)) states.push({ device_feature_external_id: id, state: value });
      } else {
        states.push({
          device_feature_external_id: id,
          text: String(value).slice(0, LIMITS.textLength),
        });
      }
    };
    const language = this.config.language;
    const statsFresh = (s) => s && this.mono() - s.at <= 2 * this.readInterval() + 60_000;
    for (const v of this.inventory.vms) {
      const ids = idsOf(this.gladys, 'vm', v.uuid);
      add(
        ids.feature(FEATURES.VM_RUNNING),
        v.power === undefined ? undefined : Number(v.power === 'Running'),
      );
      add(
        ids.feature(FEATURES.VM_STATE),
        v.power === undefined ? undefined : powerWord(v.power, language),
      );
      add(
        ids.feature(FEATURES.VM_MEMORY_SIZE),
        v.memorySize === undefined ? undefined : Math.round(v.memorySize / MIB),
      );
      const s = v.power === 'Running' ? this.stats.get(v.uuid) : undefined;
      if (statsFresh(s)) {
        add(ids.feature(FEATURES.VM_CPU), s.cpu);
        add(ids.feature(FEATURES.VM_MEMORY), s.memory);
      }
    }
    if (this.fresh.hosts) {
      for (const h of this.inventory.hosts) {
        const ids = idsOf(this.gladys, 'host', h.uuid);
        const running = h.power === 'Running' ? 1 : h.power === 'Halted' ? 0 : undefined;
        add(ids.feature(FEATURES.HOST_RUNNING), running);
        add(ids.feature(FEATURES.HOST_MEMORY), h.memoryUsage);
      }
    }
    if (this.fresh.srs) {
      for (const s of this.inventory.srs) {
        const ids = idsOf(this.gladys, 'sr', s.uuid);
        add(ids.feature(FEATURES.SR_USAGE), s.usage);
        add(ids.feature(FEATURES.SR_FREE), s.free === undefined ? undefined : round1(s.free / GB));
        add(ids.feature(FEATURES.SR_SIZE), s.size === undefined ? undefined : round1(s.size / GB));
      }
    }
    const now = this.serverNow();
    if (this.fresh.backups) {
      for (const j of this.inventory.jobs) {
        const ids = idsOf(this.gladys, 'backup', j.id);
        const run = this.runs.get(j.id);
        const latest = run?.last?.status;
        if (latest) add(ids.feature(FEATURES.BACKUP_STATUS), statusWord(latest, language));
        const finished = run?.done?.status;
        const ok =
          finished === 'success'
            ? 1
            : finished === 'failure' || finished === 'interrupted'
              ? 0
              : undefined;
        add(ids.feature(FEATURES.BACKUP_OK), ok);
        if (run?.lastSuccessEnd !== undefined && now !== undefined && now >= run.lastSuccessEnd) {
          add(ids.feature(FEATURES.BACKUP_AGE), round1((now - run.lastSuccessEnd) / 3_600_000));
        }
      }
    }
    return states;
  }

  /**
   * Only what changed (or an unchanged value older than 30 min), within 240
   * states a minute; what does not fit goes at the next read, in turn (never
   * the same features left out each time).
   */
  async publishStates() {
    if (this.config.error || this.closed) return;
    const now = this.mono();
    const key = (s) => (s.text !== undefined ? `t:${s.text}` : `s:${s.state}`);
    const all = this.collectStates().filter((s) => {
      const last = this.published.get(s.device_feature_external_id);
      return !last || last.key !== key(s) || now - last.at >= TIMINGS.stateHeartbeat;
    });
    if (all.length === 0) return;
    this.stateWindow = this.stateWindow.filter((t) => now - t < 60_000);
    const room = LIMITS.statesPerMinute - this.stateWindow.length;
    if (room <= 0) return;
    const start = this.stateCursor % all.length;
    const states = [...all.slice(start), ...all.slice(0, start)].slice(0, room);
    this.stateCursor = start + states.length;
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: TIMINGS.stateHeartbeat });
      for (const s of states) {
        this.stateWindow.push(now);
        this.published.set(s.device_feature_external_id, { key: key(s), at: now });
      }
    } catch (err) {
      this.logger.warn(`Xen Orchestra: sending the states failed (${err?.message})`);
    }
  }

  /** The badge of each created device: unreachable while XO is not read. */
  async publishTransports() {
    if (this.config.error || this.closed) return;
    const out = [];
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseExternalId(this.gladys, device?.external_id);
      if (!parsed || parsed.feature !== null) continue;
      let badge = { transport: DEVICE_TRANSPORTS.LOCAL };
      if (!this.online) badge = { transport: DEVICE_TRANSPORTS.UNREACHABLE };
      else if (parsed.kind === 'vm' && this.unconfirmed.has(parsed.id)) {
        badge = {
          transport: DEVICE_TRANSPORTS.LOCAL,
          degraded: true,
          message: T.badge.unconfirmed,
        };
      } else if (!this.known(parsed.kind, parsed.id)) {
        badge = { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.missing };
      }
      const key = JSON.stringify(badge);
      if (this.transports.get(device.external_id) === key) continue;
      this.transports.set(device.external_id, key);
      out.push({ external_id: device.external_id, ...badge });
    }
    if (out.length === 0) return;
    await this.gladys
      .publishTransports(out)
      .catch((err) => this.logger.warn(`Xen Orchestra: badges failed (${err?.message})`));
  }

  /** The object of a created device is in the last read (a host or storage not read stays known). */
  known(kind, id) {
    const { hosts, vms, srs, jobs } = this.inventory;
    if (kind === 'vm') return vms.some((v) => v.uuid === id);
    if (kind === 'host') return hosts.length === 0 || hosts.some((h) => h.uuid === id);
    if (kind === 'sr') return srs.length === 0 || srs.some((s) => s.uuid === id);
    return jobs.length === 0 || jobs.some((j) => j.id === id);
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) =>
        this.logger.warn(`Xen Orchestra: setConnectionStatus failed (${err?.message})`),
      );
  }

  tokenLeft() {
    const e = this.tokenExpiry;
    if (!e || e.never) return undefined;
    return e.left - (this.mono() - e.at);
  }

  /** The status from what is known now (one text, bounded). */
  statusText() {
    const c = this.config;
    const parts = [];
    let connected = false;
    if (c.error) parts.push(T.configError(c.error));
    else if (this.pinError?.kind === 'pin') parts.push(T.pinChanged(this.pinError.fingerprint));
    else if (!this.pin()) parts.push(T.noPin);
    else if (this.blocked) parts.push(T.tokenRefused);
    else if (this.paused()) parts.push(T.paused(Math.ceil(this.pauseLeft() / 60_000)));
    else if (this.online) {
      connected = true;
      const { hosts, vms, srs, jobs } = this.inventory;
      parts.push(
        T.connected({
          hosts: hosts.length,
          vms: vms.length,
          running: vms.filter((v) => v.power === 'Running').length,
          srs: srs.length,
          jobs: jobs.length,
          interval: c.pollInterval,
        }),
      );
      if (this.overflow) parts.push(T.overflow);
    } else if (this.lastError) parts.push(T.failure(this.lastError));
    else parts.push(T.connecting);
    if (!c.error && this.online) {
      const left = this.tokenLeft();
      if (this.renewed) parts.push(T.tokenNotKept);
      else if (this.tokenTrouble && left !== undefined) {
        parts.push(T.tokenRenewFailed(Math.max(0, Math.floor(left / DAY)), this.tokenTrouble));
      }
    }
    if (this.note && this.mono() - this.note.at < TIMINGS.noteKeep) parts.push(this.note.text);
    if (this.memoryState === 'unreadable') parts.push(T.dataUnreadable);
    return { connected, message: T.join(parts) };
  }

  async showStatus() {
    if (this.closed) return;
    const { connected, message } = this.statusText();
    await this.setStatus(connected, message);
  }

  /** A promise not awaited: its failure is logged. */
  background(promise) {
    promise?.catch?.((err) => this.logger.warn(`Xen Orchestra: ${err?.message}`));
  }

  // --- Devices created by the user -------------------------------------------------

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /**
   * A device created (or updated): the SDK forgot its values, so they are sent
   * again, from the last read only if it is recent (never an old value as new).
   */
  async deviceCreated(device) {
    this.refreshCreated();
    for (const f of device?.features ?? []) {
      this.created.add(f.external_id);
      this.published.delete(f.external_id);
    }
    if (device?.external_id) this.transports.delete(device.external_id);
    if (this.online && this.mono() - this.readAt <= this.readInterval()) await this.publishStates();
    await this.publishTransports();
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) this.transports.delete(device.external_id);
  }

  /** The Scan button: the Discovery again; never a read sooner than the interval after the last one. */
  async scan() {
    this.discoveredKey = undefined;
    await this.publishDiscovery();
    const generation = this.generation;
    if (this.reading || this.mono() - this.lastReadMono < this.readInterval()) return;
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    await this.tick(generation);
  }

  // --- Commands --------------------------------------------------------------------

  refusal(code, ...args) {
    const text = T.denied[code];
    return new Refusal(
      code,
      word(typeof text === 'function' ? text(...args) : text, this.config.language),
    );
  }

  /** The result of a command, kept in the status for 10 min (setValue's answer reaches no one). */
  noteResult(text) {
    this.note = { text, at: this.mono() };
    this.background(this.showStatus());
    this.background(this.publishTransports());
  }

  vmCommand(uuid) {
    let state = this.vmCommands.get(uuid);
    if (!state) {
      state = { busy: false, last: -Infinity, epoch: 0 };
      this.vmCommands.set(uuid, state);
    }
    return state;
  }

  guardLeft(uuid) {
    return Math.max(0, (this.guards.get(uuid) ?? -Infinity) - this.mono());
  }

  async setValue(_device, feature, value) {
    // The deadline counts from the arrival of the command, before any wait.
    const received = this.mono();
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    if (!parsed || parsed.feature === null) throw this.refusal('unknown');
    const button = parsed.kind === 'vm' ? BUTTONS[parsed.feature] : undefined;
    if (!button) throw this.refusal('readOnly');
    // Strictly the value of a button: never a 0, a true or an empty text.
    if (value !== PRESSED && value !== String(PRESSED)) throw this.refusal('badValue');
    return this.command(parsed.id, parsed.feature, button, received);
  }

  /** Every check of a command (again right before its first byte). */
  check(uuid, key, button, state, epoch) {
    const c = this.config;
    if (c.error) throw this.refusal('notConfigured');
    if (button.option && !c[button.option]) throw this.refusal(`${key}Off`);
    if (!this.pin()) throw this.refusal('noPin');
    if (this.blocked) throw this.refusal('tokenRefused');
    if (this.paused()) throw this.refusal('paused', Math.ceil(this.pauseLeft() / 1000));
    if (state.epoch !== epoch) throw this.refusal('stopArrived');
    if (key === FEATURES.START && this.guardLeft(uuid) > 0) {
      throw this.refusal('stopGuard', Math.ceil(this.guardLeft(uuid) / 1000));
    }
  }

  /** What the read VM allows: 'send', or a note (nothing to do), or a refusal thrown. */
  decide(key, vm) {
    if (vm.power === undefined) throw this.refusal('stateUnknown');
    if (vm.busy === true) throw this.refusal('operationRunning');
    const p = vm.power;
    if (key === FEATURES.START) {
      if (p === 'Running') return T.result.alreadyRunning;
      if (p !== 'Halted') throw this.refusal('startState', p);
      return 'send';
    }
    if (key === FEATURES.SHUTDOWN) {
      if (p === 'Halted') return T.result.alreadyHalted;
      if (p !== 'Running') throw this.refusal('notRunning', p);
      return 'send';
    }
    if (key === FEATURES.FORCE_OFF) {
      if (p === 'Halted') return T.result.alreadyHalted;
      return 'send';
    }
    if (p !== 'Running') throw this.refusal('notRunning', p);
    return 'send';
  }

  /** Sets the stop guard of a VM (Start refused for 60 s) and waits for /data to keep it. */
  async setGuard(uuid) {
    if (this.memoryState !== 'loaded') throw this.refusal('dataNotKept');
    const before = this.memory.stopGuards[uuid];
    const beforeMono = this.guards.get(uuid);
    this.memory.stopGuards[uuid] = {
      address: this.config.address,
      until: this.now() + TIMINGS.stopGuard,
    };
    const entries = Object.entries(this.memory.stopGuards);
    if (entries.length > LIMITS.guards) {
      entries.sort((a, b) => a[1].until - b[1].until);
      for (const [old] of entries.slice(0, entries.length - LIMITS.guards))
        delete this.memory.stopGuards[old];
    }
    this.guards.set(uuid, this.mono() + TIMINGS.stopGuard);
    const undo = () => {
      if (before) this.memory.stopGuards[uuid] = before;
      else delete this.memory.stopGuards[uuid];
      if (beforeMono === undefined) this.guards.delete(uuid);
      else this.guards.set(uuid, beforeMono);
    };
    try {
      await this.saveNow(TIMINGS.guardSaveWait);
    } catch {
      undo();
      this.saveSoon().catch(() => {});
      throw this.refusal('dataNotKept');
    }
    return undo;
  }

  /**
   * One VM command: decided on a read of the VM made after the click; one at
   * a time per VM, one per 15 s per VM; sent within 3.5 s of the click or not
   * at all; "done" only once a later read shows it.
   */
  async command(uuid, key, button, received) {
    const deadline = received + TIMINGS.commandBudget;
    // The session clicked: another address or token saved meanwhile cancels the command.
    const generation = this.generation;
    const state = this.vmCommand(uuid);
    // A stop is newer than anything waiting for this VM: a Start not sent yet is cancelled.
    if (button.stop) state.epoch += 1;
    const epoch = state.epoch;
    this.check(uuid, key, button, state, epoch);
    if (state.busy) throw this.refusal(button.stop ? 'busyCancelled' : 'busy');
    const since = this.mono() - state.last;
    if (since < TIMINGS.commandSpacing) {
      throw this.refusal('spacing', Math.ceil((TIMINGS.commandSpacing - since) / 1000));
    }
    state.busy = true;
    let undoGuard;
    let left = false;
    try {
      const client = this.sessionClient();
      let vm;
      try {
        ({ vm } = await client.vm(uuid, {
          timeout: Math.max(200, deadline - TIMINGS.sendReserve - this.mono()),
        }));
      } catch (err) {
        this.sideError(err);
        if (err?.kind === 'pin') this.pinError = err;
        if (err?.kind === 'notfound') throw this.refusal('vmGone');
        throw this.refusal('readFailed', err);
      }
      if (!this.current(generation)) throw this.refusal('configChanged');
      this.updateVm(vm);
      const decision = this.decide(key, vm);
      if (decision !== 'send') {
        this.noteResult(decision);
        return undefined;
      }
      // Nothing changed during the read (option, newer stop, pause, guard).
      this.check(uuid, key, button, state, epoch);
      if (button.stop) undoGuard = await this.setGuard(uuid);
      if (this.mono() > deadline - 300) throw this.refusal('tooLate');
      const beforeSend = () => {
        if (!this.current(generation)) throw this.refusal('configChanged');
        this.check(uuid, key, button, state, epoch);
        if (this.mono() > deadline - 100) throw this.refusal('tooLate');
        state.last = this.mono();
        left = true;
      };
      try {
        await client.action(uuid, button.action, {
          timeout: Math.max(100, deadline - this.mono()),
          beforeSend,
        });
      } catch (err) {
        if (err instanceof Refusal) throw err;
        this.sideError(err);
        // No answer, or a success status not understood: maybe done.
        const maybe = err?.sent && (!err.answered || (err.status >= 200 && err.status < 300));
        if (maybe) {
          this.noteResult(T.result.unconfirmed(key));
          // Read again on the same session only (never another XO's VM).
          if (this.current(generation)) {
            this.unconfirmed.add(uuid);
            this.followUp(uuid, button.action, vm);
          }
          throw this.refusal('unconfirmed');
        }
        if (err?.answered) {
          // XO answered with an error: it did nothing.
          undoGuard?.();
          undoGuard = undefined;
          this.saveSoon().catch(() => {});
          this.noteResult(T.result.refused(key, err));
          throw this.refusal('refusedByXo', err);
        }
        this.noteResult(T.result.nothingSent(key, err));
        throw this.refusal('nothingSent', err);
      }
      this.unconfirmed.add(uuid);
      this.noteResult(T.result.sent(key));
      this.followUp(uuid, button.action, vm);
      return undefined;
    } catch (err) {
      // Never left: the guard of this command is withdrawn ("nothing sent").
      if (!left && undoGuard) {
        undoGuard();
        this.saveSoon().catch(() => {});
      }
      throw err;
    } finally {
      state.busy = false;
    }
  }

  /** A VM read again (command, follow-up): its values replace the old ones and are sent. */
  updateVm(vm) {
    const i = this.inventory.vms.findIndex((v) => v.uuid === vm.uuid);
    if (i < 0) return;
    this.inventory.vms[i] = { ...this.inventory.vms[i], ...vm, name: this.inventory.vms[i].name };
  }

  /**
   * Reads after a command (they do not count as the reads of the interval):
   * the VM published; done once the power state asked for is read (or, for a
   * restart, a new start time); a read equal to the state before is "not
   * applied yet".
   */
  followUp(uuid, action, before) {
    const delays = TIMINGS.confirm[action];
    const generation = this.generation;
    const last = Math.max(...delays);
    const timers = [];
    for (const delay of delays) {
      const timer = this.later(delay, async () => {
        this.followUps.delete(timer);
        const final = delay === last;
        if (!this.current(generation) || this.readBlocker() || this.paused()) {
          if (final) this.settleFollowUp(uuid, action, undefined);
          return;
        }
        try {
          const { vm } = await this.sessionClient().vm(uuid, { timeout: TIMINGS.readTimeout });
          if (!this.current(generation)) return;
          this.updateVm(vm);
          await this.publishStates();
          if (this.applied(action, before, vm)) {
            for (const t of timers) {
              this.timers.clearTimeout(t);
              this.followUps.delete(t);
            }
            this.unconfirmed.delete(uuid);
            this.noteResult(T.result.confirmed(action));
            return;
          }
          if (final) this.settleFollowUp(uuid, action, vm);
        } catch (err) {
          this.sideError(err);
          if (final) this.settleFollowUp(uuid, action, undefined);
        }
      });
      timers.push(timer);
      this.followUps.add(timer);
    }
  }

  applied(action, before, vm) {
    const wanted = WANTED[action];
    if (wanted) return vm.power === wanted;
    return (
      vm.power === 'Running' &&
      typeof vm.startTime === 'number' &&
      typeof before.startTime === 'number' &&
      vm.startTime > before.startTime
    );
  }

  settleFollowUp(uuid, action, vm) {
    this.unconfirmed.delete(uuid);
    this.noteResult(T.result.notApplied(action, vm?.power));
  }

  // --- Configuration screen buttons ---------------------------------------------------

  async testConnection() {
    await this.loadMemory();
    const now = this.mono();
    if (this.lastTest && now - this.lastTest.at < TIMINGS.testSpacing) return this.lastTest.result;
    const result = await this.runTest();
    this.lastTest = { at: this.mono(), result };
    return result;
  }

  async runTest() {
    const c = this.config;
    if (c.error) return T.configError(c.error);
    const generation = this.generation;
    const pin = this.pin();
    try {
      if (!pin) {
        const fp = await this.readFingerprint({ host: c.host, port: c.port });
        return T.test.noPin(fp);
      }
      if (this.paused()) {
        const { message } = this.statusText();
        return T.test.paused(message, Math.ceil(this.pauseLeft() / 1000));
      }
      const wait = this.lastReadMono + this.readInterval() - this.mono();
      if (wait > 0 && !this.blocked) {
        const { message } = this.statusText();
        return T.test.waiting(message, Math.ceil(wait / 1000));
      }
      this.noteAttempt();
      const token = this.token(c);
      const client = createXo({ host: c.host, port: c.port, pin, token, request: this.request });
      let vms;
      try {
        vms = await client.vms();
      } catch (err) {
        if (err?.kind === 'unauth' && err.xo && this.current(generation)) {
          this.refuseToken(c.address, token);
          return T.tokenRefused;
        }
        throw err;
      }
      const ok = T.test.ok(vms.items.length);
      if (!this.current(generation)) return ok;
      this.noteServerDate(vms.date);
      this.fresh = { hosts: false, srs: false, backups: false };
      if (this.blocked) {
        this.clearRefusal();
        this.logger.info('Xen Orchestra: token accepted again (Test button)');
        // A new session, which takes this read (the next one comes at the interval).
        this.background(
          this.start(this.raw).then(() => (this.config.error ? undefined : this.takeRead(vms))),
        );
      } else {
        this.background(this.takeRead(vms));
      }
      return ok;
    } catch (err) {
      this.sideError(err);
      if (err?.kind === 'pin' && this.current(generation)) this.pinError = err;
      if (!(err instanceof XoError)) this.logger.error('Xen Orchestra: test failed', err);
      return T.failure(err);
    }
  }

  /**
   * "Trust the certificate", in two clicks: the first shows the fingerprint
   * seen (nothing else is sent), the second (within 2 min, the same one seen
   * again) pins it. The first pin and a changed certificate alike.
   */
  async trustCertificate() {
    await this.loadMemory();
    const c = this.config;
    const target = parseAddress(this.raw.host);
    if (target.error) return T.configError(target.error);
    let fp;
    try {
      fp = await this.readFingerprint({ host: target.host, port: target.port });
    } catch (err) {
      return T.failure(err);
    }
    const current = this.pin(target.key);
    if (fp === current) return T.trust.same(fp);
    if (c.fingerprint && target.key === c.address) return T.trust.typed(fp);
    const pending = this.pendingTrust;
    if (
      !pending ||
      pending.address !== target.key ||
      pending.fp !== fp ||
      this.mono() - pending.at > TIMINGS.trustWindow
    ) {
      this.pendingTrust = { address: target.key, fp, at: this.mono() };
      return T.trust.confirm(fp, current === undefined, target.key);
    }
    this.pendingTrust = undefined;
    if (this.memoryState !== 'loaded') return T.pinNotKept(fp);
    const before = this.memory.pins[target.key];
    this.memory.pins[target.key] = fp;
    try {
      await this.saveNow();
    } catch {
      if (before === undefined) delete this.memory.pins[target.key];
      else this.memory.pins[target.key] = before;
      return T.pinNotKept(fp);
    }
    this.logger.info('Xen Orchestra: certificate trusted (two clicks)');
    this.lastReadMono = -Infinity;
    this.background(this.start(this.raw));
    return T.trust.done(fp);
  }
}
