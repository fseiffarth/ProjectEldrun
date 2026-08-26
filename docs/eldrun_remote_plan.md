# Eldrun Remote — implementation plan

Status: **plan only; nothing in this document is implemented.**

This plan defines a private mobile/PWA controller for terminal sessions already
running on a Linux or macOS Eldrun host. It deliberately does not describe a
general remote desktop, a mobile IDE, or a multi-user collaboration server.

## 1. Outcome and MVP boundary

The validated workflow is:

1. The user explicitly enables Eldrun Remote on one Linux or macOS machine.
2. The user opts one local project into remote access.
3. Eldrun starts a shell, Claude, or Codex tab in that project's existing local
   tmux persistence layer.
4. The user leaves the machine and opens its private Tailscale HTTPS URL on a
   phone or tablet.
5. The paired device lists the opted-in project and its running sessions,
   attaches to one, receives ANSI terminal output, and sends input.
6. Closing the browser or losing the network detaches only the remote viewer.
   The tmux session and its process continue.
7. Reopening the PWA attaches to the same session.

The MVP supports one host origin, one user, multiple revocable devices, and one
remote viewer per session. Linux is implemented and live-tested first; macOS
uses the same protocol and follows after the shared host path is stable.

### Included

- a headless `eldrun-remote-host` sidecar written in Rust;
- a responsive React/Vite PWA served by that host;
- tailnet-only HTTPS through Tailscale Serve;
- short-lived pairing codes and device public-key authentication;
- read-only project/session discovery;
- bidirectional terminal attachment, resize, reconnect, and mobile keys;
- a desktop settings surface for host state, pairing, device revocation, and
  per-project access;
- user-level systemd and LaunchAgent installation.

### Explicitly deferred

- Windows hosting;
- public internet exposure, Tailscale Funnel, or a hosted relay;
- starting, killing, renaming, or deleting sessions from the PWA;
- file browsing/editing, git operations, diffs, approvals, or dev-server links;
- team accounts, roles, shared hosts, or audit export;
- structured Claude/Codex state such as “waiting for input”;
- native iOS/Android clients and push notifications;
- access to root/box scopes, foreign tmux sessions, containers, VMs, or Eldrun
  SSH/worker-host sessions.

The last exclusion is important. A remote project tab runs inside tmux on the
SSH host, while `eldrun-remote-host` runs on the desktop machine. Proxying the
desktop's SSH topology would add credential, connectivity, and host-authority
questions to the first release. It becomes a separate phase only after the
local-host design has real daily use.

## 2. Relationship to existing features

This feature reuses existing session persistence but does not redefine other
features with similar names.

| Existing feature | Relationship |
|---|---|
| [`tmux_remote_plan.md`](tmux_remote_plan.md) and [`context/tmux_sessions.md`](context/tmux_sessions.md) | Reuse Eldrun-minted `eldrun-<scope>--<kind>-<uuid>` names, discovery parsing, and detach semantics. Extend local persistence to opted-in local agent tabs. |
| [`resume_sessions_plan.md`](resume_sessions_plan.md) | Agent resume remains the fallback if a tmux session no longer exists. Live remote attachment does not replace conversation resume. |
| [`multi_host_remote_plan.md`](multi_host_remote_plan.md) | No worker or primary SSH host is exposed in the MVP. |
| [`eldrun_server_plan.md`](eldrun_server_plan.md) | That plan covers multi-user projects/calendar/tasks. Eldrun Remote is a single-user terminal controller and introduces no collaboration server. |
| Claude `--remote-control` (`agent_remote_control` / `remote_control`) | This remains Claude's vendor service. New persisted fields use `eldrun_remote_*` names so the two controls cannot be confused. |

## 3. Fixed architecture

```text
Phone/tablet browser
  Eldrun Remote PWA + xterm.js
          │
          │ same-origin HTTPS + WebSocket
          ▼
Tailscale Serve (tailnet ACLs, TLS termination)
          │
          │ reverse proxy to 127.0.0.1:8742
          ▼
eldrun-remote-host (headless Rust sidecar)
  ├─ static PWA assets
  ├─ pairing/auth/device registry
  ├─ project + tmux discovery
  ├─ WebSocket ↔ PTY bridge
  └─ local admin socket
          │
          ▼
tmux attach-session -t <validated session>
          │
          └─ existing shell / Claude / Codex process

Eldrun desktop ── local admin socket ──► eldrun-remote-host
```

The sidecar is a distinct process because the mobile endpoint must remain
available when the desktop window is closed or restarted. Shared logic belongs
in AppHandle-free Rust services; Tauri commands remain thin desktop adapters.

The host listens only on `127.0.0.1:8742`. It never binds a LAN address,
`0.0.0.0`, or a Tailscale IP. Tailscale Serve is the only supported remote
publication path. Serve provides a tailnet HTTPS reverse proxy and applies
tailnet access policy; the backend still requires Eldrun device authentication.
See the current [Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve)
and [CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

Funnel is unsupported and the setup UI must never invoke it. The setup check
shows the exact Serve URL and current Serve status, but any first-time Tailscale
consent remains a visible user action.

## 4. Source and package layout

The implementation should use these boundaries:

```text
remote-web/
  index.html
  dist/.gitkeep
  src/
    api.ts
    auth.ts
    App.tsx
    screens/{Pair,Projects,Sessions,Terminal}.tsx
    terminal/protocol.ts
  public/{manifest.webmanifest,icons/...}

vite.remote.config.ts
tsconfig.remote.json

src-tauri/src/
  bin/eldrun-remote-host.rs
  services/remote_control/
    mod.rs
    admin.rs
    auth.rs
    config.rs
    discovery.rs
    host.rs
    protocol.rs
    pty_bridge.rs
    store.rs
  commands/remote_control.rs

src-tauri/tests/remote_control_api.rs
```

The root npm installation supplies React, Vite, xterm.js, TypeScript, and
Vitest; the PWA does not get a second lockfile. Add `remote:build` and
`remote:test` scripts. Its build output is generated, ignored, and embedded in
the sidecar during packaging; compiled assets are not committed. Keep only
`dist/.gitkeep` so an ordinary clean `cargo test` can compile the embed path.
Release packaging must run `remote:build` before Cargo and fail if the expected
manifest and entry asset are absent.

Add a second Cargo binary named `eldrun-remote-host`. The HTTP stack is Axum on
the existing Tokio runtime, with its WebSocket feature. The PWA bundle is
embedded so the user-level service has no mutable document root. Crypto uses a
maintained P-256 verifier plus the already present randomness, SHA-256, base64,
and zeroization facilities. All command execution uses argv APIs; no session id,
project field, or request value is interpolated into a shell string.

Packaging must include the host binary. Enabling the feature copies the bundled
sidecar into a versioned directory below `<state_dir>/remote-control/bin/` and
atomically updates a `current` link before restarting the user service. A
service file must not point into an AppImage mount or another transient bundle
path.

## 5. Persisted state

### 5.1 Global settings

Extend `Settings` and its TypeScript mirror with:

```json
{
  "eldrun_remote_host": {
    "enabled": false,
    "display_name": "Workstation",
    "port": 8742,
    "serve_url": "https://workstation.example.ts.net"
  }
}
```

Rules:

- absent means disabled;
- `port` is advanced configuration, validated to `1024..=65535`;
- `serve_url` is written only after setup verifies Tailscale Serve status;
- it must be an `https` origin with no user info, query, fragment, or non-root
  path;
- changing the port updates the service and requires the user to update Serve;
- the desktop owns this setting; the sidecar reads it but does not rewrite it.

### 5.2 Per-project opt-in

Add `eldrun_remote_access?: boolean` to project state, defaulting to `false`.
The field must round-trip through both `projects.json` and the project's
`project.json` using the established extra-field-compatible schema path.

Only local projects can enable it in the MVP. The UI hides or disables the
toggle for root, box, remote, container, and VM scopes with a specific reason.
Enabling it does not start a process; it only makes qualifying existing/future
tmux sessions discoverable.

### 5.3 Host-owned files

Under `<state_dir>/remote-control/`:

```text
devices.json       paired public keys and revocation state
host.key           random host HMAC key, mode 0600
audit.jsonl        security events only
admin.sock         Unix socket while the host is running, mode 0600
bin/<version>/...  installed sidecar
```

`devices.json` is versioned and atomically replaced. Each device record is:

```json
{
  "id": "uuid",
  "name": "Personal phone",
  "public_key_spki": "base64...",
  "created_at": "RFC3339 UTC",
  "last_seen_at": "RFC3339 UTC",
  "revoked_at": null
}
```

No bearer token, pairing code, terminal bytes, command line, environment, cwd,
or project path is written to the audit log. Rotate it at 10 MiB and keep three
files. Log enable/disable, pairing success/failure, authentication failure,
revoke, connect, detach, and protocol-limit disconnect.

## 6. Session eligibility and lifecycle

The discovery service reloads project state on change and polls tmux every two
seconds through the existing `tmux_ls_script` / `parse_tmux_ls` data path. It
joins each live tmux name to the owning project's persisted tab layout; the tab
record supplies the user-facing label, shell/agent kind, agent name,
`tmuxSession`, configured cwd, and ephemeral flag. A session is exposed only
when all conditions hold:

1. the project is local and `eldrun_remote_access == true`;
2. a restorable local shell/agent tab in that project's layout names the exact
   live session in `TabEntry.tmuxSession` and is not ephemeral;
3. the session name exactly matches that project's minted
   `eldrun-<sanitized-project-id>--shell-*` or `--agent-*` prefix;
4. the tab's configured canonical cwd is the project's canonical directory or
   a descendant;
5. the session returned by tmux still exists.

Foreign, renamed, legacy-unclassified, root, and box sessions are excluded.
Matching is performed on parsed values and canonical paths, never prefix-only
path strings. Before attach, the service resolves the requested opaque API id
back through the current discovery snapshot; it never accepts an arbitrary
tmux target from the client. A shell remains exposed after the user `cd`s out
of the project because eligibility uses its persisted launch cwd, not the live
pane cwd; the exact layout/session join remains the authority.

The API session id is the first 22 base64url characters of
`HMAC-SHA256(host.key, tmux_name)`. It is stable across polling and sidecar
restart, reveals no tmux name, rotates with **Forget all devices**, and is useful
only while an exact matching entry exists in the current discovery map.

Local shell tabs already use the local tmux path on Unix. Extend
`shouldPersistLocalTab` and the corresponding backend assumptions so a local
Claude/Codex agent tab in an opted-in project is also tmux-backed. The existing
stable `TabEntry.tmuxSession` name is reused. If the tmux session survives a
restart, Eldrun reattaches it; otherwise normal Claude/Codex session resume
creates the replacement. Enabling access does not respawn an already running
non-tmux agent tab: settings must say that the tab becomes remotely available
after its next ordinary restart/reopen.

The remote host attaches with a dedicated PTY running `tmux attach-session -t`
against the validated target. It does not use `-D`, because that would evict the
desktop's client. Before first remote attach, set the session's tmux
`window-size` policy to `largest` so a phone does not shrink a simultaneously
visible desktop terminal. This is a session-scoped change and requires an
automated argv test plus live two-client QA.

Only one PWA WebSocket may attach to a session at a time in the MVP. A second
remote attempt receives HTTP `409 session_busy`; the desktop tmux client does
not count as that remote viewer. Closing the WebSocket, browser, or sidecar PTY
detaches its tmux client and never calls `kill-session`. `Ctrl-C` is ordinary
input byte `0x03`: it may interrupt the foreground process but still does not
destroy the tmux session.

## 7. Authentication and transport security

Tailnet membership is necessary but insufficient: terminal input is remote code
execution under the host user's account.

### 7.1 Pairing

1. In desktop settings, the user clicks **Pair device**.
2. The desktop asks the sidecar over `admin.sock` to create a random eight-digit
   code valid for five minutes. The sidecar retains only a keyed hash in memory.
3. The PWA creates a non-exportable ECDSA P-256 key in Web Crypto/IndexedDB and
   submits the code, device name, and SPKI public key.
4. The sidecar consumes the code once, stores the public key, and returns the
   device id.
5. The PWA completes the challenge flow below. A host restart cancels pending
   pairing, which is the safe failure direction.

Pair attempts are limited globally to five per minute and twenty per hour.
Five consecutive failures impose a ten-minute pairing cooldown. Tailscale Serve
may make the transport peer appear to be loopback, so forwarded/source address
is audit context at most and is never an authentication or rate-limit key.
Codes are compared in constant time.

### 7.2 Returning-device authentication

1. `POST /api/v1/auth/challenge` with a device id returns a random, single-use
   nonce valid for 60 seconds.
2. The client signs a versioned payload containing the host origin, device id,
   nonce, and expiry.
3. `POST /api/v1/auth/session` verifies the signature and revocation state.
4. The host creates an in-memory session and sets
   `__Host-eldrun_session` with `Secure`, `HttpOnly`, `SameSite=Strict`, and
   `Path=/`. It expires after 12 hours or host restart.

Revocation deletes active auth sessions for that device immediately. Private
keys never leave the browser's non-exportable Web Crypto store. Losing browser
site data requires pairing again. The public key uses DER SPKI; the ECDSA
signature crossing the API is the 64-byte IEEE P1363 `r || s` form, both encoded
as unpadded base64url, so browser and Rust encodings are not left implicit.

### 7.3 Browser boundary

- Serve the PWA and API from the same origin; emit no CORS allowlist.
- Check the exact configured HTTPS `Origin` on pairing, authentication,
  mutation, and WebSocket upgrade requests.
- Use a strict CSP: `default-src 'self'`; no third-party scripts, analytics,
  fonts, service-worker imports, or inline script exceptions.
- Set HSTS, `X-Content-Type-Options: nosniff`, a deny framing policy, and a
  restrictive permissions policy.
- Do not accept auth in URLs or WebSocket query parameters.
- Limit request bodies to 64 KiB and reject unknown JSON fields on security and
  control messages.
- Never trust forwarded Tailscale identity headers as Eldrun authentication.

## 8. HTTP API

All responses use JSON, UTC RFC3339 timestamps, and a versioned error envelope:

```json
{ "error": { "code": "session_busy", "message": "This session already has a remote viewer." } }
```

Unauthenticated endpoints:

```text
GET  /healthz
POST /api/v1/pair
POST /api/v1/auth/challenge
POST /api/v1/auth/session
```

`/healthz` returns only `{ "ok": true }`; it does not reveal host name,
projects, version, or device state.

Authenticated endpoints:

```text
DELETE /api/v1/auth/session
GET    /api/v1/status
GET    /api/v1/projects
GET    /api/v1/projects/:project_id/sessions
GET    /api/v1/sessions/:session_id
GET    /api/v1/sessions/:session_id/terminal   (WebSocket upgrade)
```

Representative response shapes:

```json
{
  "host": {
    "name": "Workstation",
    "platform": "linux",
    "version": "0.1.51"
  }
}
```

```json
{
  "projects": [
    { "id": "project-uuid", "name": "ProjectEldrun", "session_count": 2 }
  ]
}
```

```json
{
  "sessions": [
    {
      "id": "opaque-snapshot-id",
      "name": "Claude",
      "kind": "agent",
      "agent": "claude",
      "remote_attached": false,
      "last_activity_at": "2026-08-24T12:00:00Z"
    }
  ]
}
```

Do not report “waiting”, “idle”, or “running” from terminal-text heuristics.
For the MVP, the honest states are `available`, `remote_attached`, and `gone`.
Project paths, tmux names, process argv, and environment are not API fields.

## 9. Terminal WebSocket protocol

The WebSocket is same-origin and authenticated by the secure session cookie.
Subprotocol: `eldrun-terminal.v1`.

- Server-to-client binary frames are raw PTY output bytes.
- Client-to-server binary frames are raw terminal input bytes.
- Text frames are JSON control messages.

Client controls:

```json
{ "type": "resize", "cols": 90, "rows": 28 }
```

Server controls:

```json
{ "type": "ready", "cols": 90, "rows": 28 }
```

```json
{ "type": "detached", "reason": "session_gone" }
```

The client encodes special keys as terminal bytes: Ctrl-C `03`, Esc `1b`, Tab
`09`, and standard ANSI arrow sequences. There are no parallel HTTP interrupt
or resize endpoints.

Bounds:

- cols `20..=400`, rows `5..=200`;
- input frame maximum 64 KiB;
- output queue maximum 1 MiB per connection;
- eight concurrent terminal sockets per paired device and one per session;
- ping every 20 seconds, stale after 60 seconds;
- on backpressure, close with a retryable protocol error while leaving tmux
  untouched.

On attach, tmux redraw supplies the current screen. The PWA's xterm.js instance
then receives normal ANSI/UTF-8 output, including cursor state and alternate
screen behavior. The server does not stream screenshots or poll `capture-pane`.

## 10. PWA interaction design

The PWA has four screens and no global desktop navigation.

1. **Pair** — host label, device-name input, eight-digit code, precise failure
   and expiry states.
2. **Projects** — opted-in projects only, session count, connection indicator,
   refresh, sign out.
3. **Sessions** — honest availability/attached state, agent/shell label, last
   activity, tap to attach.
4. **Terminal** — xterm.js canvas, reconnect banner, disconnect button, and a
   sticky key bar for Ctrl, Esc, Tab, and arrows.

Mobile input rules:

- tapping the terminal focuses a visually present text input so mobile keyboards
  open reliably;
- Enter sends `\r`, Backspace sends `0x7f`, and pasted text is sent as UTF-8;
- Ctrl is one-shot on touch: tap Ctrl, then the next key;
- Ctrl-C has a dedicated guarded button labelled **Interrupt**;
- browser disconnect returns to Sessions and never offers “terminate”;
- orientation/viewport changes debounce resize to 100 ms;
- reconnect uses exponential backoff from 0.5 to 10 seconds for at most one
  minute, then requires a tap;
- an auth failure returns to the local-key challenge, not pairing, unless the
  device was revoked.

The service worker caches only versioned static assets and an offline shell.
API and terminal responses use `Cache-Control: no-store` and are never placed in
Cache Storage. The offline screen says the host is unreachable; it does not show
stale project/session data.

## 11. Desktop setup and host services

Add a dedicated **Remote access** page in Settings, containing an **Eldrun
Remote** section with:

- disabled/enabled state, default disabled;
- dependency checks for tmux, Tailscale, Serve HTTPS, and the installed sidecar;
- the verified tailnet URL and **Open PWA** action;
- user-service status and last error;
- **Pair device**, paired-device list, last seen, and **Revoke**;
- a project checklist containing eligible local projects only;
- a notice beside any live non-tmux agent tab that it becomes available after
  its next restart/reopen;
- copyable Tailscale Serve setup/status commands;
- an explicit warning that terminal control can execute commands as the user.

Do not put the new project toggle beside the existing Claude “Remote control”
item. That label already means `--remote-control`. Project eligibility belongs
inside this dedicated panel and may later get a clearly named pill shortcut.

The desktop talks to the running host only through the mode-0600 Unix admin
socket. Admin messages are length-prefixed, versioned JSON with commands for
`status`, `begin_pairing`, `list_devices`, `revoke_device`, and `shutdown`.
Filesystem ownership is checked before connecting. There is no TCP admin API.

Linux service:

```text
~/.config/systemd/user/eldrun-remote-host.service
```

- starts with the user's login session and does not depend on the desktop app;
- remains healthy when Tailscale is unavailable; Serve reachability is reported
  separately rather than made a process-start dependency;
- `Restart=on-failure` with bounded restart delay;
- runs as the logged-in user with no sudo;
- writes only below Eldrun state and runtime directories.

macOS service:

```text
~/Library/LaunchAgents/io.eldrun.remote-host.plist
```

- `RunAtLoad` and `KeepAlive` on failure;
- same loopback port, state format, API, and binary as Linux;
- no attempt to defeat sleep. The PWA reports the host offline when a Mac sleeps.

Disable stops/unloads the user service and removes the Tailscale Serve mapping
only after a separate confirmation. It preserves paired-device records so
re-enabling is nondestructive. **Forget all devices** is a distinct destructive
action that rotates `host.key` and clears devices/auth sessions.

## 12. Delivery phases

Each phase ends green and leaves no half-public endpoint.

### Phase 0 — contracts and pure services

- add protocol/config/device/session types;
- extract/reuse tmux parsing and project eligibility behind traits;
- define exact API and admin messages with serde unknown-field rejection where
  required;
- add fixture tests for old settings/project JSON round-trip;
- no listener, setting, or UI yet.

Exit gate: pure tests cover eligibility, canonical-path containment, malformed
tmux names, stale snapshots, and schema defaults.

### Phase 1 — headless host on loopback

- add the second Rust binary and Axum listener;
- implement embedded static health placeholder, auth middleware skeleton, and
  project/session discovery;
- implement local admin socket and clean shutdown;
- bind only loopback and refuse wildcard/non-loopback configuration.

Exit gate: integration tests use an ephemeral loopback port, temp state, and a
fake tmux adapter; an unauthenticated caller cannot enumerate anything.

### Phase 2 — pairing and security boundary

- device-key pairing, challenges, secure cookie sessions, revocation;
- origin checks, CSP/headers, body/rate/concurrency limits, audit rotation;
- adversarial tests for replay, expiry, wrong origin/host/device, revoked key,
  malformed SPKI/signature, brute-force cooldown, and log redaction.

Exit gate: the API security test matrix is green before any terminal input path
is connected.

### Phase 3 — PTY/tmux bridge

- AppHandle-free `pty_bridge` and WebSocket protocol;
- exact discovery-snapshot lookup before argv construction;
- raw byte streaming, resize, detach, ping, and backpressure;
- local agent-tab tmux eligibility for opted-in projects;
- `window-size largest` and coexistence with the desktop tmux client.

Exit gate: fake-adapter tests prove disconnect/error never invokes kill; Unix
integration tests attach to a disposable tmux session and verify UTF-8, ANSI,
Ctrl-C, resize, reconnect, busy rejection, and session survival.

### Phase 4 — PWA

- Pair, Projects, Sessions, and Terminal screens;
- non-exportable key persistence and challenge login;
- xterm.js, touch key bar, resize/reconnect behavior;
- manifest, icons, service worker, offline state, and accessibility labels.

Exit gate: Vitest covers protocol/input/state reducers and browser tests cover
pair → attach → network drop → reconnect with a fake server. No API response is
present in Cache Storage.

### Phase 5 — desktop setup and Linux packaging

- Settings panel and per-project opt-in;
- dependency/status checks and explicit Serve setup;
- sidecar packaging/install/update and systemd user service;
- device list/revoke/forget and audit-error surfacing.

Exit gate: clean-install and upgrade tests verify a stable executable path,
disabled-by-default behavior, loopback-only listening, service restart, and no
Funnel configuration.

### Phase 6 — Linux live QA

Run the acceptance matrix in §14 on a real Linux workstation and phone over
Wi-Fi, cellular, sleep/wake, and Tailscale reconnect. Fix findings before macOS.

### Phase 7 — macOS packaging and QA

- LaunchAgent install/update/uninstall;
- packaged sidecar path and code-signing/notarization coverage;
- explicit sleep/offline UX validation;
- repeat the same protocol/security matrix without platform forks.

## 13. Automated verification

Every implementation phase runs the repository gates relevant to its files:

```bash
rtk npm run build
rtk npm test
rtk npm run lint
rtk cargo test --manifest-path src-tauri/Cargo.toml
rtk cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
rtk git diff --check
```

Add these focused suites:

- Rust unit tests for config validation, auth, rate limits, project/session
  filtering, argv construction, audit redaction/rotation, and protocol bounds;
- Rust HTTP/WebSocket tests against fake clock, state, tmux, and PTY adapters;
- Unix tmux integration tests with unique disposable session names and explicit
  cleanup;
- frontend tests for key encoding, pairing transitions, reconnect/backoff,
  resize debounce, no-store/offline behavior, and error rendering;
- package tests asserting that both binaries and the PWA bundle exist in Linux
  and macOS artifacts.

No automated verification launches Eldrun. Frontend changes hot-reload in an
already running instance; backend/runtime QA requires the user to rebuild and
restart the existing instance under the repository's runtime-safety rules.

## 14. Manual acceptance matrix

MVP is complete only when every row passes on Linux, then macOS where applicable.

| Case | Expected result |
|---|---|
| Feature never enabled | No sidecar process, listener, Serve mapping, or remotely visible metadata. |
| Host enabled, no project opted in | Authenticated PWA shows an empty Projects screen. |
| Pair correct code | Device appears once; code cannot be reused. |
| Wrong/expired code | No device record; cooldown is visible after repeated failures. |
| Revoke attached phone | Its HTTP session and terminal socket close immediately; tmux keeps running. |
| Local shell session | Live output/input, resize, interrupt, disconnect, and same-session reconnect work. |
| Local Claude session | Prompt and response work; phone detach does not end Claude. |
| Local Codex session | Prompt and response work; phone detach does not end Codex. |
| Desktop and phone attached | Both render; phone sizing does not shrink desktop; neither evicts the other. |
| Second PWA viewer | Receives `session_busy`; first viewer is unchanged. |
| Eldrun desktop exits | Sidecar and tmux session remain reachable. |
| Sidecar restarts | tmux process survives; paired key reauthenticates; attach works again. |
| Network changes Wi-Fi → cellular | Socket reconnects to the same session without re-pairing. |
| Host sleeps/offlines | PWA shows unreachable/offline and never displays stale session data. |
| Foreign/root/remote project tmux | Never appears through the API. |
| Attempt arbitrary session id/path | Request is rejected before any tmux command runs. |
| Slow client/output flood | Socket closes at the bound; host and tmux remain healthy. |
| Disable feature | Listener/service stop; explicit confirmation removes Serve mapping; tmux sessions continue. |
| Re-enable feature | Existing non-revoked devices can authenticate again. |

## 15. Post-MVP order

Follow-ups are considered in this order, each with a separate threat-model and
scope update:

1. read-only secondary viewers and explicit writer handoff;
2. remote start actions from fixed templates, never arbitrary API argv;
3. agent-specific “needs input” adapters with an honest unknown fallback;
4. multiple saved host origins in one installed client;
5. opt-in proxying to Eldrun SSH/worker hosts;
6. notification delivery;
7. native mobile wrappers;
8. team roles or any public/relay transport.

The MVP should not pre-build these abstractions. Its durable seam is smaller:
an authenticated device selects an explicitly exposed Eldrun tmux session and
gets a bounded byte stream to a disposable viewer PTY; the host remains the
sole authority for projects, credentials, tools, and processes.
