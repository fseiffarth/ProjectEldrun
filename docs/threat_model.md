# Eldrun — Threat Model

Every place an attacker can reach Eldrun, sorted by **what you have to do for
the attack to happen**. Written 2026-09-18 from a code read; each "✅" names
the defence that holds it. Verify against code before relying on a row — this
file is a map, not a proof. Open items are tracked in
`todo/group-o-security.md` (#151, #158–#160).

**Legend** — ✅ defended · ⚠️ residual (known, bounded, or needs your care) ·
❌ open gap · 🔍 not audited.

**Who is responsible.** Tiers 0–2 are Eldrun's job: nothing you receive or
merely look at should ever run code. Tier 3 is shared: Eldrun contains the
agent, but the agent's power is the permission mode *you* gave its CLI. Tier 4
is yours: running something is running something, same as in any terminal.

## The one fact everything hangs on

The main window's IPC reaches the whole backend — terminals, git, mail send.
Tauri checks app commands only for remote origins, so **any script running in
the main window is full compromise.** Two layers stop that: every renderer is
escape-first (no raw document HTML reaches the DOM), and the CSP
(`script-src 'self' blob:`, no `unsafe-inline`, no `unsafe-eval`) blocks inline
handlers and `eval` even if one renderer slipped. Browsed pages live in separate
`browser-*` webviews whose capability grants nothing
(`src-tauri/capabilities/browser.json`, guarded by `tests/capability_scope.rs`).

---

## Tier 0 — you do nothing (network, background work)

| Entry point | Attacker controls | Defence | Status |
|---|---|---|---|
| **Phone bridge** (Eldrun Mobile) | HTTP/WebSocket requests from your tailnet | Off by default; binds `127.0.0.1` only, reached through Tailscale Serve; refuses to start if Funnel exposes it publicly. Pairing: 8-digit code, 5 tries, 5 min, constant-time compare. Login: P-256 challenge signature; `__Host-` cookie `Secure; HttpOnly; SameSite=Strict`; exact-Origin check on every write and on the terminal WebSocket. Per-minute rate limits (pairing 10, per device 30, unknown ids one shared bucket); 256-connection cap, 15 s header deadline. Only HMAC-derived opaque ids cross the API — no paths, project ids or tmux targets. | ✅ |
| Phone bridge — a **paired phone is lost/stolen** | Everything a paired device can do | By design a paired device drives agent terminals. Sessions expire after 12 h; revoke the device from the desktop. | ⚠️ yours |
| **Loopback listeners** (Eldrun MCP, VM egress proxy, local-model client) | Connections from other local processes/users | All bind `127.0.0.1`. MCP: bearer token, constant-time, DNS-rebinding guard. VM proxy: CONNECT-only to an AI-API allowlist — nothing a local process couldn't already reach. | ✅ |
| **Incoming mail** (fetched in the background) | Headers, bodies, attachments | Parsed in Rust; nothing renders until you open it (tier 2). The mail AI runs only against a **loopback** Ollama and refuses a remote host even if allowed globally; it fetches no links or images. A hostile mail can still steer what the local model *says* (classification) — whether any result is auto-applied was not audited. | ✅ / 🔍 |
| **Calendar sync** (CalDAV) | Server-sent iCalendar data | Parsed in Rust, rendered as text. | 🔍 |
| **App updates** | — | Never automatic (see tier 4). | ✅ |
| **Background git** — file-tree status poll, diff, usage recap | A project's `.git/` contents | Every call pins `core.fsmonitor=false`, `protocol.ext.allow=never`, `--no-ext-diff --no-textconv`; before each local call `sanitize_repo_git_config` strips `filter.*`/`diff.*` drivers and `include`/`includeIf` from `<project>/.git/config` (TODO #151). | ✅ for a normal `.git/` dir |
| Background git — **`.git` is a *file*** (`gitdir: elsewhere`) | Where the real git dir and its config live | **Not covered.** The sanitizer only reads `<project>/.git/config` and returns early when it isn't a file, so a redirected config keeps its filter driver. Reproduced 2026-09-18 with Eldrun's exact flags: the driver runs on `git diff` and on `git status` after a same-size edit — i.e. from the file-tree poll, no click needed. Eldrun's own agent worktrees use this layout. | ❌ #158 |
| Background git — **lockstep** (`services::git_peer`) | The local mirror's `.git/` | Local calls (`checkout`, `merge`, `reset`, `commit`, `diff`, `clean`) run **without** the hardening above, so hooks and repo config fire. Argued out of scope in #151 because a remote project's mirror is never container-mounted — holds only while nothing sandboxed can write the mirror. | ⚠️ #151 |
| **Byte-sync / worker sync** from a remote host | File contents on the remote | Never transfers `.git/` or `.eldrun/`; worker sync is push-only and never `git clean`s. A compromised remote *can* change ordinary files you later run (a script, a Makefile) — that is tier 4. | ✅ |
| **Remote / VPN auto-connect** | — | Never prompts, never `pkexec`s a connect that can't succeed silently; passwords only in the OS keychain, opt-in. | ✅ |

## Tier 1 — you set it up once, then it runs unattended

| Entry point | Risk | Status |
|---|---|---|
| **Scheduled agent prompts / warm-up cron** | Runs an agent CLI at a set time, in its own permission mode, with nobody watching. Everything in tier 3 applies, minus your chance to notice. Point scheduled prompts at trusted inputs only. | ⚠️ yours |
| **Auto-sync to remotes** | Moves your files to hosts you named; the remote's admins can read them. | ⚠️ yours |

## Tier 2 — you open or view something

Opening is your choice; *viewing must never execute*. Everything below renders
without running document code.

| What you open | Defence | Status |
|---|---|---|
| **Markdown** (`.md`, notebook markdown cells, prompt fields) | Escape-first renderer (`lib/viewers/markdown.ts`): raw HTML shown as text; links limited to http(s)/mailto/tel/file/relative, never `javascript:`/`data:`; remote images are placeholders until you press Load; Mermaid `securityLevel: "strict"`, KaTeX `trust: false`. Clicking a local link opens an Eldrun viewer, never the OS handler; unknown types open as plain text. 27 hostile cases in `Markdown.test.ts` (placeholder-in-attribute bug fixed 2026-09-18). | ✅ |
| **Jupyter notebooks** | `text/html` outputs dropped; images only base64 PNG; code highlighted escape-first. | ✅ |
| **ODT** | Rebuilt tag-by-tag from a whitelist; links http(s)/mailto/`#` only; images `data:` from the archive; space runs capped. | ✅ |
| **PDF** | pdf.js 6.3 (past the CVE-2024-4367 font-eval fix); the CSP has no `unsafe-eval` regardless. | ✅ |
| **HTML / SVG / CSS files** | Previewed in `<iframe sandbox="" srcdoc>` — no scripts, no same-origin. | ✅ |
| **Images, code, YAML, CSV, TeX source** | Escape-first highlighters; YAML/table viewers edit surgically. | ✅ |
| **Mail message** | Sanitised with `ammonia`, shown only in a `sandbox=""` iframe; remote images blocked behind a banner. | ✅ |
| **In-app browser** | Separate webview with no IPC capability; navigation gate refuses `tauri:`/`ipc:`/`data:`/`blob:`. Residual: WebKitGTK engine bugs — keep the system package updated. | ✅ / ⚠️ |
| **A project folder you didn't create** (download, zip, someone's repo copy) | The file-tree git poll runs immediately (tier 0 rows). Normal `.git/`: hardened. `.git` as a pointer file: **executes a filter driver** (#158). Also: Python interpreter discovery runs `poetry`/`pyenv`/`conda` with the project as cwd, and those tools read project files (never the project's own venv interpreter). | ❌ #158 / 🔍 |
| **Agent instruction files** in a project (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …) | Harmless to open; they become prompt input when an agent runs there (tier 3). | ⚠️ |

## Tier 3 — you run a prompt / an agent

The agent's power is **its CLI's permission mode** — Eldrun injects no mode flag
and never raises it. In an auto-approve/bypass mode, prompt injection from
anything the agent reads (repo files, READMEs, issues, web pages, tool output,
pasted mail) can run commands as you.

| Entry point | What a hijacked agent can do | Defence | Status |
|---|---|---|---|
| **Unfenced agent tab** | Anything your user can. | None beyond the CLI's own permission prompts. | ⚠️ yours |
| **Fenced agent** (`services::agent_fence`, bubblewrap) | Only what's mounted. | Hides the host (ps/systemctl see nothing); fails closed if bubblewrap is missing; credential files pinned/hidden (#155–#157). | ✅ |
| Fenced agent / **project container** — **planting in `.git/`** | Writes `.git/hooks/*`, `.git/config`, or swaps `.git` for a pointer file. The *next unsandboxed git* — Eldrun's poll, lockstep, your Commit/Push/Checkout, or your own terminal — runs it **on the host**. Publicly known as the sandbox "trust handoff" (Cursor, Pillar Security 2026). | Config filters/diff drivers stripped for a normal `.git/` (#151). Not covered: hooks, `core.sshCommand`/`credential.helper` on push, the pointer-file layout, lockstep. Neither fence nor container mounts `.git/hooks`/`config` read-only. | ❌ #158 |
| **VM project** | Code runs in a VM; network is slirp `restrict=on` + allowlisting proxy. | Exfiltration is still possible *to the allowed AI endpoints* (inside a prompt) — stated in the UI. | ⚠️ |
| **Root console + Eldrun MCP** | Read project list, git/sync status, calendar, to-dos, usage; **create/edit/delete** calendar events and to-dos. No mail, no shell *through MCP* (the agent's own shell still applies). | Token-gated, loopback only. | ⚠️ bounded |
| **Local completion** (Copilot, Ollama) | Suggests text. | Nothing is applied until you accept it. | ✅ |
| **Agent-session hooks** (the one place Eldrun edits another app's config) | — | Hook scripts live in Eldrun's state dir, mounted read-only into containers. | ✅ |

## Tier 4 — you click an explicit action

These run code by design; the question is only whether they run *more* than you
asked for.

| Action | Hidden extra | Status |
|---|---|---|
| **Run / terminal / build / TeX compile** | Runs what you asked for. TeX never gets `-shell-escape`; the TeX distribution's *restricted* shell escape (bibtex, epstopdf, …) still applies. | ⚠️ yours |
| **Commit / Checkout / Push / Pull** in Eldrun's git panel | The repo's own hooks fire (by design); `core.sshCommand`/`credential.helper` from repo config are honoured on push/fetch. Harmless for your repos, dangerous after a sandboxed agent planted them (tier 3). | ⚠️ #151 |
| **Install update** | Asset URL pinned to this repo's GitHub releases, and the staged file is the only thing installed. **No signature or checksum** — trust rests on the GitHub account, CI, and HTTPS. | ⚠️ #160 |
| **One-click installers** (agent CLIs, tools) | Runs the vendor's installer; you trust the vendor. | ⚠️ yours |
| **Open externally / attachments** | Handed to your OS default app — that app's risk. | ⚠️ yours |
| **Pair a phone** | Gives that device terminal control. | ⚠️ yours |

## Out of scope

Malware already running as your user (it can read `~/.config`, drive tmux,
and inject into any process you own), a compromised OS or WebKitGTK, physical
access to an unlocked machine.

## Hardening backlog (not vulnerabilities today)

- `app.security.freezePrototype` is not set — a cheap guard against
  prototype-pollution hijacking of the IPC bridge (#159).
- `mobile_control` mutex locks recover from poisoning (done 2026-09-18), so a
  panicking handler can't lock the phone out.

---

## How this maps to published lists

- **OWASP Top 10 for Agentic Applications (2026)** — ASI01 Goal Hijack and
  ASI06 Memory & Context Poisoning → tier 3 prompt injection and instruction
  files; ASI02 Tool Misuse → Eldrun MCP scope; ASI03 Identity & Privilege Abuse
  → permission modes; ASI04 Supply Chain → updater, installers, dependency
  audit (`.github/workflows/audit.yml`); ASI05 Unexpected Code Execution → the
  `.git` trust handoff; ASI10 Rogue Agents → scheduled agents.
- **IDEsaster** (30+ CVEs across AI IDEs, 2025) — its four vectors are all
  here: malicious workspace (tier 2 project folders), malicious files (tier 2),
  malicious web content (in-app browser, agent browsing), malicious tool
  descriptions (MCP servers you add to your agent CLIs).
- **Sandbox "trust handoff"** (Pillar Security, CSA 2026) — the agent stays in
  the box but writes a file an unsandboxed tool later executes: git config and
  hooks, a venv interpreter, a task file. Eldrun's instance is #158.
- **Tauri attack surface** (Bishop Fox) — unfrozen prototypes, wildcard
  capabilities, asset-protocol scope, open navigation. Eldrun: capabilities
  scoped per webview, no asset protocol, navigation gated for browser windows,
  prototype not frozen (#159).

Sources: [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) ·
[IDEsaster — 30+ flaws in AI coding tools](https://thehackernews.com/2025/12/researchers-uncover-30-flaws-in-ai.html) ·
["Your AI, My Shell" (arXiv 2509.22040)](https://arxiv.org/html/2509.22040v2) ·
[Pillar Security — Git directories do not have to be called .git](https://www.pillar.security/blog/git-directories-do-not-have-to-be-called-git) ·
[CSA — AI coding agent sandbox escapes: the trust handoff flaw](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-coding-agent-sandbox-escapes-20260722-c/) ·
[Bishop Fox — Attacking alternative desktop frameworks](https://bishopfox.com/blog/beyond-electron-attacking-alternative-desktop-application-frameworks) ·
[Tauri security](https://v2.tauri.app/security/)
