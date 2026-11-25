# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Xen Orchestra over its REST API (`/rest/v0`, HTTPS): hosts (running, memory
  used), VMs (running, power state, CPU, memory used, memory size), storage
  repositories (used, free, total) and backup jobs (last run, success, hours
  since the last success), as devices of the Discovery.
- Certificate of Xen Orchestra trusted in two clicks (or typed); a changed one
  stops everything until trusted again.
- Authentication token of XO in the `authenticationToken` cookie; refused (401
  of XO on the VM list): 16-bit salted mark in /data, never tried again until a
  new token or the Test button. Renewed with itself (`POST /rest/v0/users/<id>/authentication_tokens`) before it expires, by the time of XO, its expiry read again at a quarter of the time left (5 min to 12 h), and given back to Gladys.
- VM buttons: Start allowed; Shut down, Force shutdown and Restart off by
  default. Decided on a fresh read, checked again right before sending, one
  per VM per 15 s; Start refused 1 min after a stop (guard written to /data
  before sending); done only once a later read shows it.
- 429/5xx pause (1 min to 6 h) kept in /data; the last read paces a restart.
