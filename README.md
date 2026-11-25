# gladys-xen-orchestra

[Gladys Assistant](https://gladysassistant.com) external integration for **Xen Orchestra / XCP-ng**: the
hosts, the VMs (state, CPU, memory), the storage repositories and the last runs of the backup jobs, and a
Start button per VM (Shut down, Force shutdown and Restart behind options, off by default), through the
REST API of Xen Orchestra (`/rest/v0`) over HTTPS, with the certificate pinned on the user's confirmation
and an XO authentication token renewed before it expires.

Unofficial, not affiliated with Vates, Xen Orchestra nor XCP-ng. **Never tested with a real device yet.**

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Access: an authentication token of XO in the `authenticationToken` cookie; renewed with itself (no
  password) and given back to Gladys.
- Safety: the VM actions are buttons, never switches; each one is decided on a fresh read of the VM,
  checked again right before its first byte, and shown as done only once a later read shows it.

## Development

```bash
npm install
gi test    # or: npm test (node --test --test-timeout=60000)
gi ci      # format, lint, tests on Node 24 and 22, Docker build, store validator
```

The tests run against the SDK's fake Gladys and a simulated Xen Orchestra on 127.0.0.1 (HTTPS with a
self-signed certificate), never the network. See `CLAUDE.md` for the architecture and the rules, `TODO.md`
for the decisions and what comes next.

## License

Apache-2.0 (`LICENSE`). Written from the official documentation of the Xen Orchestra REST API; Xen
Orchestra (AGPL-3.0) is only called over the network, none of its code is here. See
`THIRD_PARTY_NOTICES.md`.
