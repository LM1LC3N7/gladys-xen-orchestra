// -----------------------------------------------------------------------------
// The Gladys devices of a Xen Orchestra (pure):
//
//   `ext:<selector>:xo-host:<uuid>`    a host: running, memory used (%)
//   `ext:<selector>:xo-vm:<uuid>`      a VM: running, power state, CPU (%),
//                                      memory used (%), memory size (MB);
//                                      Start, Shut down, Force shutdown,
//                                      Restart (buttons)
//   `ext:<selector>:xo-sr:<uuid>`      a storage repository: used (%), free
//                                      and total space (GB)
//   `ext:<selector>:xo-backup:<uuid>`  a backup job: last run ok, its status,
//                                      hours since the last successful run
//
// The ids are the UUIDs given by XO (fixed rule, documented). Every reading
// is read only. The VM actions are `button`/`push` features, never a switch
// nor a binary: a "turn everything off" of a voice assistant, MCP or a
// `switch` scene action must not reach them.
//
// A device published again never loses a feature: the features of the device
// created in Gladys (`gladys.devices`) are added back when the blueprint
// lacks them.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPES, FEATURES as F } from './constants.js';
import { featureName, kindName } from './i18n.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const reading = (extra) => ({ read_only: true, has_feedback: false, keep_history: true, ...extra });
const binary = () => reading({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
// No core category lists a percent for a processor, a memory or a disk load:
// `unknown`/`unknown` without a unit, the unit in the name (as gladys-esxi).
const percent = () => reading({ category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, min: 0, max: 100 });
const text = () =>
  reading({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const size = (unit, max) => reading({ category: C.DATA, type: T.DATA.SIZE, unit, min: 0, max });
const button = () => ({
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});

export const KINDS = {
  host: {
    type: DEVICE_TYPES.HOST,
    features: [
      [F.HOST_RUNNING, binary()],
      [F.HOST_MEMORY, percent()],
    ],
  },
  vm: {
    type: DEVICE_TYPES.VM,
    features: [
      [F.VM_RUNNING, binary()],
      [F.VM_STATE, text()],
      [F.VM_CPU, percent()],
      [F.VM_MEMORY, percent()],
      [F.VM_MEMORY_SIZE, size(U.MEGABYTE, 100_000_000)],
      [F.START, button()],
      [F.SHUTDOWN, button()],
      [F.FORCE_OFF, button()],
      [F.REBOOT, button()],
    ],
  },
  sr: {
    type: DEVICE_TYPES.SR,
    features: [
      [F.SR_USAGE, percent()],
      [F.SR_FREE, size(U.GIGABYTE, 1_000_000_000)],
      [F.SR_SIZE, size(U.GIGABYTE, 1_000_000_000)],
    ],
  },
  backup: {
    type: DEVICE_TYPES.BACKUP,
    features: [
      [F.BACKUP_OK, binary()],
      [F.BACKUP_STATUS, text()],
      [
        F.BACKUP_AGE,
        reading({
          category: C.DURATION,
          type: T.DURATION.DECIMAL,
          unit: U.HOURS,
          min: 0,
          max: 1_000_000,
        }),
      ],
    ],
  },
};

export const idsOf = (gladys, kind, id) => gladys.externalIds(KINDS[kind].type, id);

/** The features of the created device the blueprint lacks, appended (never fewer). */
export function withCreatedFeatures(device, devices) {
  const created = (devices ?? []).find((d) => d?.external_id === device.external_id);
  if (!created) return device;
  const known = new Set(device.features.map((f) => f.external_id));
  const extra = (created.features ?? []).filter(
    (f) => f && typeof f.external_id === 'string' && !known.has(f.external_id),
  );
  if (extra.length === 0) return device;
  return { ...device, features: [...device.features, ...extra] };
}

/**
 * The device of an object read from XO: `kind` host | vm | sr | backup,
 * `object` { uuid or id, name }, `model` a short text.
 */
export function buildDevice(gladys, kind, object, { language = 'fr', model } = {}) {
  const id = object.uuid ?? object.id;
  const ids = idsOf(gladys, kind, id);
  const label = object.name ?? id.slice(0, 8);
  const name = kind === 'vm' ? label : `${kindName(kind, language)} ${label}`;
  return withCreatedFeatures(
    {
      name: name.slice(0, 80),
      external_id: ids.device,
      model: (model ?? kindName(kind, language)).slice(0, 80),
      should_poll: false,
      features: KINDS[kind].features.map(([key, definition]) => ({
        name: featureName(kind, key, language),
        external_id: ids.feature(key),
        ...definition,
      })),
    },
    gladys.devices,
  );
}

/**
 * What a device or feature external id of this integration designates:
 * { kind, id, feature } (feature null for a device), or null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) return null;
  for (const [kind, { type, features }] of Object.entries(KINDS)) {
    const prefix = gladys.externalId(`${type}:`);
    if (!externalId.startsWith(prefix)) continue;
    const [id, feature, ...rest] = externalId.slice(prefix.length).split(':');
    if (rest.length > 0 || !UUID.test(id ?? '')) return null;
    if (feature === undefined) return { kind, id, feature: null };
    if (!features.some(([key]) => key === feature)) return null;
    return { kind, id, feature };
  }
  return null;
}
