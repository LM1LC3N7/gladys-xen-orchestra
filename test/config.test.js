// -----------------------------------------------------------------------------
// The configuration: address, fingerprint, token, options (only true turns
// one on), bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress, parseFingerprint, sameSession } from '../src/config.js';

const TOKEN = 'KQxQdm2vMiv7jBIK0hgkmgxKzemd8wSJ7ugFGKFkTbs';

test('addresses: HTTPS only, no path, no credentials, no broadcast nor .local', () => {
  assert.deepEqual(parseAddress('192.168.1.30'), {
    host: '192.168.1.30',
    port: 443,
    key: '192.168.1.30:443',
  });
  assert.equal(parseAddress('https://xo.lan:8443/').key, 'xo.lan:8443');
  assert.equal(parseAddress('[fe80::1]').key, '[fe80::1]:443');
  for (const [raw, error] of [
    ['', 'empty'],
    ['http://xo', 'scheme'],
    ['https://u:p@xo', 'credentials'],
    ['xo/rest/v0', 'path'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'broadcast'],
    ['0.0.0.0', 'broadcast'],
    ['xo.local', 'local-name'],
    ['xo\r\nx', 'invalid'],
    ['999.1.1.1', 'invalid'],
  ]) {
    assert.equal(parseAddress(raw).error, error, raw);
  }
});

test('fingerprints: SHA-256 with or without colons', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(parseFingerprint(hex).fingerprint, 'AB:'.repeat(31) + 'AB');
  assert.equal(parseFingerprint(`sha256=${hex}`).fingerprint, 'AB:'.repeat(31) + 'AB');
  assert.equal(parseFingerprint('abcd').error, 'fingerprint');
  assert.deepEqual(parseFingerprint(''), {});
});

test('the token: required, cookie-safe characters only', () => {
  assert.equal(normalizeConfig({ host: 'xo' }).error, 'no-token');
  assert.equal(normalizeConfig({ host: 'xo', token: 'a b;c=d' }).error, 'bad-token');
  assert.equal(normalizeConfig({ host: 'xo', token: 'short' }).error, 'bad-token');
  const c = normalizeConfig({ host: 'xo', token: ` ${TOKEN} ` });
  assert.equal(c.error, undefined);
  assert.equal(c.token, TOKEN);
});

test('options: only true turns one on; the interval is bounded', () => {
  const c = normalizeConfig({
    host: 'xo',
    token: TOKEN,
    allow_shutdown: 'yes',
    allow_force_off: 1,
    allow_reboot: 'true',
  });
  assert.deepEqual([c.allowShutdown, c.allowForceOff, c.allowReboot], [false, false, true]);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: 1e9 }).pollInterval, 3600);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});

test('sameSession: the options never make another session; the token does', () => {
  const a = normalizeConfig({ host: 'xo', token: TOKEN });
  const b = normalizeConfig({ host: 'xo', token: TOKEN, allow_shutdown: true, poll_interval: 120 });
  assert.equal(sameSession(a, b), true);
  assert.equal(sameSession(a, normalizeConfig({ host: 'xo', token: `${TOKEN}x` })), false);
});
