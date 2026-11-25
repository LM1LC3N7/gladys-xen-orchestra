// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. The version is
// never pinned (the Release workflow bumps it): only its shape and agreement.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, BUTTONS, FEATURES, POLL_INTERVAL } from '../src/constants.js';
import { KINDS, buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics; one version everywhere (semver, never pinned)', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-xen-orchestra');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-xen-orchestra:${manifest.version}`);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(manifest.transports, ['local']);
  assert.equal(manifest.countries, undefined, 'the whole world');
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+Vates|sans\s+lien\s+avec\s+Vates/i);
    assert.match(
      docs,
      /never\s+tested\s+with\s+a\s+real\s+device|jamais\s+testé\s+avec\s+un\s+vrai\s+appareil/i,
    );
  }
  assert.match(manifest.config_schema[0].description.fr, /Jamais testé avec un vrai appareil/);
  assert.match(manifest.config_schema[0].description.en, /Never tested with a real device/);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
});

test('the token: a secret field without default, described as the rules ask', () => {
  const secrets = manifest.config_schema.filter((f) => f.type === 'secret');
  assert.deepEqual(
    secrets.map((f) => f.key),
    ['token'],
  );
  for (const field of secrets) {
    assert.ok(!('default' in field), 'never a default on a secret');
    assert.match(field.description.fr, /Gardé par Gladys dans sa base, jamais réaffiché/);
    assert.match(field.description.en, /Kept by Gladys in its database, never shown again/);
    assert.doesNotMatch(JSON.stringify(field), /chiffr|encrypt|hach|hash/i);
  }
  // No password anywhere: the token is renewed with itself.
  assert.ok(!manifest.config_schema.some((f) => /password|username/i.test(f.key)));
});

test('the configuration matches the code; the sensitive buttons are off by default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default ?? '', value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  for (const key of ['allow_shutdown', 'allow_force_off', 'allow_reboot']) {
    assert.equal(fields[key].type, 'boolean');
    assert.equal(fields[key].default, false, `${key} off by default`);
  }
  // Start is allowed (the brief); every other VM button needs its option.
  assert.equal(BUTTONS[FEATURES.START].option, null);
  for (const [key, button] of Object.entries(BUTTONS)) {
    if (key !== FEATURES.START) assert.ok(button.option, key);
  }
  assert.equal(fields.host.required, true);
  assert.equal(fields.token.required, true);
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max, fields.poll_interval.default],
    [POLL_INTERVAL.min, POLL_INTERVAL.max, POLL_INTERVAL.default],
  );
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
  assert.ok(!manifest.config_schema.some((f) => f.key.startsWith('gladys_')), 'no gladys_ key');
});

test('the actions are the ones the code handles', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
});

test('categories and nothing beyond the local network', () => {
  const text = JSON.stringify(manifest);
  assert.doesNotMatch(text, /user[-_ ]?agent/i);
  assert.deepEqual(manifest.categories, ['servers']);
  assert.equal(manifest.keywords, undefined);
  for (const key of [
    'network_discovery',
    'network_wake',
    'containers',
    'scene_actions',
    'widgets',
  ]) {
    assert.equal(manifest[key], undefined, key);
  }
});

// --- Option rules of the core -------------------------------------------------------

const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;
const OPTION_KEYS = ['id', 'value', 'label', 'sort_order'];
function checkOptions(options, where, allowStringValues) {
  assert.ok(Array.isArray(options) && options.length > 0, `${where}: options`);
  for (const [i, option] of options.entries()) {
    const at = `${where}[${i}]`;
    assert.equal(typeof option.label, 'string', `${at}.label must be a string`);
    assert.ok(option.label.trim().length > 0, `${at}.label is blank`);
    assert.equal(option.label, option.label.trim(), `${at}.label has surrounding whitespace`);
    assert.ok(
      Number.isInteger(option.value) ||
        (allowStringValues &&
          typeof option.value === 'string' &&
          option.value.length > 0 &&
          option.value === option.value.trim()),
      `${at}.value`,
    );
    assert.deepEqual(
      Object.keys(option).filter((k) => !OPTION_KEYS.includes(k)),
      [],
      `${at}: unknown key`,
    );
  }
  const values = options.map((o) => `${o.value}`);
  assert.equal(new Set(values).size, values.length, `${where}: duplicate values`);
  if (normalizeSupportedOptions) {
    assert.doesNotThrow(() => normalizeSupportedOptions(options, { allowStringValues }), where);
  }
}

test('the option rules reject what the core rejects (the guard itself)', () => {
  assert.throws(() => checkOptions([{ value: 0, label: { en: 'x' } }], 'bad', false), /string/);
  assert.throws(() => checkOptions([{ value: 0, label: ' ' }], 'bad', false), /blank/);
  assert.throws(() => checkOptions([{ value: 0, label: 'a ' }], 'bad', false), /whitespace/);
});

const OBJECTS = {
  host: { uuid: '00000101-0000-4000-8000-000000000000', name: 'xcp' },
  vm: { uuid: '00000001-0000-4000-8000-000000000000', name: 'web' },
  sr: { uuid: '00000201-0000-4000-8000-000000000000', name: 'local' },
  backup: { id: '00000301-0000-4000-8000-000000000000', name: 'nightly' },
};

test('the devices: no switch, buttons push, names trimmed; supported_options (none) follow the core', () => {
  const gladys = createFakeGladys();
  for (const language of ['en', 'fr']) {
    for (const kind of Object.keys(KINDS)) {
      const device = buildDevice(gladys, kind, OBJECTS[kind], { language });
      assert.equal(device.features.length, KINDS[kind].features.length);
      for (const feature of device.features) {
        assert.notEqual(feature.category, 'switch');
        assert.notEqual(feature.type, 'binary-switch');
        if (feature.supported_options !== undefined) {
          checkOptions(feature.supported_options, feature.external_id, feature.type === 'select');
        }
        assert.ok(feature.name.trim().length > 0 && feature.name === feature.name.trim());
        if (!feature.read_only)
          assert.deepEqual([feature.category, feature.type], ['button', 'push']);
        if (feature.category === 'button') assert.equal(kind, 'vm', 'buttons on VMs only');
      }
    }
  }
  for (const field of manifest.config_schema.filter((f) => f.type === 'select')) {
    for (const lang of ['en', 'fr']) {
      checkOptions(
        field.options.map((o) => ({ value: o.value, label: o.label[lang] })),
        `${field.key}.${lang}`,
        true,
      );
    }
  }
});

test('the Discovery is accepted by the fake Gladys (categories, types, units)', async () => {
  const gladys = createFakeGladys();
  await gladys.connect();
  const devices = Object.keys(KINDS).map((kind) => buildDevice(gladys, kind, OBJECTS[kind]));
  await gladys.publishDiscoveredDevices(devices);
  assert.equal(gladys.fake.discoveredDevices.length, 4);
  await gladys.disconnect();
});
