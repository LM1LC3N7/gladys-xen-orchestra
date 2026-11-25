// -----------------------------------------------------------------------------
// Constants of the Xen Orchestra integration: API paths, timings, limits, keys.
// The API is the REST API documented by Vates (https://docs.xen-orchestra.com/restapi,
// `/rest/v0`); Xen Orchestra itself (AGPL-3.0) runs at the user's and nothing of
// it is copied here.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 443;

/** The device types in the external ids: `ext:<selector>:<type>:<uuid>` (forever). */
export const DEVICE_TYPES = {
  HOST: 'xo-host',
  VM: 'xo-vm',
  SR: 'xo-sr',
  BACKUP: 'xo-backup',
};

/** The most objects read (one more is asked: more means "too many", the extra left out). */
export const MAX_OBJECTS = { hosts: 32, vms: 200, srs: 64, jobs: 64, logs: 2000 };

const VM_FIELDS = 'id,name_label,power_state,CPUs,memory,startTime,current_operations';

export const PATHS = {
  vms: `/rest/v0/vms?fields=${VM_FIELDS}&limit=${MAX_OBJECTS.vms + 1}`,
  vm: (uuid) => `/rest/v0/vms/${uuid}`,
  vmStats: (uuid) => `/rest/v0/vms/${uuid}/stats?granularity=seconds`,
  /** POST, without `sync`: answered 202 with a task as soon as XO took it. */
  vmAction: (uuid, action) => `/rest/v0/vms/${uuid}/actions/${action}`,
  hosts: `/rest/v0/hosts?fields=id,name_label,power_state,memory,version,productBrand&limit=${MAX_OBJECTS.hosts + 1}`,
  srs: `/rest/v0/srs?fields=id,name_label,SR_type,content_type,size,physical_usage&limit=${MAX_OBJECTS.srs + 1}`,
  backupJobs: `/rest/v0/backup-jobs?fields=id,name,type,mode&limit=${MAX_OBJECTS.jobs + 1}`,
  /** Runs started after `since` (ms, from the Date of XO): the live filter of the docs. */
  backupLogs: (since) =>
    `/rest/v0/backup-logs?fields=id,jobId,status,start,end&filter=${encodeURIComponent(`start:>${since}`)}&limit=${MAX_OBJECTS.logs + 1}`,
  /** 307 to /rest/v0/users/<id>: the id of the token's user. */
  me: '/rest/v0/users/me',
  tokens: (userId) => `/rest/v0/users/${userId}/authentication_tokens`,
  /** POST with the current token: a new token for the same user (docs, "Creating a token"). */
  newToken: '/rest/v0/users/authentication_tokens',
};

/** Refresh interval (seconds). */
export const POLL_INTERVAL = { min: 30, max: 3600, default: 60 };

export const LANGUAGES = ['fr', 'en'];

/** The only value a `button`/`push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

export const FEATURES = {
  // Host
  HOST_RUNNING: 'running',
  HOST_MEMORY: 'memory_usage',
  // VM
  VM_RUNNING: 'running',
  VM_STATE: 'power_state',
  VM_CPU: 'cpu_usage',
  VM_MEMORY: 'memory_usage',
  VM_MEMORY_SIZE: 'memory_size',
  START: 'start',
  SHUTDOWN: 'shutdown',
  FORCE_OFF: 'force_off',
  REBOOT: 'reboot',
  // Storage repository
  SR_USAGE: 'usage',
  SR_FREE: 'free',
  SR_SIZE: 'size',
  // Backup job
  BACKUP_OK: 'last_ok',
  BACKUP_STATUS: 'last_status',
  BACKUP_AGE: 'last_success_age',
};

/**
 * The VM buttons: the XO action each one sends, the option that allows it
 * (null: always allowed), whether it stops the VM, and the power state it
 * needs. Start is allowed; the three others are off by default.
 */
export const BUTTONS = {
  [FEATURES.START]: { action: 'start', option: null, stop: false },
  [FEATURES.SHUTDOWN]: { action: 'clean_shutdown', option: 'allowShutdown', stop: true },
  [FEATURES.FORCE_OFF]: { action: 'hard_shutdown', option: 'allowForceOff', stop: true },
  [FEATURES.REBOOT]: { action: 'clean_reboot', option: 'allowReboot', stop: false },
};

export const ACTIONS = {
  TEST: 'test_connection',
  TRUST: 'trust_certificate',
};

export const TIMINGS = {
  /** TLS handshake. */
  connectTimeout: 3000,
  /** A whole read. */
  readTimeout: 10_000,
  /** No byte for this long during an answer: the read is cut (a frozen read). */
  idleTimeout: 2000,
  /** A command is answered to Gladys within this (Gladys gives up at 5 s). */
  commandBudget: 3500,
  /** Time kept for /data and the send itself after the read of a command. */
  sendReserve: 1200,
  /** /data write of a stop guard, waited for before the first byte. */
  guardSaveWait: 600,
  /** After a shutdown or a forced shutdown of a VM: Start of that VM refused this long. */
  stopGuard: 60_000,
  /** At most one command per VM per this delay. */
  commandSpacing: 15_000,
  /** Reads that confirm a command, after its answer. */
  confirm: {
    start: [5000, 20_000, 60_000],
    clean_shutdown: [5000, 20_000, 60_000, 180_000],
    hard_shutdown: [5000, 20_000],
    clean_reboot: [10_000, 30_000, 90_000],
  },
  /** The token of the configuration: its expiry read at most this often (secondary read). */
  tokenCheckEvery: 12 * 3_600_000,
  /** A token renewed but not kept by Gladys (setConfig failed): tried again this often. */
  tokenKeepRetry: 10 * 60_000,
  /** A secondary read refused (401/403): spaced, doubling up to this. */
  secondaryMax: 3_600_000,
  /** 429 / 5xx: pause bounds. */
  rateLimitMin: 60_000,
  rateLimitMax: 6 * 3_600_000,
  /** Other failures: back-off bounds. */
  retryMin: 30_000,
  retryMax: 30 * 60_000,
  /** /data: one read at a time, each bounded; unreadable: read again every 10 s. */
  dataWait: 2000,
  dataRetry: 10_000,
  /** The time of the last read written to /data at most this often. */
  attemptWriteEvery: 60_000,
  /** getConfig() failing: tried again after these delays, then every minute. */
  configRetry: [5000, 15_000, 30_000, 60_000],
  /** Test button: its last result given again within this delay. */
  testSpacing: 10_000,
  /** The second click of "Trust the certificate" must come within this. */
  trustWindow: 120_000,
  /** An unchanged state sent again this often (it stays recently dated in Gladys). */
  stateHeartbeat: 30 * 60_000,
  /** A VM sample (CPU, memory) older than this, against the Date of XO, is not published. */
  statsMaxAge: 5 * 60_000,
  /** Backup runs looked at: those started within this window (against the Date of XO). */
  backupWindow: 8 * 24 * 3_600_000,
  /** A command result stays in the status this long. */
  noteKeep: 10 * 60_000,
};

export const LIMITS = {
  /** A collection answer (JSON): a larger one is cut before it is read whole. */
  collectionBytes: 1024 * 1024,
  /** A single object or a statistics answer. */
  objectBytes: 256 * 1024,
  /** VM statistics read per cycle (the next running VMs in turn). */
  statsPerCycle: 10,
  /** States sent to Gladys per minute (the host API takes 300). */
  statesPerMinute: 240,
  /** Names shown (VM, host, storage, job). */
  nameLength: 64,
  /** A text state. */
  textLength: 40,
  /** Stop guards kept in /data. */
  guards: 200,
};
