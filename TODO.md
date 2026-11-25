# TODO — Xen Orchestra v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-11-25): REST API client on a pinned TLS
      socket (token cookie, envelope, bounded answers), Discovery of hosts,
      VMs, storage repositories and backup jobs, VM statistics in turn, token
      expiry read and renewal, refusal mark, 429/5xx pause, VM buttons (Start
      allowed; Shut down, Force shutdown, Restart behind options) with stop
      guard in /data and confirmation by a later read, two-click certificate
      trust, docs en/fr. Tested against the SDK's fake Gladys and a simulated
      XO over HTTPS on 127.0.0.1; the reads, errors and token renewal were
      first checked against a real XO 5.214 (REST API 0.41.1) in the container
      `ronivay/xen-orchestra`, without hypervisor (no VM). **Never tested with
      a real XCP-ng pool.**

## Decisions

- **Version 0.1.0** set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-xen-orchestra:0.1.0`);
  the first release (patch) gives 0.1.1.
- **Reference**: the official REST API documentation
  (https://docs.xen-orchestra.com/restapi, `docs/docs/automation/restapi.md`
  of vatesfr/xen-orchestra) and the Swagger served by XO; XO is AGPL-3.0 and
  runs at the user's: only its documented API is called, nothing of XO is
  read as code, copied or ported. Notice in `THIRD_PARTY_NOTICES.md`.
- **Seen on the real XO 5.214** (container): 401 `{"error":"invalid
credentials"}` for a bad token; 404 `{"error":"no such VM …"}`; 400 for a
  bad filter; `GET /users/me` answers 307 to `/users/<id>` (read, never
  followed); `GET /users/<id>/authentication_tokens` lists the tokens with
  `expiration` and `created_at` (default life 30 days); `POST /users/authentication_tokens` with the token cookie creates a new one (201), but the Swagger marks
  this route without an id deprecated (review r1): the module posts to `/users/<id>/authentication_tokens`;
  `fields` is ignored on the token list; the filter `start:>N` is accepted.
- **Token, not password**: the brief asks for an XO token; Basic
  authentication is never used. Renewal (docs: "renew by calling the same endpoint with your existing token"): the expiry is read from the token list of the user (a secondary read; a 401/403 there is never a refusal), again after a quarter of the time left before the renewal point, between 5 min and 12 h (review r1: a 12-hour token was read too late); when less than min(half the life, 7 days) is left by XO's Date header, a new token is created with the current one by `POST /rest/v0/users/<id>/authentication_tokens` (the id read from the 307 of `/users/me`, never followed; review r1). The list refused twice: the status says the token cannot be renewed in time and written back to the
  `token` field with `setConfig` (allowed by the core for schema keys, no
  config-updated echo). Failed: kept in memory only (never /data) and
  `setConfig` tried again every 10 min, never a second token for the same
  renewal. The old token is not revoked (no documented route; it expires by itself; the user can revoke it in XO). Orphan tokens (a new one not kept before a restart, a renewal sent without answer) are said in the docs, with their description "Gladys Assistant (renewed)". A token saved by the user while the renewed one is being written is written back after it (review r1, race).
- **Refusal**: only a 401 in the envelope of XO on the VM list (the main
  read). A 401 without the envelope (a proxy) is "not taken"; a 403 is "not
  allowed" (RBAC). 16-bit salted mark in /data (review r1; the fiche's 4-8 bits target human passwords, a token of XO is 256 random bits, 16 of them never help to find it), lifted by the Test button, and at once by another token saved while running (the mark only serves a restart).
- **Start allowed, the stops behind options** (lot 25 brief: "démarrer une VM
  permis ; arrêt propre, arrêt forcé et redémarrage derrière une option
  désactivée par défaut, comme PiKVM"). No protective action here: the clean
  shutdown is a sensitive one (it can stop a service of the home). Restart =
  `clean_reboot`; `hard_reboot`, pause, suspend, snapshot, migrate are left
  out.
- **Stop guard**: after a shutdown or forced shutdown, Start of that VM is
  refused 60 s; the guard is written to /data and waited for (600 ms at most)
  before the first byte; not written: refused, nothing sent. A stop that never
  left, or that XO answered with an error, withdraws its guard.
- **A stop click bumps the VM's command counter first**: a Start of that VM
  not sent yet is cancelled even if the stop is then refused (option off,
  busy). Safest direction: the VM stays as it is.
- **Confirmation**: no task polling; done only once `GET /vms/<id>` shows the
  power state asked (`Running`, `Halted`) or, for a restart, a later
  `startTime`. Reads after 5/20/60 s (start), 5/20/60/180 s (shutdown), 5/20 s
  (forced), 10/30/90 s (restart).
- **Pauses**: a 429, or a 5xx that is not a 500 in the envelope of XO, pauses
  every path (1 min to 6 h). A 500 of XO is an XAPI error about one object
  (e.g. VM_BAD_POWER_STATE): it pauses nothing (one VM in error never holds the others). The renewal POST pauses the same way. A 5xx without the envelope of XO (a proxy) on a VM action that left is "sent, without confirmation": the stop guard stays (review r1).
- **Statistics**: `/vms/<id>/stats?granularity=seconds`, the newest non-null
  sample; CPU = mean of the vCPU values, read in percent (review r1; the Swagger only calls the raw XAPI data source `cpu#` a fraction, while the REST dashboard example shows the same VMs at about 1 % and the stats examples at 0.1: consistent with percent; to confirm on a real pool), a vCPU outside 0..105 is unknown; memory used =
  (memory − memoryFree) / memory, only with `memoryFree` (guest tools). 10 VMs
  per read in turn; a sample older than 5 min by XO's Date is dropped. A halted VM has no CPU nor memory value (unknown, not 0); nor has a host not running its memory used.
- **Backups**: `/backup-jobs` and `/backup-logs?filter=start:>…` over 8 days by
  XO's Date (no Date: no window, nothing read). Last status includes a running
  one ("Running"); "last run successful" only from a finished run (success 1,
  failure/interrupted 0, skipped unknown).
- **Identity**: device ids are the XO UUIDs (`xo-host:`, `xo-vm:`, `xo-sr:`,
  `xo-backup:`); the pinned certificate makes sure each request reaches the
  same XO. A command reads `GET /vms/<id>` and refuses another id than asked.
- **Feature categories**: running as `unknown`/`binary` read only; percents
  as `unknown`/`unknown` (no core category with a percent for CPU/memory/disk,
  as gladys-esxi); sizes `data`/`size` (MB, GB); hours `duration`/`decimal`;
  power state and run status `text`; buttons `button`/`push`.
- **Categories**: `servers`. No `keywords` (rule). World-wide (no `countries`).
- **CI**: `timeout-minutes` added to the jobs of `.github/workflows/ci.yml`
  (a hanging test never holds a runner).

## Next

- Test with a real XCP-ng pool behind XO (statistics shape, `current_operations`
  during a start, the 202 and task of each action, a non-admin token).
- Maybe: SSE events (`/rest/v0/events`) instead of polling; host statistics.
