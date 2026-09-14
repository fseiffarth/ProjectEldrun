# `eldrun-send` — a file from the agent's terminal to the phone

Status: **implemented; live QA pending** (todo #31ad). Written against the repository
on **2026-09-14**. When it is built, the QA item goes into
`todo/group-h-crossplatform.md` as the next free `31…` suffix.

## 1. The round trip this exists for

The phone is paired and Eldrun Mobile is open in **Focus** mode on a Claude
tab. The user types

> render the loss curve of run 12 and show me the image

and sends. That prompt travels phone → sidecar → tmux → the Claude tab on the
desktop, exactly as today. Claude renders the plot to a PNG in the project and
then runs one command:

```
eldrun-send plots/run12-loss.png
```

The file lands in the project's `.eldrun/outbox/`. The Focus view polls that
folder every 8 s while the page is visible (`mobile-web/src/screens/
Terminal.tsx`, `OUTBOX_POLL`), so within about eight seconds a **From the
agent** strip appears above the composer with the thumbnail; one tap opens it
full screen. The same works for a log (`cargo test 2>&1 | eldrun-send -n
tests.log`), a PDF, a CSV: the phone shows what a browser can show and offers
the rest as a download or a share.

**The one condition** is that the agent knows the command exists. It learns it
from the project's `AGENTS.md` (the scaffold paragraph, imported by `CLAUDE.md`
and `GEMINI.md`), and — for Claude — from the SessionStart hook Eldrun already
installs, whose stdout becomes session context (§3.7). If an agent still does
not do it on its own, "…and eldrun-send it" in the prompt is enough. Nothing is
ever sent without the agent naming the file: the mobile plan's rule that
*nothing is copied on the agent's behalf* (`docs/eldrun_mobile_agent_plan.md`
§4.3) stands; this is that deliberate act made discoverable, correct, and
type-agnostic.

## 2. What exists, and what is missing

Built (todo #31x, 2026-09-05, never seen on a phone):
`services::mobile_control::outbox` lists `<project>/.eldrun/outbox/` and
serves one file by leaf name (`GET /api/v1/tabs/{id}/outbox[/{name}]`,
`host.rs`), read off disk by the sidecar itself so it answers with the desktop
closed; the PWA shows a thumbnail strip and a full-screen viewer; the scaffold
`AGENTS.md` tells agents to copy pictures into the folder.

What stops the round trip in §1 from being reliable:

- **Images only.** `outbox::sniff` accepts PNG/JPEG/GIF/WebP by magic bytes
  and nothing else (an SVG can carry script). A log, a PDF, a CSV is simply
  not listed.
- **The agent has to find its project root.** No environment variable names
  it: a tab inherits only `ELDRUN_TAB_UID`/`ELDRUN_TAB_AGENT`
  (`services::agent_session`), and only when it is an agent tab. From a
  subdirectory, or a box-scoped tab in a member root, "copy it into
  `.eldrun/outbox/`" is a guess about where that folder is.
- **It is a convention, not a command.** Each agent improvises `cp`; none
  reports what the phone will do with the file, none refuses a 200 MB dump,
  none stamps names so a second plot does not overwrite the first.
- **No affordance for a non-image on the phone.** `mobile-web/` has no
  download link, no share, no text viewer anywhere (mail attachments are
  metadata only).

What the design has to respect (all verified in code on 2026-09-14):

- Inside the default bubblewrap fence (`services::agent_fence::bwrap_args`)
  `$HOME` is a tmpfs, so `<state_dir>/mobile-control/*.sock` is invisible and
  the Eldrun binary (an AppImage under `/tmp/.mount_*` or `$HOME`) is not
  reachable. Loopback networking is open, but a project container has its
  *own* loopback (`services::sandbox`, bridge network, `host` refused), so
  the sidecar's port is unreachable there. **The project root is read-write
  in every runtime** — bound last in the fence, mounted at its identical
  path in the container — and `.eldrun/` is already git-ignored by the
  scaffold (`GITIGNORE_DEFAULT`), hidden from the tree, and skipped by sync.
  The folder is the one channel all runtimes share.
- The precedent for an Eldrun-written script an agent process runs is the
  SessionStart hook: written on every launch into `<state_dir>/hooks/` at
  0755 (`agent_session::write_hook_script`), ro-mounted into the fence
  (`agent_fence::agent_state_mounts`) and the container
  (`sandbox::ro_mounts_for_hooks`).
- `~/.local/bin` is prepended to every PTY's PATH (`paths::extra_path_dirs`)
  and is in the fence's default read allowlist — but it is the user's
  directory, and it is not mounted into containers. An Eldrun-owned
  `<state_dir>/bin`, on PATH and mounted like `hooks/`, is the clean form.
- Environment variables Eldrun puts in `opts.env` ride into every wrap for
  free: `ssh_exec::remote_command` exports every valid key, `docker exec`
  gets one `-e` per pair, `tmux_local` sets them on the session.
- Nothing pushes to the phone; `sw.js` is cache-only and the terminal
  WebSocket's server→client vocabulary is closed. Polling stays; push is
  `docs/eldrun_mobile_future_plan.md` §A.

## 3. Decisions

1. **One command, `eldrun-send`, as a self-contained POSIX `sh` script.** No
   dependency on the Eldrun binary (unreachable in the fence, absent in a
   container). Source in the repo at `scripts/eldrun-send.sh`, embedded with
   `include_str!` like `scripts/install_phone.sh`, written on every launch to
   `<state_dir>/bin/eldrun-send` (0755, rewritten only when the bytes
   differ). Windows gets `eldrun-send.cmd` + `eldrun-send.ps1` twins with the
   same contract (unfenced there, PATH suffices; CI-only).
2. **`ELDRUN_PROJECT_DIR`** is injected by `commands::terminal::pty_spawn`
   into every tab that has a scope, at the point where the cwd-containment
   check already resolves the root: the project directory; the mirror for a
   `local_only` tab of a remote project; the box folder for a `box:<id>`
   scope; the `remote_path` for a remote tab. The script reads it first and
   falls back to `git rev-parse --show-toplevel`; with neither it refuses
   with one sentence. A box-scoped tab's outbox is the *box folder's*, which
   is what the phone lists under that scope.
3. **The script writes into `<root>/.eldrun/outbox/`** — no new folder, no
   new authority (it can only write where the agent already can). Stamped
   leaf names (`YYYYMMDD-HHMMSS-<safe name>`, the inbox's scheme), never
   overwrite (private staging + atomic hard-link publication, `-N` retry), 24 MiB per file and 1 GiB per outbox
   (the inbox's bounds), refuses directories and empty files, and warns once
   when `git check-ignore` says `.eldrun/` is *not* ignored — the
   public-remote leak this repository's rules exist for.
4. **The sidecar serves files, typed by their bytes into a closed set**:
   `image/png|jpeg|gif|webp`, `application/pdf`, `text/plain;
   charset=utf-8` (a valid UTF-8 head with no NUL — so SVG, HTML and JS
   bytes are served as inert text, never as an active type), and
   `application/octet-stream` with `Content-Disposition: attachment` for
   everything else. `nosniff` is already on every response; the folder must
   still canonicalize below the root, symlinks inside it are still never
   followed, names are still leaves from the safe alphabet, and every
   refusal stays one code (`file_not_found`, renamed from `image_not_found`
   — the PWA is baked into the same binary, so the rename costs nothing).
5. **The phone shows what it can and saves the rest.** Images stay
   thumbnails + full screen. Text opens in an in-page sheet. A PDF opens as
   a top-level same-origin navigation in a new tab (never framed —
   `X-Frame-Options: DENY` stays). Anything else is a download link
   (`?download=1` forces `attachment`). A **Share…** button on the open item
   hands the bytes to another app through `navigator.share({ files })`
   where the browser has it (Android Chrome does; feature-detected).
6. **Remote SSH tabs are deferred.** Eldrun installs nothing on a host, and
   the sidecar cannot see a host's `.eldrun/outbox/`. The env var still
   crosses, so a later phase can add a `DesktopRequest` that pulls the
   host's outbox over the pooled SFTP into a local cache and lists that.
   The scaffold text says "local and container tabs" until then.
7. **The hint reaches Claude through the SessionStart hook.** Claude Code
   adds a SessionStart hook's stdout to the session's context. Eldrun's
   `eldrun_session_start.sh` prints nothing today; it will print one line —
   *"To put a file in front of the user on their phone, run `eldrun-send
   <file>`."* — only when `ELDRUN_PROJECT_DIR` is set and
   `ELDRUN_TAB_AGENT` is `claude`, so it never fires for a nested `claude -p`
   or an unrelated CLI. Codex and Gemini rely on `AGENTS.md`. Verify the
   stdout-as-context behaviour against the installed Claude Code release
   first and record it in `docs/third_party_update_checklist.md`; if it has
   changed, the `AGENTS.md` paragraph alone carries it.

## 4. Files

### Backend (`src-tauri/`) — a restart applies it; run `npm run backend:stale`

- **`scripts/eldrun-send.sh`** (new, ~120 lines POSIX sh):
  ```
  eldrun-send FILE...            copy files to the phone
  cmd | eldrun-send -n NAME      send stdin under NAME
  eldrun-send --clear            empty this project's outbox
  eldrun-send --help
  ```
  Per file: resolve the root (`$ELDRUN_PROJECT_DIR` → git toplevel → refuse,
  exit 3); refuse a directory, an empty file, >24 MiB (exit 4) and a full
  outbox (exit 5); build the safe leaf (outbox alphabet `[A-Za-z0-9._-]`,
  leading dots stripped, stem cut to keep the extension, max 80 like
  `inbox::safe_name`); `mkdir -p .eldrun/outbox`; bounded private staging + atomic hard-link publication with `-N`
  retry; sniff the first 12 bytes with `od`
  (PNG/JPEG/GIF/WebP/PDF) or test printability, only to word the report:
  `→ phone: 20260914-101502-tests.log (12 KB) — shown as text`. Print the
  git-ignore warning once per run. Nothing else — the sidecar re-validates
  on every read.
- **`scripts/eldrun-send.ps1` + `.cmd`** (new): Windows twins, same
  contract, size check only.
- **`src-tauri/src/services/agent_bin.rs`** (new): `bin_dir()` =
  `<state_dir>/bin`; `install()` writes the script(s) when the content
  differs, 0755 on unix, `create_dir_all` first. Called from `lib.rs`
  beside `install_session_start_hook()`. Tests: writes once, rewrites on
  drift, mode bits.
- **`src-tauri/src/paths.rs`** `extra_path_dirs()`: push `agent_bin::bin_dir()`
  first; `supplemental_path_dirs_for` stays pure.
- **`src-tauri/src/commands/terminal.rs`** `pty_spawn`: a pure
  `scope_root_for(project_id, local_only)` beside `cwd_within`, unit-tested
  for the four cases, and `opts.env.entry("ELDRUN_PROJECT_DIR").or_insert(…)`.
  On a Windows host the docker wrap re-spells that one value with
  `container_path`.
- **`src-tauri/src/services/agent_fence.rs`** `agent_state_mounts`: ro-bind
  `<state_dir>/bin` beside the hooks mount (`create_dir_all` first, as for
  `live_own`). macOS: the same directory in the Seatbelt allow-read inputs.
- **`src-tauri/src/services/sandbox.rs`**: `ro_mounts.push("<bin>:<bin>")`
  beside `ro_mounts_for_hooks`, and `PATH=<bin>:$PATH;` prefixed to the
  exec's `sh -c` string.
- **`src-tauri/src/services/agent_session.rs`** `posix_hook_script_body`
  (+ the PowerShell twin): the one-line hint on SessionStart, gated as in
  §3.7.
- **`src-tauri/src/services/mobile_control/outbox.rs`**: `OutboxImage` →
  `OutboxFile`; `MAX_OUTBOX_IMAGE` → `MAX_OUTBOX_FILE`; `sniff` grows PDF;
  new `classify(head) -> &'static str` (image / pdf / text / octet-stream;
  the head read grows to 4 KiB for the UTF-8 test, a cut multibyte tail
  tolerated); `probe` no longer drops a regular bounded file for its type;
  `NotFound.code()` → `"file_not_found"`. Tests extended: PDF typed, HTML
  and SVG typed as text, binary typed octet-stream; the image, symlink and
  cap cases unchanged.
- **`src-tauri/src/services/mobile_control/host.rs`** `outbox_image` →
  `outbox_file`: `Content-Disposition: inline` for image/pdf/text,
  `attachment; filename="<leaf>"` for octet-stream or `?download=1`. The
  route test updated for the new code and both dispositions; the §8.4 API
  list in the mobile plan gains the inbox/outbox routes it never listed.
- **`src-tauri/src/commands/projects.rs`** `AGENTS_SCAFFOLD`: the
  "Showing the user a picture" paragraph becomes
  > ## Showing the user a file
  > To put a file in front of the user on their phone (Eldrun Mobile), run
  > `eldrun-send <file>` — any file up to 24 MiB; images, PDFs and text show
  > on the phone, anything else is offered as a download. Local and container
  > tabs. Copying into `.eldrun/outbox/` by hand still works for images.

### Phone (`mobile-web/`) — baked into the binary; `npm run mobile:bundle`

- **`mobile-web/src/api.ts`**: `OutboxFile { name, kind, size, modified }`,
  `listOutbox`, `outboxFileUrl(tabId, name, download?)`.
- **`mobile-web/src/screens/Terminal.tsx`**: images unchanged; a non-image
  renders an `.outbox-file` chip (kind glyph, name, size, age). Tap by kind:
  text → `OutboxTextSheet` (same-origin fetch into a `<pre>`, 1 MiB inline
  cap with an "Open the whole file" link); pdf → `window.open(url, "_blank",
  "noopener")`; other → `<a download>` to `?download=1`. **Share…** on the
  open item when `navigator.canShare?.({ files })`. Head text "N files in the
  project's outbox"; the `Untested` badge stays until the phone QA passes.
- **`mobile-web/src/style.css`**: `.outbox-file`, `.outbox-text-sheet` on the
  existing sheet tokens.
- **`src/__tests__/MobileTerminalOutbox.test.tsx`**: a text chip opens the
  sheet with the fetched body; a PDF entry opens a new tab; an octet-stream
  entry is a download link carrying `?download=1`; the image cases unchanged.

### Docs

`AGENTS.md` (the outbox bullet), `README.md` (the "drops into the project's
outbox" sentence), `src-tauri/CLAUDE.md` (the outbox paragraph, a row for
`agent_bin.rs`), `docs/context/agent_authority.md` (the `<state_dir>/bin`
ro-mount), `docs/context/agent_sessions.md` (the hook now speaks),
`docs/eldrun_mobile_agent_plan.md` (§3's "the one thing the phone may *see*"
sentence, §4.3, §8.4), `docs/eldrun_mobile_future_plan.md` §D (one
cross-reference: downloads exist, but only from the outbox),
`docs/third_party_update_checklist.md` (Claude Code: SessionStart stdout is
context), `todo/group-h-crossplatform.md` (new `[~]` item with §6's manual
test).

## 5. Phases

1. Backend plumbing: script + `agent_bin.rs` + PATH + `ELDRUN_PROJECT_DIR` +
   fence and container mounts + the hook hint. Gate: `cargo test`, clippy,
   `npm run backend:stale`.
2. Sidecar: `outbox.rs` classification + `host.rs` disposition + tests.
3. Phone: chips, text sheet, download and share + vitest; `npm run
   mobile:bundle`.
4. Scaffold text, docs, todo item.

## 6. Verification

Implementation verification (2026-09-14): `npm run build` (both bundles), the
full frontend and Rust suites, focused phone/share regressions, and Clippy
1.97 with `--all-targets -- -D warnings` passed. ESLint reports zero errors and
31 existing warnings; changed-file lint also has no errors. Shell scratch
checks covered text/PNG/stdin, UTF-8 versus binary reports, size/directory/empty
refusals, the outbox budget, file and directory collisions, and clear without
following symlinks. Installation tests verify byte drift repair and Unix mode.
PowerShell is unavailable locally; Windows execution and macOS remain platform
QA. `rustup check` could not verify a newer stable because the installed Rust
home is read-only. Nothing was run live. `backend:stale` reports that both the
open window and serving phone sidecar predate the new bundle; the user must
rebuild and relaunch deliberately.

Publication uses bounded private staging and the POSIX `link` utility instead
of writing a visible leaf with `set -C`: readers see complete files, collision
retry never overwrites or descends into a directory, and a per-outbox lock
serializes sends/clear so concurrent sends cannot pass the quota together.
The sidecar keeps one validated file descriptor through the read, rejects
symlink leaves at open, and rechecks the response bytes and size.

Automated — all CI gates, results reported, and stated plainly that it was
not run live: `npm run build`, `npm test`, `cargo test --manifest-path
src-tauri/Cargo.toml`, `cargo clippy … -D warnings`, `npm run lint`, then
`npm run backend:stale`. `sh -n scripts/eldrun-send.sh`, and a shell test in
the scratchpad: a fake project dir with `ELDRUN_PROJECT_DIR` set, send a text
file, a PNG, stdin, a 25 MiB file (refused), a directory (refused), a name
collision (`-1` suffix).

Live QA for the user (a restart first, then the phone on the tailnet):

1. **The §1 round trip.** From the phone's Focus composer on a fenced Claude
   tab: "render a small matplotlib plot and show me the image" → the tab
   runs `eldrun-send …png` on its own → within ~8 s the **From the agent**
   strip shows the thumbnail → tap → full screen.
2. `cargo test 2>&1 | eldrun-send -n tests.log` → a text chip → the sheet
   shows the log.
3. A PDF from the project → chip → opens in a new tab on the phone.
4. `cp` a PNG into `.eldrun/outbox/` by hand → still a thumbnail (unchanged).
5. In a container tab of a containerized project: step 2 again.
6. A `.zip` → chip → Save downloads it; Share… offers other apps.
7. `eldrun-send --clear` → the strip empties. With Eldrun closed → the strip
   still lists what is there.
8. A `.txt` renamed to `.png`, and an `.svg` → both listed as **text**, never
   rendered.

## 7. Decided against, and deferred

- **A socket or HTTP call from the script** (`desktop-control.sock`, the
  sidecar's port): unreachable from the fence (tmpfs `$HOME`) and from a
  container (its own loopback). The folder is the only channel every runtime
  shares, and it already answers with the desktop closed.
- **A Rust subcommand on the `eldrun` binary**: not findable inside the fence
  or a container; a hundred-megabyte binary for a `cp`.
- **A Read-tool hook or transcript scraping**: the mobile plan's stated
  non-goal. The command is the explicit act; nothing is ever sent
  automatically.
- **Serving text by its extension** (`.html`, `.svg`, `.md` rendered): an
  active type from an agent-written tree is the one thing the browser
  boundary forbids. `text/plain` + `nosniff` for all of it.
- **A caption beside the file**: the Focus transcript already carries the
  agent's words; the file name is the caption.
- **A push notification**: no push channel exists; future-plan §A.
- **Remote SSH tabs**: deferred to a `DesktopRequest` that pulls a host's
  outbox over SFTP (§3.6).
- **Adding the paragraph to every existing project's `AGENTS.md`**: the
  scaffold repair upgrades untouched stubs only, by design; edited files are
  the user's. The hook hint (§3.7) is what covers those projects for Claude.
