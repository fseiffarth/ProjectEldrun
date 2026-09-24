# Eldrun — Threat Model

Every place an attacker can reach Eldrun, sorted by **what you have to do for
the attack to happen**. Written 2026-09-18 from a code read; re-evaluated
2026-09-24 against HEAD plus the uncommitted tree (four read-only reviews:
tiers 0–1, tier 2, tiers 3–4, mechanisms). Each "✅" names the defence that
holds it. Verify against code before relying on a row — this file is a map,
not a proof. Open items are tracked in `todo/group-o-security.md` (#151,
#158, #160, #861–#869).

**Legend** — ✅ defended · ⚠️ residual (known, bounded, or needs your care) ·
❌ open gap · 🔍 not audited.

**Who is responsible.** Tiers 0–2 are Eldrun's job: nothing you receive or
merely look at should ever run code. Tier 3 is shared: Eldrun contains the
agent, but the agent's power is the permission mode *you* gave its CLI. Tier 4
is yours: running something is running something, same as in any terminal.

## Open gaps (2026-09-24)

| # | Gap | You do | Todo |
|---|---|---|---|
| 1 | A fenced, native-installed agent gets `~/.local/bin` read-write, and Eldrun prepends `~/.local/bin` to every child's PATH — a planted `git` runs on the host at the next file-tree poll, a planted `bwrap` unfences later tabs. | nothing | #861 |
| 2 | Eldrun's hardened git leaves hooks live; diff/stage/file-diff/commit-message/merge-state fire `post-index-change`, and a fenced agent can redirect hooks by *creating* `.git/commondir`. | open the Git panel | #862 |
| 3 | SFTP entry names are not confined: `../..` components from a hostile remote account are joined onto the mirror and written. | nothing (auto-sync) | #863 |
| 4 | MCP tokens and forwarded API keys ride in `tmux -e K=V` / `docker exec -e K=V` argv — `/proc/*/cmdline` is world-readable. | nothing (multi-user host) | #864 |
| 5 | `~/.gemini` is mounted read-write, whole, into every fence — an `mcpServers` command planted there runs at the next unfenced Gemini/Antigravity start. | run Gemini unfenced | #865 |
| 6 | Format on `.rs` runs rustup's proxy in the project; `rust-toolchain.toml` `path = "./tc"` runs the repo's own `rustfmt`. | Format | #866 |

## The one fact everything hangs on

The main window's IPC reaches the whole backend — terminals, git, mail send —
through 643 `#[tauri::command]`s with no per-command ACL. The same holds for
every `main`, `detached-*` and `present-*` webview. Tauri checks app commands
only for remote origins, so **any script running in one of those webviews is
full compromise.** Three layers stop that: every renderer is escape-first (no
raw document HTML reaches the DOM); the CSP (`script-src 'self' blob:`, no
`unsafe-inline`, no `unsafe-eval`, guarded by `tests/capability_scope.rs` and
`CspTripwire.test.ts`) blocks inline handlers and `eval` even if one renderer
slipped; and `Object.prototype` is frozen before bootstrap
(`lib/hardenPrototype.ts`, #159). Browsed pages live in separate `browser-*`
webviews whose capability grants nothing (`src-tauri/capabilities/browser.json`).
Plugins are dialog, drag and notification only — no shell, fs, http, opener or
updater plugin, no asset protocol, `withGlobalTauri` off.

The phone PWA is a second origin: script there equals a paired device. Its
bridge serves `script-src 'self'; object-src 'none'; base-uri 'none';
frame-ancestors 'none'`, `nosniff`, `DENY` on every response.

---

## Tier 0 — you do nothing (network, background work)

| Entry point | Attacker controls | Defence | Status |
|---|---|---|---|
| **Phone bridge** (Eldrun Mobile) | HTTP/WebSocket requests from your tailnet | Off by default; binds `127.0.0.1` only, reached through Tailscale Serve; refuses to start if Funnel exposes it, re-checks Serve every 30 s and shuts down on drift. Pairing: 8-digit code, 5 tries, 5 min, constant-time compare. Login: P-256 challenge signature; `__Host-` cookie `Secure; HttpOnly; SameSite=Strict`; exact-Origin check on every write and on the terminal WebSocket. Rate limits, 256-connection cap, 15 s header deadline. Only HMAC-derived opaque ids cross the API — the one exception is the project-relative path a phone upload reports back (files land in `.eldrun/inbox/`, safe-alphabet name, `create_new`, confined below the root). Root console from the phone only behind a default-off switch plus write review "all". | ✅ |
| Phone bridge — a **paired phone is lost/stolen** | Everything a paired device can do | By design a paired device drives agent terminals. Sessions end after 15 min idle, 12 h absolute; a sidecar restart ends all. Revoke the device from the desktop. | ⚠️ yours |
| **Loopback listeners and local sockets** | Connections from other local processes/users | One `127.0.0.1` server, three routes: `/mcp` (root), `/mcp/schedule`, `/mcp/help`. Each: per-tab CSPRNG bearer token, constant-time; any `Origin` refused; exact `Host`; one `Authorization` header; body cap, timeout, rate limit. VM proxy: CONNECT-only to an AI-API allowlist. OpenVPN management port: loopback, password file 0600. `desktop-control.sock` and the mobile `admin.sock`: dir 0700, socket 0600, same-uid peer check. **Residual:** the tokens reach tabs through world-readable argv (gap 4). | ✅ / ❌ #864 |
| **Incoming mail** (fetched in the background) | Headers, bodies, attachments | Parsed in Rust with size caps everywhere; nothing renders until you open it (tier 2). The mail AI runs only against a **loopback** Ollama and fetches no links or images. Auto-classify is off by default (global switch + per account) and can only mark unmarked new inbox mail Urgent/Important with a model-written reason — a hostile mail can promote itself, nothing more. `Authentication-Results` is trusted only when topmost and naming the configured authserv-id. | ✅ |
| **Calendar sync** (CalDAV) | Server-sent WebDAV XML and iCalendar | WebDAV XML parsed in Rust (`roxmltree`; 32 MiB, 5 redirects, no TLS→HTTP downgrade). iCalendar parsed in `lib/calendar/ics.ts` into plain text fields — no HTML sink; join links http(s) only. Writes go only to subscribed collections. **Residual:** hrefs the server names (principal, home-set) are followed to any origin, plain `http://` included, with the account's credentials. | ✅ / ⚠️ #869 |
| **App updates** | — | Never automatic (see tier 4). | ✅ |
| **Background git** — file-tree status poll, project-switcher dirty poll (every 12 s), usage recap | A project's `.git/` contents | Status-only. Every call pins `core.fsmonitor=false`, `protocol.ext.allow=never`, `--no-ext-diff --no-textconv`, `GIT_OPTIONAL_LOCKS=0` (no index rewrite → no `post-index-change`); `sanitize_repo_git_config` strips `filter.*`/`diff.*` drivers and `include`/`includeIf` before each local call. **Residual:** `git` itself is resolved through a PATH that starts with `~/.local/bin` (gap 1). | ✅ / ❌ #861 |
| Background git — **`.git` is a *file*** (`gitdir: elsewhere`) | Where the real git dir and its config live | The sanitizer finds the git dir the way git's discovery does, without running git: nearest `.git` walking up, one `gitdir:` hop, a linked worktree's `commondir`, and `config.worktree` beside each. A bare-repo layout is refused by `safe.bareRepository=explicit`. Tests cover each layout. | ✅ #158 |
| Background git — **lockstep / worker sync** (`services::git_peer`) | The local mirror's `.git/` | Local calls go through `hookless_git_command_in`: sanitizer, fsmonitor off, `core.hooksPath=`. Destructive moves recorded by `services::local_loss`. | ✅ #151 |
| **Byte-sync / worker sync** from a remote host | File contents **and names** on the remote | Never transfers `.git/`, `.eldrun/` or nested repos; symlinks never mirrored; worker sync is push-only and never `git clean`s. **Gap:** the SFTP walk drops only `""`, `.`, `..` — a name carrying `../` components is joined onto the mirror unconfined and written, so a hostile remote *account* (a forced-command fake `sftp`) can drop an autostart entry. **Residual:** a directory symlink a fenced agent plants in the mirror redirects the next SFTP pull (parents are followed). | ❌ #863 |
| **Remote / VPN auto-connect** | — | Never prompts, never `pkexec`s a connect that can't succeed silently; passwords only in the OS keychain, opt-in. Spot-checked only. | ✅ |

## Tier 1 — you set it up once, then it runs unattended

| Entry point | Risk | Status |
|---|---|---|
| **Scheduled agent prompts / warm-up cron** | Runs an agent CLI at a set time, in its own permission mode, with nobody watching. Everything in tier 3 applies, minus your chance to notice. Warm-up and the `/usage` probe run in `<state>/agent-cron`, never in a project. Point scheduled prompts at trusted inputs only. | ⚠️ yours |
| **Agent-authored schedules** (schedule MCP, opt-in `settings.schedule_mcp`) | A prompt-injected agent can give itself a future, unwatched turn. Level per project from `projects.json` (default "propose"); at "apply" a one-time prompt schedules without approval, recurring ones are always proposed; self-targeted only; quotas; `/ ! # $ @` prefixes refused. | ⚠️ yours |
| **Auto-sync to remotes** | Moves marked paths **both ways** without a click: a host you sync with can change those local files (never `.git/`/`.eldrun/`; no deletions; conflicts skipped), and its admins can read what you push. See gap 3. | ⚠️ yours / ❌ #863 |

## Tier 2 — you open or view something

Opening is your choice; *viewing must never execute*. Everything below renders
without running document code.

| What you open | Defence | Status |
|---|---|---|
| **Markdown** (`.md`, notebook markdown cells, prompt fields, Skills library) | Escape-first renderer (`lib/viewers/markdown.ts`): raw HTML shown as text; links limited to http(s)/mailto/tel/file/relative, never `javascript:`/`data:`; remote images are placeholders until you press Load; local images via `read_file_bytes` (regular files, confined). Mermaid `securityLevel: "strict"`, KaTeX `trust: false`. A local link opens an Eldrun viewer, never the OS handler. 27 hostile cases in `Markdown.test.ts`. | ✅ |
| **Jupyter notebooks** | `text/html` outputs dropped; images only base64 PNG; code highlighted escape-first. | ✅ |
| **ODT** | Rebuilt tag-by-tag from a whitelist; links http(s)/mailto/`#` only; images `data:` from the archive; space runs capped. **Residual:** `unzipSync` inflates the whole archive in the main renderer with no cap — a zip bomb takes down the window (and every tab in it). | ✅ / ⚠️ #869 |
| **PDF** | pdf.js 6.3 (past CVE-2024-4367), every load through `lib/viewers/pdfLoad.ts`; annotations drawn to canvas only. **Residual:** the worker is outside the page CSP (Tauri sets the header on `.html` only) and `isEvalSupported` is left at its default. | ✅ / ⚠️ #869 |
| **HTML / CSS files** | `<iframe sandbox="" srcdoc>` — no scripts, no same-origin. Print uses `sandbox="allow-same-origin allow-modals"`, never `allow-scripts`. | ✅ |
| **SVG files** | `<img>` from an `image/svg+xml` blob — image context: no script, no loads. | ✅ |
| **Code, YAML, CSV, diff / merge resolver, md-graph** | Escape-first highlighters; React text; YAML/table viewers edit surgically. | ✅ |
| **SQLite** | Opened read-only; table names quoted. | ✅ |
| **Audio / video** | Decoded by WebKitGTK's GStreamer plugins. Keep them updated. | ⚠️ |
| **TeX formula hover preview** (on by default) | Runs the TeX engine on the file's own preamble with the project as cwd; output to a scratch dir. The argv never *enables* shell-escape, but nothing passes `-no-shell-escape` — with `shell_escape = t` in `texmf.cnf` (a common global fix for minted) a cloned paper's `\write18` runs on hover. | ⚠️ #867 |
| **Mail message** | Sanitised with `ammonia`, shown only in a `sandbox=""` iframe with `default-src 'none'; img-src data:`; remote images blocked, no unblock path. Attachments can only be saved. | ✅ |
| **In-app browser** | Separate webview with no IPC capability; navigation gate refuses `tauri:`/`ipc:`/`data:`/`blob:`, the app origin, downgrades, and asks for private hosts. Links from mail, agents, terminals and viewers open first as a Rust-fetched, ammonia-sanitised reader page in `sandbox=""`; going live needs a click. Residual: WebKitGTK engine bugs — keep the system package updated. Windows: no `on_new_window` handler, `target=_blank` falls to WebView2's default (🔍). | ✅ / ⚠️ |
| **Phone PWA: agent answers, outbox gallery** | Answers: `renderMarkdown`, links and images stripped, rebuilt through a tag/class/style allowlist. Outbox: type sniffed from bytes; HTML/SVG/JS served as `text/plain` or attachment. | ✅ |
| **Calendar, to-do, help docs, deck assets** | React text only; help corpus compiled into the binary; deck images as untyped blobs in `<img>`. | ✅ |
| **A project folder you didn't create** (download, zip, someone's repo copy) | The file-tree git poll runs immediately (tier 0 rows). Hardened for a normal `.git/`, a `.git` pointer file, a linked worktree and a bare-repo layout (#158). Nothing else runs until you act. | ✅ #158 |
| **Agent instruction files** in a project (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …) | Harmless to open; they become prompt input when an agent runs there (tier 3). | ⚠️ |

## Tier 3 — you run a prompt / an agent

The agent's power is **its CLI's permission mode** — Eldrun injects no mode flag
and never raises it. In an auto-approve/bypass mode, prompt injection from
anything the agent reads (repo files, READMEs, issues, web pages, tool output,
pasted mail) can run commands as you.

| Entry point | What a hijacked agent can do | Defence | Status |
|---|---|---|---|
| **Unfenced agent tab** | Anything your user can — including `desktop-control.sock` (same-uid check) and the root token in `/proc/<pid>/environ`. | None beyond the CLI's own permission prompts. | ⚠️ yours |
| **Fenced agent** (`services::agent_fence`, bubblewrap) | Sees `/` read-only (not `$HOME`, `/tmp`, `/run` or Eldrun state), loopback and abstract sockets (shared network namespace). Writes its project and its own agent state. | Hides the host's processes; fails closed if bubblewrap is missing; credential files pinned/hidden (#155–#157). **Gaps:** a native-installed CLI gets `~/.local/bin` and `~/.local/share/<tool>` read-write — enough to plant a binary Eldrun and your shell run on the host (gap 1); `~/.gemini` is read-write whole in every fence (gap 5). **🔍:** `DISPLAY` is not scrubbed and the abstract X11 socket is reachable — XTEST keystroke injection into host windows not audited. | ❌ #861 #865 / 🔍 |
| Fenced agent / **project container** — **planting in `.git/`** | Writes `.git/hooks/*`, `.git/config`, or swaps `.git` for a pointer file — the sandbox "trust handoff" (Cursor, Pillar Security 2026). | Fence and containers re-mount the repo's git control files read-only (`.git/config`, `config.worktree`, `hooks/`, a worktree's `commondir`, `.git` pointer files) and pin `.git` onto itself (`services::git_guard`). Verified under real bubblewrap; containers not run live. **Gap:** a git dir must stay writable for lock files, so the agent can still *create* a `commondir` in a main `.git` (or `hooks/` where missing) and redirect hooks. That reaches Eldrun's own hooks-live git calls — diff, stage, file diff, commit-message generation, merge-state on opening Git history (gap 2) — not only a plain `git` in your terminal. | ❌ #158 #862 |
| **VM project** | Code runs in a VM; network is slirp `restrict=on` + allowlisting proxy. A `mail_reader` VM holds a Reader token: reads opted-in mail, drafts replies (recipients only from the replied-to thread), staged calendar/board writes. | Exfiltration is still possible *to the allowed AI endpoints* (inside a prompt, or to an attacker's API key) — stated in the UI. | ⚠️ |
| **Root console + Eldrun MCP** | Read projects, git/sync status, usage, calendar, to-dos; create/edit/delete events and cards; write mail drafts, optionally with project files (opt-in `root_fence_projects_readable`) and suggested recipients — **never send**. Opted-in local models and the mail VM read mail. No shell through MCP (the agent's own shell still applies). | Token per spawn, loopback, Origin/Host-guarded. Writes staged for review by default (`root_mcp_review = all`) — binding only while the root agent is fenced. Attachments: `openat(O_NOFOLLOW)` inside the fence roots, nothing at/above `$HOME`, in `.git`, or key-shaped; caps per draft and tab; you type the recipient and press Send. **Residual:** every child of the root tab inherits the token; with all projects readable, injection from any repo reaches the one agent holding draft+attach. | ⚠️ bounded |
| **Help MCP** (every local agent) | Four read-only `eldrun_help_*` tools over a corpus compiled into the binary. | Helper token class serves nothing else. | ✅ |
| **Local completion** (Copilot, Ollama) | Suggests text. | Insert-only ghost text; nothing applied until you accept. | ✅ |
| **Agent-session hooks** (Claude and Codex only — the one place Eldrun edits another app's config) | — | Hook scripts live in Eldrun's state dir, mounted read-only into fences and containers; registration files are shadow copies or overlays. Other CLIs' configs: see gap 5. | ✅ |

## Tier 4 — you click an explicit action

These run code by design; the question is only whether they run *more* than you
asked for.

| Action | Hidden extra | Status |
|---|---|---|
| **Run / terminal / build / TeX compile** | Runs what you asked for. TeX never gets `-shell-escape`; `latexmkrc`/`.latexmkrc` asks once (`services::exec_trust`). Every container tab — shell tabs too — gets the forwarded agent API keys. | ⚠️ yours |
| **Format** | A project's prettier, JS config and plugins ask once (`exec_trust`). **Gaps:** `rustfmt` via a `rust-toolchain.toml` `path` (gap 6); a `.prettierrc` holding only a shared-config module name loads that module ungated. black/gofmt ungated (data-only configs). | ❌ #866 |
| **Python Run / Debug / interpreter dialog** | `poetry`/`conda`/`pyenv` probes run with the project as cwd, and an in-tree `.venv` is auto-selected — neither gated by `exec_trust`. | ⚠️ #146 |
| **Commit / Push / Pull / Reword / Publish** in Eldrun's git panel | Hooks and repo-configured programs (`core.hooksPath`, `sshCommand`, `askpass`, `editor`, `credential*.helper`, `gpg*.program`, `remote.*.uploadpack/receivepack`, `merge.*.driver`, `hook.*`) are fingerprinted and asked once (`exec_trust`); any change re-asks. Checkout, worktree and fetch run hookless. Push credentials scoped per origin. Residual: check-to-use window; an approved hook may run other project code. Diff and Stage are *not* gated — gap 2. | ✅ / ⚠️ #151 |
| **Connect VPN** | OpenVPN runs as root via `pkexec` without `--script-security 1`, so a config's `up`/`down` scripts run as root. An imported project bundle can name its own `.ovpn`. Root writes `--writepid` into the user-writable `<state>/openvpn/`. | ⚠️ #868 |
| **Install update** | Asset URL pinned to this repo's GitHub releases, and the staged file is the only thing installed. **No signature or checksum** — trust rests on the GitHub account, CI, and HTTPS. | ⚠️ #160 |
| **One-click installers** (agent CLIs, tools) | Runs the vendor's installer; you trust the vendor. | ⚠️ yours |
| **Extract archive** | Zip-slip handled; no size or entry cap — can fill the disk. | ⚠️ #869 |
| **Open externally / attachments** | Handed to your OS default app — that app's risk. Handlers come only from `projects.json`, never the in-folder `project.json`. | ⚠️ yours |
| **Pair a phone** | Gives that device terminal control, new agent tabs, read/mark/reply mail, calendar/to-do edits, and files into a project's `.eldrun/inbox/`. | ⚠️ yours |

## Out of scope

Malware already running as your user (it can read `~/.config`, drive tmux,
and inject into any process you own), a compromised OS or WebKitGTK, physical
access to an unlocked machine. Other local *users* are **in** scope (gap 4,
state-dir permissions).

## Hardening backlog (not vulnerabilities today)

- `Object.prototype` is frozen in Eldrun's own windows (#159, done
  2026-09-18) by `lib/hardenPrototype.ts`, not Tauri's `freezePrototype`: that
  flag also freezes browsed pages, and a bare freeze breaks pdf-lib (the
  "override mistake"). The phone PWA is not hardened this way.
- `mobile_control` mutex locks recover from poisoning (done 2026-09-18), so a
  panicking handler can't lock the phone out.
- #869 batch: state dir created 0700 and `storage::write_json` at 0600 (today
  0775/0664 — safe only because `~` is 0700); pin `actions/*` and
  `github/codeql-action` by SHA (`contents: write` release job included); add
  `base-uri 'none'; form-action 'none'` to the CSP and drop `script-src blob:`
  if nothing needs it; forward agent API keys only to agent tabs.
- `cargo audit` ignores RUSTSEC-2023-0071 (`rsa` timing, via `pgp`).

---

## How this maps to published lists

- **OWASP Top 10 for Agentic Applications (2026)** — ASI01 Goal Hijack and
  ASI06 Memory & Context Poisoning → tier 3 prompt injection and instruction
  files; ASI02 Tool Misuse → Eldrun MCP scope; ASI03 Identity & Privilege Abuse
  → permission modes, token inheritance; ASI04 Supply Chain → updater,
  installers, dependency audit (`.github/workflows/security.yml`: cargo audit,
  npm audit, CodeQL, gitleaks); ASI05 Unexpected Code Execution → the `.git`
  trust handoff, `~/.local/bin` planting; ASI10 Rogue Agents → scheduled and
  self-scheduled agents.
- **IDEsaster** (30+ CVEs across AI IDEs, 2025) — its four vectors are all
  here: malicious workspace (tier 2 project folders), malicious files (tier 2),
  malicious web content (in-app browser, agent browsing), malicious tool
  descriptions (MCP servers you add to your agent CLIs — and gap 5).
- **Sandbox "trust handoff"** (Pillar Security, CSA 2026) — the agent stays in
  the box but writes a file an unsandboxed tool later executes: git config and
  hooks (#158, #862), a binary on the host's PATH (#861), another CLI's config
  (#865), a venv interpreter (#146).
- **Tauri attack surface** (Bishop Fox) — unfrozen prototypes, wildcard
  capabilities, asset-protocol scope, open navigation. Eldrun: capabilities
  scoped per webview, no asset protocol, navigation gated for browser windows,
  prototype frozen from the app bundle (#159).

Sources: [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) ·
[IDEsaster — 30+ flaws in AI coding tools](https://thehackernews.com/2025/12/researchers-uncover-30-flaws-in-ai.html) ·
["Your AI, My Shell" (arXiv 2509.22040)](https://arxiv.org/html/2509.22040v2) ·
[Pillar Security — Git directories do not have to be called .git](https://www.pillar.security/blog/git-directories-do-not-have-to-be-called-git) ·
[CSA — AI coding agent sandbox escapes: the trust handoff flaw](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-coding-agent-sandbox-escapes-20260722-c/) ·
[Bishop Fox — Attacking alternative desktop frameworks](https://bishopfox.com/blog/beyond-electron-attacking-alternative-desktop-application-frameworks) ·
[Tauri security](https://v2.tauri.app/security/)
