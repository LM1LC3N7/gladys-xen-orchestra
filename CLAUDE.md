# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads a Xen Orchestra (hosts, VMs, storage
repositories, backup runs) and starts / stops its VMs through the REST API
(https://docs.xen-orchestra.com/restapi). Xen Orchestra is AGPL-3.0: call its
API, never copy nor port its code.

## Commands

```bash
npm install
gi test                                   # or npm test (node --test --test-timeout=60000)
node --test test/commands.test.js         # one file (through memcap on the dev VM)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run cover                             # cover.png (800x534), plain Node
memcap node scripts/mutants.mjs "$(mktemp -d)"   # mutants of the guards, one at a time
```

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/app.js                        XoApp: lifecycle, reads, token renewal, VM buttons, config buttons
src/xo.js                         REST client on a pinned TLS socket, answers, strict parsers
src/devices.js                    the Gladys devices (pure)
src/store.js                      /data: pins, refused-token mark, pause, last read, stop guards
src/config.js                     DEFAULT_CONFIG (mirrors the manifest) + normalization
src/i18n.js                       texts in English and French
test/helpers/fakeXo.js            simulated Xen Orchestra (HTTPS) on 127.0.0.1
test/kit/                         parts of gladys-testkit (clocks, certificates)
scripts/mutants.mjs               mutants of the guards (list and runner)
```

## Safety rules of this integration

- **Start is allowed; Shut down, Force shutdown, Restart are off by default**
  (one option each), `button`/`push` features, never a switch. Each decides
  on a read of the VM made after the click, is checked again right before the
  first byte (`beforeSend`: option, pause, refusal, newer stop of the VM, stop
  guard, deadline), runs one at a time per VM, one per 15 s per VM, and leaves
  within 3.5 s or not at all.
- **Stop guard**: after Shut down or Force shutdown, Start of that VM is
  refused 60 s; written to /data and waited for before the first byte (not
  written: nothing sent); withdrawn when the stop never left or XO refused it.
- **Nothing sent before a stop leaves after it**: a stop bumps the VM's
  counter, checked in the `beforeSend` of a Start.
- **Done only when a later read shows it**; sent without answer: never resent.
- The token goes only to the configured address, in the cookie, on a
  connection whose certificate is the pinned one, checked before the first
  byte; never logged, never in /data, a status nor an error. The renewed token
  goes back to Gladys (`setConfig`), memory only meanwhile.
- A 401 in the envelope of XO on the VM list refuses the token (6-bit mark in
  /data); a 401/403 elsewhere never does.
- Clocks: monotonic for every decision; wall time only for /data; XO's Date
  header for the ages of XO's data and the token expiry.

## Rules

- **External ids are forever**: `xo-host:<uuid>`, `xo-vm:<uuid>`,
  `xo-sr:<uuid>`, `xo-backup:<job uuid>`, built with `gladys.externalIds`.
  The same goes for the manifest keys and the feature keys
  (`src/constants.js` FEATURES).
- **A device published again never loses a feature** (`withCreatedFeatures`).
- **The container rootfs is read-only**: write only under `/data`.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  that package.json, the lock and the manifest agree.
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **User-facing text** is bilingual (English and French), docs in sync with
  the code.
- **Tests never touch the network** beyond 127.0.0.1; every wait is bounded
  (a test fails, it never hangs).
