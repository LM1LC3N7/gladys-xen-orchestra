// Mutation checks of the guards: each mutant breaks one guard in a copy of the
// repository and must make a test fail (never hang: the whole process group is
// killed at the deadline). One at a time. Usage, from the repository:
//   memcap node scripts/mutants.mjs "$(mktemp -d)" [name filter]
// The directory given is the agent's own; it is emptied of each copy after use.
// node_modules is copied (never linked) into each copy.

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const C = 'test/commands.test.js';
const A = 'test/app.test.js';
const K = 'test/token.test.js';
const X = 'test/xo.test.js';
const G = 'test/config.test.js';
const R = 'test/realclock.test.js';
const ALL = [C, A, K, X, G, R, 'test/manifest.test.js', 'test/encoding.test.js'];
const APP = 'src/app.js';
const XO = 'src/xo.js';

/** [name, file, from (found exactly once), to, test files]. */
export const MUTANTS = [
  [
    'option of a VM button',
    APP,
    'if (button.option && !c[button.option]) throw',
    'if (false) throw',
    [C],
  ],
  ['newer stop of the VM', APP, 'if (state.epoch !== epoch) throw', 'if (false) throw', [C]],
  ['a stop bumps the counter', APP, 'if (button.stop) state.epoch += 1;', '', [C]],
  [
    'stop guard',
    APP,
    'if (key === FEATURES.START && this.guardLeft(uuid) > 0) {',
    'if (false) {',
    [C],
  ],
  [
    'pause holds commands',
    APP,
    "if (this.paused()) throw this.refusal('paused'",
    "if (false) throw this.refusal('paused'",
    [C],
  ],
  [
    'refused token holds commands',
    APP,
    "if (this.blocked) throw this.refusal('tokenRefused');",
    '',
    [C],
  ],
  [
    'busy per VM',
    APP,
    'if (state.busy) throw this.refusal(',
    'if (false) throw this.refusal(',
    [C],
  ],
  ['spacing per VM', APP, 'if (since < TIMINGS.commandSpacing) {', 'if (false) {', [C]],
  [
    'check again after the read',
    APP,
    '      // Nothing changed during the read (option, newer stop, pause, guard).\n      this.check(uuid, key, button, state, epoch);',
    '',
    [C],
  ],
  [
    'check again at the first byte',
    APP,
    "throw this.refusal('configChanged');\n        this.check(uuid, key, button, state, epoch);",
    "throw this.refusal('configChanged');",
    [C],
  ],
  [
    'session at the first byte',
    APP,
    "        if (!this.current(generation)) throw this.refusal('configChanged');\n        this.check(",
    '        this.check(',
    [C],
  ],
  [
    'deadline at the first byte',
    APP,
    "if (this.mono() > deadline - 100) throw this.refusal('tooLate');",
    '',
    [C],
  ],
  [
    'guard written before sending',
    APP,
    'await this.saveNow(TIMINGS.guardSaveWait);',
    'this.saveSoon().catch(() => {});',
    [C],
  ],
  ['guard withdrawn when never left', APP, 'if (!left && undoGuard) {', 'if (false) {', [C]],
  [
    'XO busy operation',
    APP,
    "if (vm.busy === true) throw this.refusal('operationRunning');",
    '',
    [C],
  ],
  ['start of a running VM', APP, "if (p === 'Running') return T.result.alreadyRunning;", '', [C]],
  [
    'start of a paused VM',
    APP,
    "if (p !== 'Halted') throw this.refusal('startState', p);",
    '',
    [C],
  ],
  [
    'shutdown of a halted VM',
    APP,
    "      if (p === 'Halted') return T.result.alreadyHalted;\n      if (p !== 'Running') throw this.refusal('notRunning', p);",
    "      if (p !== 'Running') throw this.refusal('notRunning', p);",
    [C],
  ],
  [
    'restart of a halted VM',
    APP,
    "    if (p !== 'Running') throw this.refusal('notRunning', p);\n    return 'send';\n  }",
    "    return 'send';\n  }",
    [C],
  ],
  [
    'confirmation by the power state',
    APP,
    'if (wanted) return vm.power === wanted;',
    'if (wanted) return true;',
    [C],
  ],
  ['restart confirmed by a new start time', APP, 'vm.startTime > before.startTime', 'true', [C]],
  [
    'sent without answer never resent',
    APP,
    "          throw this.refusal('unconfirmed');",
    "          await client.action(uuid, button.action, { timeout: 1000 }).catch(() => {});\n          throw this.refusal('unconfirmed');",
    [C],
  ],
  [
    'a 500 of XAPI pauses nothing',
    APP,
    "(err?.kind === 'server' && !(err.status === 500 && err.xo))",
    "err?.kind === 'server'",
    [C],
  ],
  [
    'refusal only in the envelope of XO',
    APP,
    "if (err?.kind === 'unauth' && err.xo) {",
    "if (err?.kind === 'unauth') {",
    [A],
  ],
  [
    'refusal kept at restart',
    APP,
    'return tokenMark(r.salt, token) === r.mark;',
    'return false;',
    [A],
  ],
  ['never faster than the interval', APP, '    if (early > 0) {', '    if (false) {', [A]],
  ['statistics freshness', APP, 'at - s.at <= TIMINGS.statsMaxAge', 'true', [A]],
  ['secondary failure held', APP, 'if (this.held(name)) return undefined;', '', [A]],
  ['statistics in turn', APP, 'this.statsCursor = start + count;', '', [A]],
  [
    'backup ok from a finished run',
    APP,
    'const finished = run?.done?.status;',
    'const finished = latest;',
    [A],
  ],
  [
    'created later: only recent values',
    APP,
    'if (this.online && this.mono() - this.readAt <= this.readInterval()) await this.publishStates();',
    'await this.publishStates();',
    [A],
  ],
  ['renewal threshold', APP, 'if (left > Math.min(life / 2, 7 * DAY)) return;', '', [K]],
  ['no Date, no expiry', APP, '    if (info.date === undefined) return;', '', [K]],
  [
    'one token per renewal',
    APP,
    'if (this.renewed === renewed) this.armKeep(TIMINGS.tokenKeepRetry);',
    'if (this.renewed === renewed) this.tokenCheck.due = 0;',
    [K],
  ],
  [
    'renewed token used',
    APP,
    'if (this.renewed && this.renewed.from === c.token) return this.renewed.to;',
    '',
    [K],
  ],
  ['pin at the handshake', XO, 'if (seen !== pin) {', 'if (false) {', [X]],
  [
    'beforeSend before the first byte',
    XO,
    '    beforeSend?.();\n  } catch (err) {',
    '  } catch (err) {',
    [X],
  ],
  [
    'answer size while streaming',
    XO,
    '        if (size > maxBytes) {',
    '        if (false) {',
    [X],
  ],
  ['envelope of a collection', XO, '!item.href.startsWith(prefix)', 'false', [X, A]],
  ['frozen answer cut', XO, '    sent = true;\n    armIdle();', '    sent = true;', [X]],
];

/** Equivalent mutants, with the reason (no test can tell them apart). */
export const EQUIVALENT = [
  [
    'token never in an error',
    XO,
    'const json = parseAnswer(answer, { secrets: [token] });',
    'cleanReason also replaces any run of 20 or more token characters, and a token of XO has 43: the token is masked either way',
  ],
  [
    'session checked after the read',
    APP,
    "if (!this.current(generation)) throw this.refusal('configChanged');\n      this.updateVm(vm);",
    'a new session aborts the signal of the old client (its read fails) and the beforeSend checks the session again at the first byte (mutant "session at the first byte")',
  ],
  [
    'deadline before the send',
    APP,
    "if (this.mono() > deadline - 300) throw this.refusal('tooLate');",
    'the beforeSend checks the deadline again at the first byte (mutant "deadline at the first byte"); this one only stops before the TLS handshake',
  ],
  [
    'declared content-length',
    XO,
    'if (Number.isFinite(declared) && declared > maxBytes) {',
    'the streaming count cuts the same answer a few kilobytes later',
  ],
];

function run(dir, tests, ms) {
  return new Promise((done) => {
    const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-timeout=60000', ...tests], {
      cwd: dir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
      done({ code: 'TIMEOUT', out });
    }, ms);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

async function main() {
  const base = process.argv[2];
  const filter = process.argv[3];
  if (!base) throw new Error('give your own temporary directory (mktemp -d)');
  const modules = join(base, 'node_modules');
  cpSync(join(REPO, 'node_modules'), modules, { recursive: true });
  // The unmodified suite first: a red baseline makes every mutant look killed.
  {
    const dir = mkdtempSync(join(base, 'baseline-'));
    try {
      cpSync(REPO, dir, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
      });
      cpSync(modules, join(dir, 'node_modules'), { recursive: true });
      const { code } = await run(dir, ALL, 300_000);
      if (code !== 0) {
        console.log('baseline FAILED');
        rmSync(modules, { recursive: true, force: true });
        process.exitCode = 1;
        return;
      }
      console.log('baseline ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  let survived = 0;
  for (const [name, file, from, to, tests] of MUTANTS) {
    if (filter && !name.includes(filter)) continue;
    const dir = mkdtempSync(join(base, 'm-'));
    try {
      cpSync(REPO, dir, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
      });
      cpSync(modules, join(dir, 'node_modules'), { recursive: true });
      const path = join(dir, file);
      const text = readFileSync(path, 'utf8');
      const n = text.split(from).length - 1;
      if (n !== 1) {
        console.log(`??       ${name}: ${n} matches`);
        survived += 1;
        continue;
      }
      writeFileSync(path, text.replace(from, to));
      const { code } = await run(dir, tests, 150_000);
      const killed = code !== 0 && code !== 'TIMEOUT';
      if (!killed) survived += 1;
      console.log(`${killed ? 'killed  ' : code === 'TIMEOUT' ? 'HANGS   ' : 'SURVIVED'} ${name}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  rmSync(modules, { recursive: true, force: true });
  for (const [name, , , why] of EQUIVALENT) console.log(`equiv.   ${name}: ${why}`);
  process.exitCode = survived > 0 ? 1 : 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
