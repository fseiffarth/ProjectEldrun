# Eldrun Mobile — future directions plan

Status: **Proposed. Nothing in this document is implemented.**

This is the follow-up review that
[`eldrun_mobile_agent_plan.md`](eldrun_mobile_agent_plan.md) §12 requires
before any of its deferred phases begin. It specs six directions surfaced by
the 2026-08-26 code review of the mobile surface, ordered by value against the
product thesis: the phone exists to *steer agent turns*, not to mirror the
desktop. Every feature here keeps the base plan's boundaries — the sidecar
reads trusted state only, raw project ids/paths/commands/tmux targets never
cross the browser API, the desktop stays the sole writer of its own stores,
and everything is opt-in.

Last evaluated against the repository: **2026-08-26**.

Priority order and rationale:

| # | Feature | Why this rank |
|---|---------|---------------|
| A | Agent-turn push notifications | Closes the core loop: today the user must *poll* the phone to learn an agent is blocked on a question. |
| B | Dead-session relaunch | Completes the session-gone notice added 2026-08-26; one tap from "ended" back to a resumed agent. |
| C | PWA code-splitting | Small, standalone, pays for itself on every cold cellular load. |
| D | Read-only file browsing | "What did the agent just write" without opening a shell. |
| E | Mobile mail actions | Mark-read/flag through the desktop bridge. |
| F | Multi-host awareness | Honest display of worker-host tabs; attach stays out of scope. |

Each feature ships behind its own gate and none depends on another, except B
which assumes the session-gone probe already in `Terminal.tsx`.

---

## A. Agent-turn push notifications

### A.1 Goal

When an agent tab transitions to `question` (and optionally `done`), the
paired phone shows a system notification while the PWA is closed or
backgrounded. Tapping it opens the app, which unlocks and lands on that tab
via the existing `lastTab` restore path.

### A.2 What exists

- The desktop already classifies agent tabs as `working` / `question` /
  `done` (`AgentTabStatus` in `protocol.rs`, served through
  `DesktopRequest::Catalog`); classification never happens in the sidecar.
- The PWA registers a service worker (`mobile-web/public/sw.js`).
- The sidecar has a private control dir with an owner-only key
  (`mobile-control/host.key`) and a same-user admin socket.

### A.3 Honest transport statement

Web Push does **not** run over the tailnet. A push subscription always routes
through the browser vendor's push service (FCM for Chrome/Android, Apple for
iOS Safari ≥16.4, Mozilla autopush). That is a real departure from "private
Tailscale-only publication" and is why this needs its own opt-in, separate
from enabling Mobile at all. The mitigations that make it acceptable:

1. **Payloads are end-to-end encrypted** (RFC 8291, `aes128gcm`): the push
   service relays ciphertext it cannot read.
2. **Payload content is minimized by policy anyway**: the default payload is
   `{ kind: "agent", status: "question" }` plus the *opaque* tab id — no
   project label, no terminal text, ever. Including the project display label
   is a second per-device opt-in ("Show project names in notifications").
3. **VAPID keys are generated locally** and stored beside `host.key` with the
   same `0o600` posture; there is no third-party account.

If this trade is refused, there is no fallback: a closed PWA cannot poll, and
iOS terminates background WebSockets. The alternative is F below plus glancing
at the phone — i.e. the status quo.

### A.4 Design

**Subscription (phone → sidecar).** New authenticated, origin-checked routes:

- `POST /api/v1/push/subscription` — body: the `PushSubscription` JSON
  (endpoint URL, `p256dh`, `auth`), stored per *device id* in
  `mobile-control/push.json` (0600, atomic write, same schema-version pattern
  as `devices.json`). One subscription per device; a new POST replaces it.
- `DELETE /api/v1/push/subscription` — remove this device's subscription.
- `GET /api/v1/push/vapid` — the public VAPID key for `applicationServerKey`.

`AuthStore::revoke` and `forget_all` must delete the device's subscription in
the same call — a revoked phone keeps receiving pushes otherwise, and that is
exactly the lost-phone scenario revocation exists for.

**Event source (desktop → sidecar).** The desktop is the only component that
knows a status *transition* (the sidecar sees snapshots). The desktop bridge
(`MobileBridgeHost.tsx`) already derives per-tab status for
`DesktopRequest::Catalog`; it additionally watches for `working → question`
and `working → done` edges and calls a new same-user admin request:

```jsonc
{ "type": "notify", "tmux_session": "...", "status": "question" }
```

over `admin.sock` (peer-uid checked like every admin call). The sidecar maps
`tmux_session` to the opaque tab id through its own catalog — tmux names stay
on the trusted plane — and fans the encrypted payload out to every subscribed
device. Unknown session → drop silently.

**Delivery (sidecar → push service).** The sidecar performs the RFC
8291/8292 encryption and POSTs to the subscription endpoint. Endpoint origins
are restricted to an allowlist of the browser vendors' push hosts
(`*.push.apple.com`, `fcm.googleapis.com`, `*.push.services.mozilla.com`,
plus the endpoint captured at subscribe time) — a compromised renderer must
not turn the sidecar into a generic HTTP POST primitive. `410 Gone` from the
push service deletes the subscription.

**Rate limiting.** Per tab, at most one notification per status edge and at
most one per 30 seconds; a `question` fired while the phone holds that tab's
live WebSocket is suppressed (the user is already looking at it — the
`TerminalRegistry` knows).

**Client.** `sw.js` gains `push` and `notificationclick` handlers. On click:
`clients.openWindow("/")`; the app resumes through the normal lock →
challenge login → `restoreLastTab` flow, with the pushed tab id written into
the same `localStorage` slot `rememberLastTab` uses (the id is opaque and
server-revalidated, so this is safe by the same argument as `lastTab.ts`).

### A.5 Delivery and gates

1. Rust: `push.json` store + VAPID keygen + `web-push`-style crypto (evaluate
   `web-push` crate vs. hand-rolling on the existing `p256`/`hkdf`/chacha
   deps; **no new C dependency**), endpoint allowlist, admin `notify`.
2. Routes + revocation coupling + host tests (subscribe/replace/revoke/410).
3. Desktop edge detection + suppression-while-attached.
4. `sw.js` + settings UI (per-device toggle, project-label opt-in), i18n'd on
   the desktop side, `UntestedTag` until real-phone QA.

Acceptance: a `question` edge on a closed phone shows a notification within
seconds; revoking the device stops pushes immediately; the push service never
sees plaintext; disabling the opt-in deletes stored subscriptions.

Open question: iOS requires the PWA to be installed to Home Screen for push —
the pairing screen should say so.

---

## B. Dead-session relaunch

### B.1 Goal

The "This session has ended on the desktop." notice (added 2026-08-26 in
`Terminal.tsx`) gains one action: **Relaunch**, which asks the desktop to
resume the same agent (or respawn the same shell) and reattaches the phone to
the replacement tab.

### B.2 Design

**Not a new creation primitive.** `DesktopRequest::Create` already exists and
the desktop already owns resume (`isRestorableTab`/`RESUMABLE_AGENTS`,
`resolve_{claude,codex}_session`). Add one variant:

```jsonc
{ "type": "relaunch", "request_id": "...", "tab_id": "<opaque>", "idempotency_key": "..." }
```

The *sidecar* resolves the opaque tab id to `(project raw id, tmux name)`
through its catalog and forwards the raw pair to the desktop — the phone
never names a command, session id, or resume argv; it names a tab it was
already allowed to see. The desktop looks the tab up in its own layout state:

- agent tab with a `sessionId` → respawn through the same store action the
  desktop's own restore uses (resume args rebuilt from layout state, per the
  "never persist raw args" rule);
- shell tab → recreate via the existing `+ Shell` path in the same cwd;
- tab no longer in layout state → `tab_gone` error (the phone offers plain
  "New shell / New agent" instead, which already exists).

Response is `Created { tmux_session }`, and the sidecar reuses `create_tab`'s
existing 5-second `catalog_fresh` poll verbatim to hand back the new public
tab row. Idempotency mirrors `create`: the phone retains the key per dead tab
so a retried tap cannot spawn two resumes.

**Client.** The notice renders Relaunch only when `tab.kind`'s relaunch is
plausible and `desktop_available` was true at last load; on success it
replaces the current screen's `tab` (same `Terminal` component, new tab id —
the `tab.id` keyed effects tear down and reattach naturally) and updates
`rememberLastTab`.

### B.3 Boundaries kept

Trash-project and eligibility rules are enforced desktop-side exactly as in
`create` (`project_ineligible`, sandbox/vm/remote exclusions). A relaunched
Claude/Codex resumes; agents without a working resume path respawn fresh and
the notice says so ("Starts a new session — this agent cannot resume.").

Acceptance: kill a live agent's tmux session on the desktop → phone shows the
notice within ~2 reconnect attempts → Relaunch reattaches to a resumed
session; double-tap creates one tab; desktop-closed shows `desktop_unavailable`.

---

## C. PWA code-splitting

### C.1 Goal

First paint of the shell (pair/unlock/home) must not pay for xterm. The
mobile bundle crossed vite's 500 kB warning (501 kB / 139 kB gz, 2026-08-26);
xterm + fit addon are terminal-only and are the bulk of it.

### C.2 Design

- `React.lazy(() => import("./screens/Terminal"))` behind a `Suspense`
  fallback that reuses the splash style; same for the dev-only
  `terminalPreview` entry.
- Verify the split chunk lands under `/assets/` with a hashed name: the
  sidecar's `asset_response` and `sw.js` already treat hashed assets as
  immutable-cacheable and refuse the SPA fallback for `/assets/` misses, so a
  stale-chunk-after-upgrade turns into a clean 404 → the app reloads rather
  than executing HTML. Add exactly that test to the host suite: an `/assets/`
  miss for a split chunk name is a 404, never `index.html`.
- Pre-warm: `Home` fires the dynamic import on first render (idle), so the
  common tap-through to a terminal pays no visible load on good links while
  cold cellular still gets a fast shell.

Acceptance: shell JS ≤ ~60 kB gz; terminal opens with no visible regression
on a warm cache; a phone that upgraded mid-session recovers (no white screen)
when its old chunk is gone.

---

## D. Read-only file browsing

### D.1 Goal

Browse a mobile-enabled project's tree and read text files, bounded and
read-only — the "what did the agent just write" glance. Explicitly not a file
manager: no downloads, no writes, no images beyond a size-capped preview.

### D.2 The path-opacity problem

The mobile boundary's hardest rule is "raw paths never cross the browser
API", and HMAC ids (the `key_id` scheme) cannot name *arbitrary* paths
because they are not invertible. Two workable designs:

1. **Sealed path tokens**: encrypt the project-relative path with
   XChaCha20-Poly1305 under a key derived from `host.key`
   (`HKDF(host.key, "mobile-path")`), AAD = the project's raw id. Stateless,
   survives sidecar restarts, and a token minted for project A cannot be
   replayed against project B. Tokens are opaque to the phone but *not*
   secret from it — authorization still happens on every request.
2. Per-session server-side path tables — rejected: state that dies with the
   sidecar and grows per client.

Choose (1). On every request the sidecar decrypts, rejects absolute/`..`
segments, joins under the catalog's canonicalized `root`, re-canonicalizes,
and enforces `canonical_below` — the same symlink-escape check discovery
already applies to tab cwds. A path that escapes (symlink swapped after
listing) is a 404, and this check is **per request**, never cached.

### D.3 API

- `GET /api/v1/projects/{id}/files?dir=<token|omitted for root>` —
  entries: `{ token, name, kind: dir|file|other, size, mtime }`, name capped
  at 255 chars, listing capped at 500 entries + `truncated: true`, sorted
  dirs-first. Symlinks are listed as `other` and are not followable.
- `GET /api/v1/projects/{id}/files/content?file=<token>` — UTF-8 text only:
  read up to 256 KB, refuse (`binary_file`) if the prefix contains NUL or is
  invalid UTF-8; response `{ text, truncated }`. `Cache-Control: no-store`
  rides the existing `/api/` rule.

Both routes: authenticated, project must be in the catalog (which already
excludes remote/sandbox/VM projects), and gated by a **new per-project flag**
`eldrun_mobile_files` (default off) beside `eldrun_mobile_access` — shell
access and tree access are different grants; a paired phone that can nudge an
agent should not silently also read every secret file in the tree. The
desktop Settings row grows a second checkbox.

**Denylist, not intelligence:** `.git/`, `.env*`, and the project's
`.eldrun/` are skipped in listings. This is a courtesy filter against casual
shoulder-surfing, and the plan says so — the real boundary is the per-project
flag, because a phone with shell access can `cat` anything regardless.

### D.4 Client

A "Files" section on the Project screen: breadcrumb of dir tokens, tap-to-read
in the readable-output typography, monospace, with the existing Copy affordance.
No editing affordances at all.

Acceptance: paths never appear in any response body (host test greps like
`the_catalog_hands_the_phone_opaque_ids_and_no_paths`); a `..`/symlink probe
with a forged or replayed token 404s; a 1 GB file answers with the 256 KB
prefix and `truncated`; flag off → routes 404.

---

## E. Mobile mail actions

### E.1 Goal

Mark-read/unread and set/clear the star from the phone. Reply, move, delete
stay out of scope — the mobile mail contract's "no mutation" line moves, so
the move must be explicit and small.

### E.2 Design

The desktop remains the sole IMAP writer; the sidecar remains a forwarder.
One new bridge request:

```jsonc
{ "type": "mail_mark", "request_id": "...", "folder_id": "...", "message_id": "...",
  "action": "seen" | "unseen" | "flag" | "unflag" }
```

exposed as authenticated, origin-checked
`POST /api/v1/mail/folders/{folder_id}/messages/{message_id}/mark` with the
same `valid_mail_id` validation as the read routes. The desktop resolves the
opaque ids, applies the flag through `mail_engine`'s pooled session
(`set_flags_bulk` — one lease, no login storm), updates its local index, and
answers with the refreshed `MobileMailView::Folder` page so the phone's list
is correct without a second round trip.

**Gate:** one global setting `eldrun_mobile_mail_actions` (default **off**),
checked desktop-side in the bridge handler — the sidecar cannot read mail
settings and must not start to. When off, the request answers
`mail_actions_disabled` and the phone hides the buttons (capability is
reported in the existing `MailOverview` response as `actions: bool`).

Deliberately excluded, with reasons that should survive review: **delete**
(destructive from a pocketable device; the desktop has undo surfaces the
phone lacks), **priority marks** (`mail_priority_*` is machine-local state —
meaningful, but it invites confusion about what synced; revisit separately),
**reply/compose** (SMTP submission from a phone-triggered path is a different
threat model entirely).

Acceptance: mark-read on the phone shows read in the desktop client after its
next sync tick; gate off → no buttons and a refused request; the flag write
failing server-side surfaces the error string, never a silently stale list.

---

## F. Multi-host awareness

### F.1 Goal

Stop hiding worker-host tabs. Today `discovery.rs` matches local tmux only
(`live_tmux()` runs the local `tmux ls`) and `canonical_below` filters out
tabs whose cwd is a host path — a remote project's or worker's tab simply
does not exist on the phone, which reads as "nothing is running" when a
training run is very much running on the cluster.

### F.2 Scope decision

**Display only. Attach stays out.** Attaching would require the sidecar to
speak SSH; the pooled ControlMaster machinery is `services::remote`, lives in
the desktop process, and depends on keychain/VPN state the sidecar must never
hold. Any future attach goes desktop-mediated and needs its own review (base
plan §12's "remote primary/worker tabs" clause stands for the attach half).

### F.3 Design

- `SavedTab` in `discovery.rs` learns the persisted `location` field. Tabs
  with `location` of `host:<id>` (or a remote primary) are no longer silently
  dropped by the cwd filter; they resolve to a new public row shape:
  `{ id, label, kind, remote: true, host_label }`, with `available: false`
  and **no tmux name resolution at all** — they can never reach the
  WebSocket route by construction (the terminal route requires a catalog tab
  with a tmux name; these rows carry none).
- `host_label` is the *display* name from the project's `compute_hosts`
  entry, capped like every label; hostnames/user@host strings never cross
  (the privacy rule about institution hostnames applies to the phone surface
  doubly).
- Liveness: the sidecar cannot know whether a worker session is alive without
  SSH. If the desktop is up, the bridge `Catalog` response may add a
  best-effort `remote_alive` from the desktop's own lamps; absent desktop,
  the row renders "on <host> — state unknown". Never render fake liveness.
- Client: Project screen renders these rows disabled with "running on
  <host_label>" in place of "· live", so the phone's picture of the project
  matches the desktop's tab bar.

Acceptance: a project with two worker tabs shows them labeled and
unattachable; no host address or raw path appears in any response; the
existing local-tab behavior is byte-identical (host tests unchanged).

---

## Cross-cutting rules

Every feature above inherits, without exception:

- routes authenticated via the `__Host-` cookie and origin-checked on every
  mutation; new POST routes join the host-test tables
  (`AUTHENTICATED_GETS`-style) in the same commit that adds them;
- all new identifiers minted through `key_id`/sealed tokens — the tripwire
  tests that grep responses for raw ids and paths extend to every new route;
- desktop-owned stores are written only by the desktop; the sidecar never
  becomes a second writer of mail, calendar, layout, or push-worthy status;
- every new surface lands with the `UntestedTag` pill and keeps it until
  live-verified on a real phone, per the repo's Done ≠ Tested rule;
- new user-facing desktop strings go through `src/lib/i18n.ts`; the PWA keeps
  its existing English-only convention until the PWA grows i18n as a whole.

## Suggested delivery order

C (small, standalone) → B (completes an existing UX edge) → A (highest value,
largest review surface — the push-service trade needs the user's explicit
sign-off before implementation) → D → E → F. Each phase is independently
shippable and independently refusable.
