# Xen Orchestra / XCP-ng

Follow your XCP-ng hosts, VMs, storage repositories and backups from Gladys, and start a VM, through the
REST API of [Xen Orchestra](https://xen-orchestra.com/) (XO), over HTTPS on your network. Unofficial
integration, not affiliated with Vates, Xen Orchestra nor XCP-ng. **Never tested with a real device**:
written from the official REST API documentation (https://docs.xen-orchestra.com/restapi) and the Swagger
shipped with XO, tested against a simulated Xen Orchestra and, for the reads and the token, against a real
Xen Orchestra in a container without a hypervisor (no real VM started nor stopped).

## What you get

Devices to add from the Discovery (once the Scan is run):

| Device  | Features                                                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Host    | running (binary), memory used (%)                                                                                                   |
| VM      | running (binary), power state (text), CPU (%), memory used (%), memory size (MB); Start, Shut down, Force shutdown, Restart buttons |
| Storage | used (%), free and total space (GB); ISO libraries and removable devices are left out                                               |
| Backup  | last run successful (binary), last run (text), hours since the last success                                                         |

- CPU and memory used come from the XAPI statistics: up to 10 running VMs per read, in turn (with 30
  running VMs, each is read every 3 reads). A sample older than 5 minutes (by the time of XO) is not
  published. Without the guest tools, the memory used stays unknown (never 0).
- Backups: the runs started within the last 8 days (by the time of XO). A job without a success in that
  window has an unknown time since the last success.
- At most 32 hosts, 200 VMs, 64 storage repositories, 64 backup jobs: beyond, the status says so.
- The device ids are the UUIDs given by XO (a renamed VM stays the same device).

## Setup

1. In Xen Orchestra, create an **authentication token** (your user, Authentication tokens, or
   `xo-cli create-token`). Prefer a non-admin user that only sees the VMs you want in Gladys (XO rights).
2. In Gladys, open the integration, type the **address** of Xen Orchestra (as in your browser, e.g.
   `192.168.1.30`; HTTPS only; `:port` if not 443) and the **token**, then save.
3. Click **Trust the certificate** twice. The first click shows the SHA-256 fingerprint of the certificate
   shown and sends nothing else. Compare it with the one your browser shows for `https://<address>/`
   (certificate details), then click again within 2 minutes. You can also type the fingerprint in the
   configuration. From then on, another certificate stops everything (the token is not sent to it) until
   you trust it the same way.
4. Run a **Scan** in the Discovery and create the devices you want.

## The token

- It is kept by Gladys in its database, never shown again, sent only to Xen Orchestra (in the
  `authenticationToken` cookie) and only once its certificate is checked. It is in no log, nor in `/data`,
  nor in the status.
- **Renewal**: every 12 h, the integration reads the expiry of the token (by the time of XO, never the
  container's). When less than half its life, or less than 7 days, is left, it asks XO for a new token with
  the current one (the method documented by XO, no password) and gives it to Gladys, which keeps it instead
  of the old one. The old one stays valid in XO until its own expiry (you can revoke it in XO). If Gladys
  cannot keep the new one, it is used in memory and tried again every 10 minutes; after a restart, the
  token you typed is used while it is valid. Without a readable time of XO, the token is never taken for
  expiring.
- **Refusal**: if XO answers 401 in its own envelope to the read of the VMs, the token is refused: nothing
  is tried again (a 6-bit mark, never the token, is kept in `/data`) until you save another token or click
  **Test the connection**. A 401 or 403 on another route (hosts, backups, statistics, token list) or a 401
  without the envelope of XO (a proxy) is not a refusal.

## The VM buttons

- **Start** is allowed without an option. A paused or suspended VM is not started (resume it in XO).
- **Shut down** (clean, needs the guest tools), **Force shutdown** (like pulling the plug) and **Restart**
  (clean) are off by default, one option each.
- They are buttons, not switches: a "turn everything off" of a voice assistant or a scene does not reach
  them.
- Each command reads the VM again after the click and decides on that read (already running: nothing sent;
  already halted: nothing sent; XO operation running: refused). The option, the pause, a newer stop of the
  same VM and the guard are checked again right before the first byte. One command at a time per VM, one
  per VM per 15 s; another VM is not held.
- After Shut down or Force shutdown, **Start** of that VM is refused for 1 minute. This guard is written to
  `/data` before sending; if `/data` cannot write it, the stop is refused (nothing sent). A stop that did
  not leave withdraws its guard.
- A stop of a VM cancels a Start of the same VM not sent yet (even when that stop is itself refused because
  its option is off or a command is running).
- A command is sent within 3.5 s of the click or not at all (Gladys waits 5 s). It is shown as **done** only
  once a later read shows it (power state, or a new start time for a restart); reads follow (5 s, 20 s, then
  further apart). A read equal to the state before is "not applied yet". Sent without an answer: "sent,
  without confirmation", never sent again by itself. Not sent: "nothing sent". The result shows in the
  status of the integration for 10 minutes.
- Start is refused when: the integration is not configured, the certificate is not pinned, the token is
  refused, XO asked to wait, a newer stop of the same VM came, within the one-minute guard after a stop, a
  command of the VM is running, less than 15 s since the last command of the VM, the VM cannot be read or
  is unknown to XO, an XO operation is running, the VM is paused or suspended, the configuration changed
  during the command (another address or token), the answer is too slow.
- Shut down, Force shutdown and Restart are refused for the same reasons (the guard aside), plus their
  option off, `/data` not keeping the guard (Shut down, Force shutdown) and a VM not running (Shut down,
  Restart).

## Pauses and reads

- The read of the VMs is the main read; hosts, storage, backups, statistics and the token are secondary
  reads: their failure does not stop the others (except a pause or a changed certificate, below) and they
  are spaced (up to 1 h) while they fail.
- A 429, or a 5xx that is not an error of XO itself (a proxy, 502, 503, 504), pauses reads and commands
  (1 min to 6 h, `Retry-After` honoured, kept in `/data`). A 500 of XAPI about a VM pauses nothing.
- Never faster than the interval after a restart, a reconnection to Gladys, a Scan or a click on Test
  (which only tries a refused token again at once); only another address or token saved, or a certificate
  trusted, reads at once. The reads that follow a command do not count.

## Not done

- No creation, deletion, migration, snapshot nor restore; no command on hosts.
- No real-time events (SSE): reads at the interval.
- No user name nor password: a token only.
