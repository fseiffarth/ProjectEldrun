# Eldrun Mobile ↔ Desktop — Link Hardening Plan

Status: **plan only, 2026-09-24. Nothing here is built.** Source: a three-way
read-only review of the phone PWA (`mobile-web/`), the sidecar
(`src-tauri/src/services/mobile_control/`) and the desktop bridge
(`src/components/mobile/MobileBridgeHost.tsx`) from three angles — trust
boundary, runtime robustness, feature parity/UX — followed by a discussion
round in which each reviewer re-checked the others' claims against code.
Line numbers are as read that day; verify before editing. Nothing was run
live; the mobile vitest suite (87 files / 648 tests) passed.

## Why

The phone is a remote for the desktop. The review found that its worst
failures are all of the shape "the remote lied or vanished": a prompt shown
as sent that never reached the PTY, a PIN screen on every sidecar restart, a
raw proxy 502 page when the desktop is closed, raw error codes on screen, and
a chat view the phone never enters for tabs it created itself. Behind those
sit two security items (a private calendar URL on the wire; a session
lifecycle whose lock is skipped on restore) and a set of sidecar link-layer
gaps (no idle timeout, single-frame history replay, flood closes the
session). Parity gaps (boxes, i18n, theme) matter less than any of these and
are listed at the end so they are not lost.

## Decisions

Taken during the discussion round; each one resolves a disagreement or fixes
a direction so the steps below do not re-open it.

1. **Sessions never touch disk.** A sidecar restart stays the one event that
   invalidates every session. The "restart locks the phone" pain is fixed on
   the phone (silent device-key re-login) plus a sliding server TTL, not by
   persisting bearer tokens under `<state_dir>/mobile-control/`.
2. **Cold start always asks for the PIN/biometric.** The sessionStorage
   `hasUnlockedSession()` shortcut goes. The idle lock keeps sending
   `DELETE /auth/session`. An OS-killed app cannot send anything, so the
   sliding TTL is what closes that hole — not a `pagehide` beacon, which
   would log out on every app switch.
3. **Codes on the wire, prose on the phone.** Sidecar and bridge emit fixed
   error codes only (that includes agent-CLI stderr, which today crosses
   verbatim with paths in it). The phone has one description function, and
   nothing renders `String(error)`.
4. **A shown bubble never changes or moves.** A lost prompt gets a failed
   marker and a resend affordance on the existing bubble; it is never
   removed or re-ordered.
5. **tmux prefix on Eldrun sessions is set to none** at session creation
   (both clients already run `status off`). It is cheap, loses nobody a key
   they use, and closes the "phone holder escapes the root review gate"
   argument. It is additionally written into `docs/context/root_console.md`
   as the reason the phone's raw-terminal input is trusted as the user.
6. **Mail attachments never go through the outbox.** The outbox is inside a
   project folder; filing third-party mail content there breaks the
   "nothing auto-files into a project" rule. If attachments are ever
   downloadable on the phone they are served from the mail store with
   `outbox::classify` reused for typing.
7. **A box member on the wire is an opaque member id**, validated against
   the catalog's `roots`, never a path. This is the first tab-creation field
   that selects a directory and must not become the first path the phone
   writes.
8. **Phone language and theme are a product decision, not a bug.** Until
   decided, no new `mobile.*` dictionary rows are added; existing ones stay.
   The one error-description file from decision 3 is the single place a
   later translation would land.

## Steps

Ordered by user pain. Steps 1–5 are the ones the three reviewers agreed on
as the top list; 6–9 are agreed secondary items; 10 is housekeeping.

### 1. Prompts on a half-open link are acked or marked failed

Today `write.current` (`mobile-web/src/screens/Terminal.tsx` ~963) checks
only `readyState === OPEN`; `submitDraft` (~1557) then clears the draft,
adds the pending bubble and reports the prompt to the desktop. For up to
`PONG_GRACE` (45 s) after a cellular/NAT drop the bytes sit in the browser
buffer and are lost when the socket dies; the bubble stays forever.

- `src-tauri/src/services/mobile_control/pty_bridge.rs`: give every phone
  input frame a sequence number; after the bytes are written to the tmux
  client PTY, send a small `ack{seq}` text frame on the same sink (ordered
  after any output already queued). The input loop at ~457 already inspects
  each frame, so this is the natural spot.
- `Terminal.tsx`: keep a map of unacked sequences with a short deadline
  (a few seconds, longer than one RTT, shorter than `PONG_GRACE`). On
  deadline, on `close`, or on a `replay` frame with unacked entries, mark
  the matching pending bubble failed (`data-send-failed` or similar) and
  show a resend control; resend writes the same text as a new sequence and
  clears the marker on ack. The bubble stays in place (decision 4).
- Also check `bufferedAmount` before enabling the composer's send; a large
  value is a cheap early sign of a stalled link.
- Test: extend the Terminal tests under `src/__tests__/mobile/` with a mock
  socket that accepts a write and never acks; assert the bubble persists,
  gains the failed marker, and resend produces a second frame with a new
  sequence. Rust unit test in `pty_bridge.rs` for the ack ordering.

### 2. Session lifecycle as one state machine

Three findings, one design (decisions 1 and 2).

- `src-tauri/src/services/mobile_control/auth.rs`: replace the fixed
  12 h `SESSION_TTL` (~35) with a sliding TTL of about 15 min that every
  authenticated HTTP request and every WebSocket frame extends. Keep the
  absolute cap if one is wanted (12 h is fine).
- `mobile-web/src/App.tsx`: on a 401 while `paired` and
  `Date.now() - lastActive < LOCK_AFTER_IDLE_MS`, run `resumeAuth()` once
  (device-key challenge, no PIN) and retry the failed request; only if that
  fails go to `reset()` + `locked` (~191). Bail to `unpaired` on
  `unknown_device` / `invalid_signature` so a revoked device cannot loop.
- `App.tsx` ~168: drop the `locked && hasUnlockedSession()` → `resume()`
  shortcut. Cold start always shows the lock screen; `restoreLastPlace`
  still returns the reader to their tab afterwards. Fix the splash comment
  at ~74 to match.
- `pty_bridge.rs` ~432: split `access_revoked` into `access_revoked`
  (retry:false) and `session_expired` (retry:true after re-login);
  `Terminal.tsx` reconnects through the re-login path for the latter.
- The Funnel guard that exits the sidecar when `tailscale serve status`
  fails (`host.rs` ~2845) stays exactly as is; this step makes the restart
  invisible instead of preventing it.
- Test: auth.rs unit tests for sliding extension and cap; App tests for
  401-while-active → silent resume → original request retried; a
  cold-start test asserting the lock screen renders even with the old
  sessionStorage flag present.

### 3. Cold open with the desktop closed shows the app's own splash

`mobile-web/public/sw.js` ~58–83: `network()` returns whatever the proxy
answers; only a rejection or the 3 s timeout reaches `cached()`. With the
desktop closed, Tailscale Serve answers 502 and the phone renders the
proxy's error page.

- In the navigation branch, treat a non-OK response (or non-HTML content
  type) as a miss and serve the cached shell. Never cache the non-OK body
  (the SW already skips `/api/` and never stores non-OK, keep that).
- The loaded shell then shows the existing "Eldrun Mobile isn't running on
  your desktop" copy from `mobile-web/src/connection.ts`.
- Test: `src/__tests__/mobile/` SW tests with a fetch stub returning 502
  for `/`; assert the cached shell is served and nothing is written to the
  cache.

### 4. One error vocabulary

Four findings with one root. Rendered raw today: `String(reason)` at
`Project.tsx` ~277/340, `Mail.tsx` ~87/97, `Calendar.tsx` ~35/37,
`LocalUnlock.tsx` ~31/72/90; `usage.error` / `usage.raw` in
`StatusSheet.tsx` ~135–170; the Terminal reconnect probe (~1058) only
knows 404/410; expiry reads as "withdrawn" (step 2 covers that reason).

- Sidecar side: `src-tauri/src/services/agent_usage.rs` ~145–174 forwards
  CLI stderr (`complaint = strip_ansi(stderr)`) into
  `MobileAgentUsage.error` / `raw`. Map to fixed codes; keep `raw` only
  when the panel parsed successfully and it contains no path.
- Phone side: extend `connection.ts` into `describeFailure(source)` that
  accepts an `ApiError`, a WS `closing` reason, or a probe result. Move
  `CLOSE_REASONS` into it; add `desktop_unavailable`, `launch_pending`,
  `catalog_unavailable`, `request_failed`, `session_expired`, and the
  502-class → the existing host-down / desktop-down copy. Every `setError`
  and the Terminal probe call it. Grep `String(` and `.message` in
  `mobile-web/src` to find the rest.
- `Terminal.tsx` ~1051: write the "[Connection interrupted; reconnecting…]"
  line once per outage, not once per attempt.
- Test: a table test over `describeFailure` for every code; assert no
  screen renders a bare code by grepping test output for `Error:`.

### 5. Focus view re-enters for phone-created tabs

`MobileBridgeHost.tsx` ~1728 answers `no_session` for any tab without a
`sessionId`, which is every tab the phone just created; `Terminal.tsx`
~1288 then calls `setView("terminal")` directly (not `chooseView`), so
`viewChosen` stays false and nothing ever returns to Focus.

- `Terminal.tsx`: fall back to the terminal view only for a terminal
  reason (`unsupported`); for `no_session` / `read_failed` stay in Focus
  with the existing empty state, and when `transcript.available` flips to
  true while `viewChosen` is false, (re)enter Focus.
- `MobileBridgeHost.tsx`: distinguish `no_session_yet` (tab exists, session
  not hydrated) from `unsupported` so the phone can tell them apart.
- Test: Focus test where the first transcript answer is `no_session` and
  the second is available; assert the reader lands in Focus without a tap.

### 6. Stop leaking the calendar feed URL; replace `window.prompt`

- `MobileBridgeHost.tsx` ~1299 sends `source_url` (up to 2000 chars) for
  every calendar; the phone uses it only as truthiness at
  `mobile-web/src/screens/Calendar.tsx` ~78. Replace with
  `subscribed: bool` in `protocol.rs` (~331), `api.ts` (~174), and the
  bridge. Feed URLs routinely embed a private token.
- Same `Calendar.tsx` line manages name/colour via two `window.prompt`
  calls and deletes via `window.confirm`. Reuse the existing `RenameSheet`
  and `ColorSheet` (already used for tabs) and the shared option sheet for
  the destructive confirm. While there, consider a `calendar_writes` /
  `todo_writes` desktop switch beside the mail ones in
  `src-tauri/src/schema/settings.rs` ~47–62, since today the only guard on
  a CalDAV delete from the phone is `window.confirm`.
- Test: protocol round-trip test that `source_url` is gone; Calendar test
  that rename opens the sheet.

### 7. Sidecar link hygiene

Three findings at two layers, one pass.

- `src-tauri/src/services/mobile_control/limits.rs` ~121–125: the guarded
  stream clears its deadline after the first byte written and nothing else
  has an idle timeout, so 256 held sockets (from any tailnet node, or any
  local process since the fence shares the network namespace) block the
  phone. Re-arm the deadline on every read/write with an idle of about
  5 min. This also makes the PTY bridge's own 180 s reaper redundant.
- `pty_bridge.rs` ~408: history replay (`capture-pane -e -J -S -10000`) is
  one Binary frame under a 15 s `WRITE_TIMEOUT`; on a slow link it times
  out, returns without a `closing` frame, and the phone loops the same
  replay. Chunk into ≤64 KB frames, each with its own deadline, and keep
  the `replay` marker semantics (`term.reset()` on the first chunk only).
- `pty_bridge.rs` ~347–363: on `try_send` failure the reader thread breaks
  and the loop closes with 1013; the phone reconnects and replays the
  flood. Shed instead: drop the oldest queued chunks (or coalesce) and keep
  the link; if a close is unavoidable send `closing{retry:true, reason}`
  first.
- Test: limits.rs test that an idle connection is closed after the idle
  window; pty_bridge tests for chunk boundaries and for shedding under a
  full channel.

### 8. Home list recovers on its own

`mobile-web/src/screens/Home.tsx` ~167–184 loads the project list once per
`[view, query]`; only alerts poll. After step 2 a user re-unlocks onto a
dead list with no retry. Re-run the load on `visibilitychange`, `pageshow`
and `online`, plus a slow interval while the last load failed, following
what `Project.tsx` ~189–204 already does. Test: Home test that a failed
load followed by a `visibilitychange` re-fetches.

### 9. Bridge mutation queue per domain

`MobileBridgeHost.tsx` ~1830 serialises every desktop mutation on one
promise chain while `handle_desktop_stream`
(`src-tauri/src/commands/mobile_control.rs` ~1243) starts its 8 s deadline
at emit. A slow `mail_reply` (60 s budget) ahead of a tab create makes the
phone say "Desktop unavailable" and then the tab appears anyway. Split the
chain into per-domain queues (tabs / board+calendar / mail / schedules), or
start the sidecar deadline when the bridge dequeues and let it answer
`queued` meanwhile. Test: bridge test with a slow mail handler and a
concurrent create; assert create resolves inside its budget.

### 10. Housekeeping (small, do alongside)

- `AGENTS.md` and the `mobile_control/` row in `docs/filemap_backend.md`
  still say "tab labels are the only tab state the phone writes"; the phone
  now writes colour, order, close, create, schedules, prompts. Reword to
  "the phone never writes paths, raw ids, commands or tmux targets".
- `docs/context/root_console.md`: state the tmux-prefix decision (5).
- `mobile-web/src/screens/Todo.tsx` ~174 renders a permanent `Untested`
  pill with no register row; add a `mobile.todo.fold` row in
  `src/lib/untested.ts` and gate it. `Home.tsx` ~251 / `Project.tsx` ~392
  hardcode "Untested" where `NewTabSheet` uses the dictionary key.
- `todo/group-h-crossplatform.md` reuses the ids 31x, 31ab, 31s, 31t, 31u
  for two items each; renumber the later of each pair so the register and
  the memory notes stop being ambiguous.

## Deferred (parity, not link)

Listed so they are not lost; each is a product decision or a separate plan.

- Box parity (member label on tabs, member-root create): already planned in
  `docs/mobile_box_parity_plan.md` (31av / 31aw); decision 7 applies.
- Phone UI language: nothing in `mobile-web/` ever sets the language, so
  the PWA is English-only in practice and roughly half its screens
  hardcode English regardless. Decide English-only (and stop adding
  `mobile.*` rows) or publish the desktop language via `/api/v1/status`
  and sweep. Decision 8.
- Dark-only phone; desktop theme presets never reach it. Decision 8.
- Antigravity has no working-row shape in `mobile-web/src/terminal/agentBusy.ts`
  (the only family without one) unless it prints the generic
  `esc to interrupt`; capture a busy frame with the parser harness first.
- Slash-command catalogue covers 6 of 10 families (`slashCommands.ts`
  ~82–158); kimi, copilot, cursor, antigravity fall back to history.
- Mail attachments are listed but inert (`Mail.tsx` ~177); either drop the
  rows or serve per decision 6.
- Phone adopting the tmux window geometry may pin the desktop pane at the
  phone's size under `window-size largest` (`pty_bridge.rs` ~178,
  `tmux_local.rs` ~243); needs a live check before any change.
- Synchronous `tmux ls` under the catalog mutex on every handler
  (`host.rs` ~169, `discovery.rs` ~475); move to `spawn_blocking` if a
  wedged tmux server is ever observed stalling the sidecar.
- Blast-radius notes for a paired phone, accepted for now: inbox storage
  (24 MiB/file, 1 GiB per inbox, no per-session rate), inline PDF from
  project-supplied outbox files on the app origin, no `Tailscale-User-Login`
  check on pair/login (the 8-digit code is the barrier; one global pair
  bucket can be kept exhausted by any tailnet peer).

## Verification

- Gates: `npm run build`, `npm test`, `cargo test --manifest-path
  src-tauri/Cargo.toml`, `npm run lint`, `cargo clippy … -D warnings`; then
  `npm run mobile:bundle` and `npm run backend:stale` (the sidecar and the
  bridge both change; a running window will not have them).
- Live, on the phone, after a dev build (not run by an agent):
  1. Open the PWA with the desktop closed: the app's own splash, not a 502.
  2. Type a prompt, drop the phone to airplane mode within a second, wait
     a minute, reconnect: the bubble stays, shows failed, resend delivers
     once.
  3. `systemctl --user restart` the mobile host while reading a tab: no
     PIN screen, the terminal reconnects.
  4. Kill the PWA from the app switcher and reopen: PIN screen every time.
  5. Create an agent tab from the phone: it opens in Focus.
  6. Trigger `desktop_unavailable` (quit the desktop with the sidecar up):
     prose, never `Error: desktop_unavailable`.
  7. Calendar rename opens the sheet; `subscribed` still shows for feeds.
- Each shipped step gets an `UntestedTag` row in `src/lib/untested.ts`
  and a 🖐️ box in `todo/group-h-crossplatform.md` with the four platform
  pairs, per `AGENTS.md`.

## What the review found sound

Pairing (P-256 challenge bound to origin+device+nonce, `__Host-` cookie,
per-device rate buckets), HMAC-opaque ids resolved only server-side,
exact-origin checks on every mutating route and the WebSocket, inbox/outbox
path handling (`create_new`, canonicalize-below-root, `O_NOFOLLOW`,
byte-sniffed types), the service worker's cache scoping, viewer handover in
`TerminalRegistry`, replay ordering, and teardown at `RunEvent::Exit`. The
uncommitted project-inbox work (31bb) is complete on every checklist item.
