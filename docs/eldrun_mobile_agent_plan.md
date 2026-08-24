# Eldrun Mobile — project and agent-tab control plan

Status: **Linux MVP implemented; automated and real-phone security/acceptance QA remains.**

Implemented in the repository on **2026-08-24**: the loopback sidecar and
state-dir discovery boundary, device pairing/authentication, desktop-mediated
tab creation, tmux multi-client prerequisite, PWA, Settings opt-in/lifecycle,
systemd installation, and read-only phone installation handoff. The macOS
LaunchAgent/package phase remains the follow-up described in delivery step 8;
native wrappers and expanded scopes remain out of scope under section 12.

Last evaluated against the repository: **2026-08-24**.

This plan defines a private phone/tablet companion for steering the
**project-scoped agent and shell tabs** of one Eldrun desktop host. It is a
compact terminal-control product, not a mobile copy of the desktop workspace.

It supersedes [`eldrun_remote_plan.md`](eldrun_remote_plan.md) as the intended
product direction. That earlier, attach-only plan remains useful design input,
but the two plans must not be implemented as parallel products or protocols.

## 1. Evaluation and decision

The product is feasible on Linux and macOS, but the previous draft crossed four
current Eldrun boundaries that must be explicit before implementation:

1. **The sidecar cannot safely create desktop tabs by editing session files.**
   Live tab/layout state is owned by the frontend Zustand stores and saved as a
   full snapshot. A second writer can be overwritten by the next desktop save.
   Creation must go through a local desktop bridge and the same store actions as
   the `+` menu.
2. **The sidecar cannot attach to an ordinary in-process PTY.** Mobile-eligible
   tabs must be backed by a live tmux session. Local shell tabs already have that
   path on Unix. Local `kind: "agent"` tabs need a narrowly gated extension;
   host-bound `local_agent`/Ollama tabs remain excluded.
3. **Current tmux attach flags are not multi-client-safe.** Eldrun's
   `tmux new-session -A -D` path can detach another client. Mobile eligibility
   requires a non-evicting desktop attach and `window-size largest`, with live
   desktop-and-phone coexistence tests.
4. **“Needs attention” has no headless source of truth.** Today's prompt/activity
   classifiers live in the desktop process. MVP reports only facts available
   from trusted state and tmux: desktop availability, session availability,
   remote-viewer occupancy, and tmux activity time. It does not infer agent state
   from terminal text.

The resulting MVP has one deliberate limitation: **new-tab creation requires
the Eldrun desktop process to be running**. Discovery and attachment to an
already-running tmux session continue while the desktop is closed or restarting.
Creating while the desktop is absent is a later daemon-owned-state design, not a
file-write shortcut.

## 2. Outcome

From a paired phone or tablet, the user can:

1. open an **Active** home screen showing opted-in projects with live sessions
   or an active desktop status;
2. use **Search** to find any other opted-in eligible project by display name;
3. open a project and see its current eligible agent and shell tabs;
4. while the desktop is available, create a blank shell tab or a supported,
   configured agent tab that also appears in Eldrun; and
5. open one tab as a terminal, receive its live output, and send normal terminal
   input.

The mobile app has no file viewer, browser, editor, PDF/image viewer, settings,
calendar, git, external-app, root, box, or project-management tabs. It does not
mirror the desktop layout or stream the desktop screen.

The first client is a responsive installable PWA served privately by the host.
A native iOS/Android wrapper may follow, but it must reuse this API and protocol.

## 3. Scope and authority

### Included in the first usable release

- one user, one Linux host, and multiple individually revocable paired devices;
- a macOS follow-up using the same protocol after the Linux path is live-tested;
- tailnet-only HTTPS publication through Tailscale Serve, with the host bound to
  loopback only;
- project and eligible-tab discovery;
- creation of a permitted shell or resumable configured agent while Eldrun is
  running;
- tmux terminal attach, input, resize, reconnect, and intentional detach;
- desktop settings for host lifecycle, pairing, device revocation, Serve status,
  and per-project opt-in.

### Explicitly out of scope

- browsing, editing, uploading, downloading, or opening files;
- viewer/embed/browser/external-app tab types;
- arbitrary executable paths, argv, environment, cwd, shell strings, remote SSH
  commands, or initial agent prompts supplied by the phone;
- killing, renaming, moving, closing, or changing the mode of an existing tab;
- inferred “working”, “waiting”, “done”, or “needs attention” states;
- root and box scopes, foreign tmux sessions, `local_agent` tabs, and project
  settings management;
- remote/primary/worker-host projects, containers, VMs, and Windows hosting;
- public Internet exposure, Tailscale Funnel, hosted relays, team accounts, push
  notifications, and native app stores.

Mobile input is command execution as the desktop user. A paired device therefore
has keyboard-equivalent authority inside eligible tabs of opted-in projects. It
does not receive a general launch API. Every project, tab, agent, mode, and
creation request is resolved against current host state; request data is never
used as an executable path or argv fragment.

Project access defaults off. Disabling `eldrun_mobile_access` immediately removes
the project and detaches its mobile WebSockets, but does not stop its tmux
sessions. Deactivating a project in Eldrun remains different: today's desktop
deactivation flow intentionally stops that project's persistent sessions.

The existing Claude `agent_remote_control` / per-project `remote_control` setting
is the vendor's Claude remote-control feature. It is independent of this plan;
all new persisted names use `eldrun_mobile_*` to avoid confusing the two.

## 4. Mobile information architecture

```text
Home
├─ Active                 opted-in projects with live sessions/desktop activity
└─ Search                 display-name filter over all opted-in projects
     └─ Project
         ├─ Current tabs  eligible agent and shell rows only
         ├─ New agent     permitted while the desktop bridge is online
         └─ New shell     permitted while the desktop bridge is online
              └─ Terminal live output and normal keyboard input
```

### 4.1 Home and project screens

**Active** sorts projects with live tmux sessions first, then projects marked
current/active by the desktop. Each row may show the display label, eligible live
session count, desktop availability, and newest tmux activity time. It never
includes a path, prompt, terminal output, command line, or environment value.

**Search** filters the same opted-in catalog by display label. Raw project ids are
not searchable or returned by the API; client-visible ids are opaque.

The project screen lists only eligible current agent and shell tabs. A row shows
the desktop label, kind, configured agent label where applicable, availability,
remote-viewer occupancy, and last tmux activity. A missing tmux session is
reported as gone and cannot be attached.

Creation controls show an explicit **Desktop unavailable** state rather than
silently queuing work. Creating in an inactive project first activates it in
Eldrun, hydrates its saved scope, and then adds the tab without making that
project the currently focused desktop project.

### 4.2 New shell and agent

**New shell** creates the desktop's ordinary blank shell at the project's
canonical directory. The user types commands through the terminal; there is no
HTTP “run command” endpoint.

**New agent** lists only definitions the desktop currently considers:

- installed and not disabled;
- `kind: "agent"`, never host-bound `local_agent`;
- restart-resumable under `isResumableAgentTab` (a supported built-in, or a
  custom agent with configured `resumeArgs`); and
- launchable in a local, non-container, non-VM project.

Plan/Auto choices come only from `components/tabs/agentModes.ts`, and only when
the desktop's agent-mode feature exposes them. The phone sends an opaque catalog
id plus an optional advertised mode; it never sends a command or flag. MVP does
not accept an initial prompt because agents have no uniform prompt argv and
typing hidden input after spawn would require fragile readiness heuristics. The
terminal opens and the user types the prompt normally.

Creation uses a client-generated idempotency key. The desktop records a keyed
hash of that request on the trusted saved tab entry, so retrying after a timeout
returns the same tab rather than creating another. A spawn failure remains a
visible failed terminal tab, matching desktop behavior; it is not silently
rolled back or duplicated.

### 4.3 Terminal

The terminal uses xterm.js and exchanges bytes over an authenticated WebSocket.
It provides touch-friendly Ctrl, Esc, Tab, arrows, Enter, Backspace, and a guarded
Interrupt key, plus a visible input proxy so mobile keyboards open reliably.

Resize is debounced. Network loss or closing the browser detaches only the
mobile tmux client and never calls `kill-session`. One mobile viewer may attach
to a tab in MVP; another receives `session_busy`. The desktop client may coexist
and is not counted as the mobile viewer.

## 5. Host and desktop architecture

```text
Paired phone/tablet PWA
        │ same-origin HTTPS + WebSocket
        ▼
Tailscale Serve (tailnet TLS and ACLs)
        ▼
eldrun-mobile-host, bound to 127.0.0.1 only
  ├─ static PWA assets
  ├─ pairing/authentication and device store
  ├─ read-only project/session discovery
  ├─ tmux-backed terminal bridge
  ├─ admin.sock             desktop settings → sidecar
  └─ desktop client         sidecar → desktop-control.sock
                                      │
                                      ▼
Eldrun Tauri backend ── event/request router ── MobileBridgeHost
                                                ├─ useProjectsStore
                                                ├─ useTabsStore
                                                └─ shared new-tab helpers
```

`eldrun-mobile-host` is a distinct Rust binary. It stays available when the
desktop exits, allowing existing sessions to remain discoverable and attachable.
It never becomes a second writer of `projects.json`, settings, or terminal
layouts.

The desktop exposes `<state_dir>/mobile-control/desktop-control.sock` only while
it is running. The sidecar sends typed catalog/creation requests to that socket.
The Tauri backend validates and routes each request to one `MobileBridgeHost`
mounted in `AppShell`; that host calls the same stores and helper functions as the
desktop UI and returns a bounded response. No responding window or a timeout
returns `desktop_unavailable`.

The sidecar owns `<state_dir>/mobile-control/admin.sock`. Desktop settings use it
for sidecar status, pairing codes, and device revocation. Both sockets live in a
mode-0700 directory, use mode 0600, apply peer-credential checks where supported,
and use length-delimited, size-bounded messages. Shared host logic stays
`AppHandle`-free; Tauri commands are adapters.

The HTTP listener binds only `127.0.0.1`. Tailscale Serve is the supported
publisher and must proxy to `http://127.0.0.1:<port>`. Funnel, LAN bindings, and
direct public exposure are refused. Tailnet membership is necessary but not
sufficient: Eldrun device-key authentication remains mandatory.

Tailscale's current Serve CLI supports a loopback HTTP reverse proxy, tailnet
HTTPS, ACL enforcement, and persistent `--bg` mappings. Setup must inspect the
machine's existing Serve configuration before proposing a change; it must never
overwrite an existing root handler, reset Serve, or switch a Funnel mapping
without an explicit user confirmation. See the official
[Serve overview](https://tailscale.com/docs/features/tailscale-serve) and
[CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

## 6. Trusted state and discovery

### 6.1 Persisted settings

Add an optional global settings block; absent means disabled:

```json
{
  "eldrun_mobile_host": {
    "enabled": false,
    "display_name": "Workstation",
    "port": 8742,
    "serve_origin": "https://workstation.example.ts.net"
  }
}
```

`serve_origin` is written only after verification. It must be one exact HTTPS
origin with no userinfo, query, fragment, or non-root path. The sidecar reads
this setting but does not rewrite it.

Add `eldrun_mobile_access?: boolean` to `ProjectEntry` and the Rust schema. The
authoritative authorization bit is `projects.json`'s flattened
`extra["eldrun_mobile_access"]`, because that file is outside the project tree.
It may be mirrored into `project.json` for display/export compatibility, but the
sidecar and spawn path must never trust that project-writable copy.

Only local projects with no enabled sandbox or VM may set the bit in MVP. Mobile
access also requires Unix tmux and `persist_local_sessions !== false`; Settings
must explain and offer the deliberate enable action rather than silently changing
the global persistence preference.

### 6.2 Host-owned files

Under `<state_dir>/mobile-control/`:

```text
devices.json       paired public keys and revocation state
host.key           random host HMAC/signing material, mode 0600
audit.jsonl        bounded security events only
admin.sock         sidecar-owned runtime socket
desktop-control.sock  desktop-owned runtime socket
bin/<version>/     installed mobile-host binary
```

Device and key files use durable atomic writes, restrictive ownership checks,
and versioned schemas. Audit rotation is bounded. No terminal bytes, prompt,
command line, cwd, environment, raw project id/path, auth cookie, private key, or
pairing code is logged.

### 6.3 Eligibility and discovery

The sidecar reads only the trusted state-dir copies:

- `<state_dir>/projects.json` for identity, eligibility, status, and opt-in; and
- `<state_dir>/sessions/<project-id>/terminals.json` for the authoritative saved
  tab layout.

It never uses the project-tree `.eldrun` export as authority. It reloads on file
change with a bounded poll fallback and retains the last valid snapshot across a
transient partial/unreadable write.

An attachable tab must:

1. belong to an opted-in local, non-container, non-VM project;
2. be a persisted non-ephemeral shell or restart-resumable `agent`, never
   `local_agent` or a pane/viewer kind;
3. carry the exact stable Eldrun tmux name for that project and kind;
4. have a canonical launch cwd equal to or below the canonical project root; and
5. join to an exact live local tmux discovery record.

Foreign, renamed, legacy-unclassified, root, and box sessions are excluded.
Every attach and mutation resolves its opaque id through a fresh snapshot. No
client-supplied tmux target, cwd, path, command, or argv reaches a process API.

Client ids are domain-separated HMAC values, for example
`HMAC-SHA256(host.key, "project\0" || project_id)` and
`HMAC-SHA256(host.key, "tab\0" || project_id || "\0" || tmux_name)`, truncated
to at least 128 bits and encoded as unpadded base64url. They reveal no raw ids or
session names and rotate with **Forget all devices**.

## 7. Creation and tmux lifecycle

### 7.1 Desktop-mediated creation

The API accepts a strict `CreateTabRequest` containing only an opaque project id,
`shell` or `agent`, an advertised opaque agent id and optional supported mode,
and an idempotency key. The sidecar then:

1. rechecks project opt-in/eligibility and desktop availability;
2. sends the typed request to the desktop bridge;
3. has the desktop recheck the trusted project record and current agent catalog;
4. activates the project if needed and fully hydrates its scope before mutation;
5. builds the tab with the shared `newTabItems.ts`/agent-mode helpers, adds it to
   the target scope, and strictly persists the scope; and
6. waits for its exact tmux session to appear before returning the opaque tab id,
   or returns an actionable launch error tied to the already-visible tab.

The bridge must add a focused store-level “hydrate then create in scope” action;
open-coding asynchronous load/add/save in a component would reintroduce the
empty-scope overwrite race this architecture is avoiding.

Only the desktop mutates layout state. When it is absent, `POST .../tabs`
returns `503 desktop_unavailable`; it neither writes the layout nor queues a
surprise tab for the next launch.

### 7.2 Local tmux prerequisite

Extend local persistence only for opted-in, eligible, restart-resumable
`kind: "agent"` tabs. The existing stable `TabEntry.tmuxSession` value is reused.
Ordinary shells keep today's local persistence behavior. `local_agent`,
ephemeral, root/box, container, VM, and non-resumable agent tabs are not widened.

Enabling mobile access does not respawn a live non-tmux agent. Settings must say
that it becomes mobile-attachable after its next ordinary reopen/restart.

For mobile-eligible sessions:

- replace the evicting `-A -D` attach behavior with a non-evicting multi-client
  attach;
- set tmux's window-size policy to `largest` so a phone cannot shrink a desktop
  terminal;
- keep close/unmount semantics as client detach, never implicit session kill;
- preserve explicit desktop project-deactivation/session-kill behavior; and
- compose tmux survival with existing agent resume: reattach the live process if
  tmux survived, otherwise recreate it through the normal resume path.

## 8. Authentication, browser boundary, and API

### 8.1 Pairing and login

Pairing uses a short-lived one-time code plus a non-exportable browser P-256 key:

1. Desktop Settings requests an eight-digit, five-minute code over `admin.sock`.
2. The sidecar stores only a keyed hash in memory.
3. The PWA creates a non-exportable ECDSA P-256 key in Web Crypto/IndexedDB and
   submits the code, a bounded device name, and DER-SPKI public key.
4. The sidecar consumes the code, stores the public key, and performs a signed
   challenge login.

Returning login signs a versioned payload containing the exact configured
origin, device id, single-use nonce, and expiry. The sidecar issues an in-memory
session cookie named `__Host-eldrun_session` with `Secure`, `HttpOnly`,
`SameSite=Strict`, and `Path=/`, expiring after at most 12 hours or host restart.
Revocation immediately removes that device's active cookies and terminal
connections. Losing browser site data requires pairing again.

The wire encodings are fixed rather than library-dependent: public keys are DER
SPKI and ECDSA signatures are 64-byte IEEE-P1363 `r || s`, both unpadded
base64url. Challenge nonces are single-use and expire after 60 seconds.

Pairing/authentication are globally rate-limited and bounded independently of
source IP because Serve may proxy through loopback. Code comparison is constant
time. Private keys never leave the device.

### 8.2 Browser boundary

- PWA and API are same-origin; no CORS allowlist is emitted.
- Pairing, auth, mutations, and WebSocket upgrades require the exact verified
  HTTPS `Origin`.
- Strict CSP, HSTS, `nosniff`, deny framing, and a restrictive permissions policy
  are emitted; no third-party scripts, fonts, analytics, or service-worker
  imports are allowed.
- Auth never appears in a URL or WebSocket query parameter.
- API/terminal responses are `Cache-Control: no-store`; the service worker caches
  versioned static assets and an offline shell only.
- JSON uses deny-unknown-fields schemas and bounded bodies; WebSocket frames,
  queues, connection counts, resize values, and timeouts are bounded.
- Tailscale identity headers may be recorded as non-authoritative audit context,
  but never replace Eldrun device authentication.

### 8.3 Minimal API

```text
GET    /healthz
POST   /api/v1/pair
POST   /api/v1/auth/challenge
POST   /api/v1/auth/session
DELETE /api/v1/auth/session

GET    /api/v1/status
GET    /api/v1/projects?view=active|search&q=...
GET    /api/v1/projects/:project_id
POST   /api/v1/projects/:project_id/tabs
GET    /api/v1/tabs/:tab_id
GET    /api/v1/tabs/:tab_id/terminal   (WebSocket upgrade)
```

`/healthz` returns only `{ "ok": true }`. Authenticated responses expose opaque
ids and bounded labels/states, never paths, tmux names, terminal content, argv,
environment, or raw project ids. The tab-creation route supports only the two
typed flows above.

The WebSocket subprotocol is `eldrun-terminal.v1`. Server binary frames are raw
PTY output; client binary frames are raw input. Text frames carry validated
`resize`, `ready`, `ping`, and `detached` controls. Backpressure closes the
mobile client with a retryable error and leaves tmux untouched.

Initial protocol limits are cols `20..=400`, rows `5..=200`, 64 KiB per input
frame, a 1 MiB output queue per connection, eight terminal sockets per device,
one mobile socket per tab, a 20-second ping, and a 60-second stale timeout.

## 9. Source/package changes

Expected implementation shape:

```text
mobile-web/
  src/{api,auth,App}.ts(x)
  src/screens/{Pair,Home,Project,Terminal}.tsx
  src/terminal/protocol.ts
  public/{manifest.webmanifest,icons/...}

vite.mobile.config.ts
tsconfig.mobile.json

src-tauri/src/
  bin/eldrun-mobile-host.rs
  services/mobile_control/
    {admin,auth,config,discovery,host,protocol,pty_bridge,store}.rs
  commands/mobile_control.rs

src/
  components/mobile/MobileBridgeHost.tsx
```

Use the root npm installation and lockfile. Add mobile build/test scripts and
embed immutable production assets in the sidecar; generated assets are not
committed. The Rust HTTP/WebSocket stack must use maintained crates, typed argv,
and the repository's existing Tokio runtime rather than a hand-built HTTP parser.

Package the host as a distinct binary. Enabling it copies the bundled binary to
`<state_dir>/mobile-control/bin/<version>/` before installing/restarting a Linux
user systemd service; a service must never point into an AppImage mount. macOS
uses a LaunchAgent only in its later delivery phase.

Add `scripts/install_phone.sh` as a read-only installation handoff. It verifies
that the sidecar is healthy and the configured Serve origin maps to its exact
loopback port, then prints the URL and a QR code (plus a machine-readable URL
mode). It does not enable Mobile access, alter Serve/Funnel configuration, create
a pairing, or bypass the browser's normal **Install app / Add to Home Screen**
flow.

Disabling the feature stops the sidecar and closes mobile clients without killing
tmux work. Eldrun must not claim that a user-owned Serve mapping was removed
unless the user explicitly chose and verified that action; a leftover mapping
may produce an unavailable backend but must expose no project metadata.

## 10. Delivery order and gates

1. **Contracts and threat tests:** trusted-state sources, schemas, opaque ids,
   eligibility, redaction, limits, and fixture round trips.
2. **Tmux prerequisite:** non-evicting multi-client attach, `window-size largest`,
   opted-in persistence for local resumable `kind: "agent"` tabs, and
   desktop/phone coexistence tests.
3. **Desktop bridge:** socket router, `MobileBridgeHost`, agent catalog, scoped
   hydration/create/persist action, idempotency, and offline-desktop errors.
4. **Loopback host and security:** embedded placeholder, exact loopback bind,
   pairing, authentication, revocation, origin/CSRF checks, rate limits, durable
   device store, and redacted audit.
5. **Discovery and terminal bridge:** trusted joins, fresh-snapshot resolution,
   attach/input/resize/detach/reconnect, concurrency and backpressure limits.
6. **PWA:** Pair, Active/Search, Project, creation, and Terminal screens; touch
   input, offline state, service-worker exclusions, and accessibility tests.
7. **Linux desktop/packaging:** Settings, opt-in UX, systemd, Serve inspection,
   install helper, update checks, then real phone QA.
8. **macOS:** LaunchAgent, signing/notarization/package work, and the same
   acceptance matrix. Native wrappers and non-local project scopes remain later
   proposals.

Every phase runs applicable repository gates (`npm run build`, tests, lint,
`cargo test`, clippy, and `git diff --check`) without launching Eldrun. Runtime
QA uses the user's existing instance under the single-instance rules.

## 11. MVP acceptance matrix

| Case | Expected result |
|---|---|
| Feature disabled | Sidecar/listener are stopped; stale Serve mapping, if user-owned, returns no metadata. Existing tmux work continues. |
| Home/Search | Only opted-in eligible projects appear; search matches display labels only and never reveals raw ids or paths. |
| Project view | Only exact live, persisted shell/resumable-agent tmux sessions appear; no viewer, `local_agent`, remote, container, VM, root, box, foreign, or legacy session leaks. |
| Desktop unavailable | Existing sessions remain discoverable/attachable; creation returns `desktop_unavailable` and queues/writes nothing. |
| New shell | Desktop activates/hydrates the project, creates one ordinary persistent shell at its canonical directory, and a retry returns the same tab. |
| New agent | Only a current installed/enabled resumable agent can start; optional mode exactly matches the desktop capability table; no prompt/argv/env comes from the phone. |
| Launch failure | One visible desktop error tab remains; idempotent retry does not create another. |
| Terminal coexistence | Desktop and phone receive output and send input without evicting each other; phone resize cannot shrink the desktop. |
| Detach/reconnect | Browser/network loss removes only the mobile tmux client; reconnect attaches to the same surviving session. |
| Project opt-out/revoke | Project or device access disappears immediately and its mobile sockets close; underlying tmux sessions continue. |
| Desktop deactivation | Existing Eldrun behavior remains authoritative: project sessions are explicitly stopped and mobile reports them gone. |
| Invalid request | Foreign/expired opaque ids, raw paths/commands, unknown agent ids/modes, and arbitrary tmux targets are rejected before process launch. |
| Offline/cache | The PWA shows unavailable and never displays cached project, tab, or terminal data. |
| Serve/Funnel | Host binds loopback only; verified Serve HTTPS works; Funnel/public/LAN paths are refused and existing Serve config is never silently overwritten. |
| Phone installation | Helper emits only the verified URL/QR; browser installation and Eldrun pairing remain separate explicit actions. |

## 12. Later phases, requiring a new review

- creation while the desktop is absent, which requires a daemon-owned or
  transactional shared tab-state model;
- remote primary/worker tabs, containers, and VMs, each with its own authority
  and connectivity rules;
- structured attention/approval state supplied by agents rather than terminal
  scraping;
- tab termination/rename/move or mode changes after creation;
- native wrappers, push notifications, multi-user hosts, or non-Tailscale
  publication.
