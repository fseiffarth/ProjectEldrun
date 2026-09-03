# Third-party update checklist

Eldrun wraps a lot of software it does not control: agent CLIs, Ollama,
Tailscale, tmux, Docker, QEMU, bubblewrap, OpenVPN, OpenSSH, SLURM, TeX, mail
and CalDAV servers, desktop shells, and the GitHub API. Each of those ships on
its own schedule, and every one of them is wired in through a *specific*
assumption — a flag, a file path, a JSON field, a line of TUI text. This file
collects those assumptions in one place so that "X released a new version" is a
checklist rather than an archaeology dig.

How to use it:

1. When a tool below updates (or a distro upgrade drags one along), open its
   section, walk the **Assumes** list against the new release notes, and run
   the **Verify** steps.
2. Every "verified against" version noted here or in a code comment is the last
   release someone actually checked. Bump it when you re-verify, in the code
   comment first.
3. A breakage found this way is a normal fix: patch the one place named under
   **Where**, add a test alongside the existing ones, update the version note.

Automated gates cover none of this — `cargo test` / `npm test` pin *our* parsers
to *sample* output, not to what the current binary prints. Only running the real
tool does that; the **Verify** steps say how without needing a window.

---

## 1. Agent CLIs (all of them)

The registry in `src-tauri/src/commands/agents.rs` (`AGENTS`) is the one list of
installable agents: Claude, Codex, Antigravity, Gemini, Kiro, Cline, Vibe,
Aider, OpenCode, Cursor, Copilot, Grok, Qwen, OpenClaw, Goose, OpenHands, Pi,
Plandex, SWE-agent, mini-SWE-agent, Mentat, gpt-engineer, Crush, Amp, Kimi,
Qoder. Everything below applies per agent; the agent-specific sections that
follow list what is *additionally* coupled.

**Where**

- `commands/agents.rs` — `AGENTS` (binary name, official install one-liner per
  OS, extra user-install paths, docs URL, npm package for uninstall),
  `WARMUPS` (per-agent one-shot/print argv used by the scheduled warm-up).
- `services/remote_agents.rs` — the *same* install one-liners restated as a
  POSIX-sh prelude for remote hosts (userspace, no sudo). Two tables that must
  say the same thing; they have drifted before.
- `src/stores/tabs.ts` (`RESUME_ARGS` near the bottom) — per-agent "continue
  last session" flags used on relaunch/restore.
- `src/lib/agentPrefaces.ts` — default slash commands offered per agent
  (`/clear`, `/compact`, `/new`, `/status`, …) and `DEFAULT_AGENT_MODELS`.
- `src/lib/agentPrompt.ts` — `looksLikeDecisionPrompt`: the regexes that turn a
  tab's output tail into the "needs a decision" lamp (pointer glyphs, numbered
  choices, yes/no pairs). Every agent's approval prompt has to keep matching.
- `mobile-web/src/terminal/{agentModes,statusLine,selectPrompt,readableScreen}.ts`
  — phone-side parsers of each TUI's status line, mode names, `/model`
  pickers, and box-drawing frames.
- `services/agent_fence.rs` — which per-agent home files/dirs the bubblewrap
  fence binds (`~/.claude`, `~/.claude.json*`, `~/.claude/settings*.json`,
  `~/.codex/config.toml`, `~/.local/share/claude/versions`, `~/.local/bin`).
- `services/sandbox.rs` — the same set for the Docker container.

**Assumes**

- The binary name and the install script URL are stable; `extra_paths` covers
  where the installer drops the binary when it is not on `PATH`.
- The print/one-shot mode listed in `WARMUPS` still exists and still exits on
  its own with no TTY (`-p`, `exec`, `run`, `-x`, `run -t`). An agent not in
  `WARMUPS` is refused, never guessed — keep it that way.
- The resume flag in `RESUME_ARGS` still means "continue the most recent
  session non-interactively" (a flag that now opens a picker hangs a restore).
- Approval prompts still render as a pointer (`❯`/`›`/`>`), numbered options,
  or a yes/no pair — otherwise the decision lamp goes dark.
- Config/state lives in the home paths the fence binds; a CLI that moves its
  config (e.g. into `~/.config/<agent>`) silently loses login inside the fence.

**Verify**

```sh
<agent> --version
<agent> --help | grep -iE 'print|resume|continue|session'   # flags still there?
cargo test --manifest-path src-tauri/Cargo.toml agents::     # WARMUPS/registry tests
npx vitest run src/__tests__/agentPrompt.test.ts              # decision-prompt corpus
```

Then open one tab per updated agent, trigger a permission prompt, and check
the tab lamp turns to "decision"; close and reopen Eldrun and check the tab
resumes.

### 1.1 Claude Code (deepest coupling)

**Where** `services/agent_session.rs`, `services/agent_usage.rs`,
`commands/terminal.rs` (`--remote-control`), `commands/ollama.rs`
(`LOCAL_DRIVERS`), `src/lib/agentPrefaces.ts`, `src/lib/fastMode.ts` is *not*
Claude's `/fast` — different thing.

**Assumes**

- Flags: `--session-id <uuid>`, `--resume <uuid>`, `--permission-mode <mode>`,
  `--dangerously-skip-permissions` (detected, never added),
  `--remote-control` (added by default, setting `agent_remote_control`),
  `-p <prompt>`, `-p "/usage" --output-format json`.
- Permission modes are exactly `default | plan | acceptEdits | auto | dontAsk |
  bypassPermissions` (`is_permission_mode`); anything else is dropped.
- Hooks: `SessionStart` (matcher `startup|resume|clear|compact`) and `Stop`
  are registered in `~/.claude/settings.json` under `hooks.<Event>[].hooks[]`
  as `{type:"command", command:…}`. The hook payload carries `session_id`,
  `hook_event_name`, and (on `Stop`) `permission_mode`. The hook script greps
  those keys with `sed`, so a renamed key breaks resume silently.
  Verified against Claude Code 2.1.251 — a `/clear` fires no Stop event.
- Session logs: `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`; `--resume` is
  emitted only when that file exists.
- `/usage` in print mode returns a JSON envelope with `result` (panel text),
  `is_error`, `num_turns: 0`. The panel text itself is parsed on the phone
  (five-hour / weekly windows, per-model lines) — a re-layout may cost figures.
- Model short names `opus | sonnet | haiku | fable` for the `/model` chips.
- Preface commands `/clear /compact /context /cost`.
- Home files: `~/.claude/`, `~/.claude.json` (+ `.bak`, `.backup.N`),
  `~/.claude/settings.json`, `settings.local.json`,
  `~/.local/share/claude/versions/`.
- Ollama-side: `ollama launch claude --model <m>` is the only way an
  Anthropic-compatible endpoint is stood up for Claude (Ollama ≥ 0.15).
- Mobile: mode family `default | accept edits | plan | bypass permissions`,
  `default` draws no mode line; Shift+Tab is the legacy backtab `ESC [ Z`.

**Verify**

```sh
claude --version
claude --help | grep -E 'session-id|resume|permission-mode|remote-control|output-format'
claude -p "/usage" --output-format json | head -c 600
grep -A4 SessionStart ~/.claude/settings.json
cargo test --manifest-path src-tauri/Cargo.toml agent_session
cargo test --manifest-path src-tauri/Cargo.toml agent_usage
```

Check the release notes for: hook event renames or payload changes, new
permission modes (add to `is_permission_mode` *and* `agentModes.ts`), session
directory moves, `--remote-control` becoming default or removed, new model
aliases.

### 1.2 Codex

**Where** `services/agent_session.rs` (`resolve_codex_session`,
`register_codex_hook`, `codex_hook_state`), `services/codex_bind.rs`,
`src/lib/codexHooks.ts`, `commands/ollama.rs` (`non_thinking_args`,
`write_local_catalog`), `mobile-web/src/terminal/agentModes.ts`.

**Assumes**

- `codex resume <uuid>`; `codex exec --skip-git-repo-check <msg>` (warm-up).
- Session rollouts at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`
  whose **first line** is `{"type":"session_meta","payload":{"session_id","cwd",…}}`.
  This is the hook-free binding path; a new layout or header breaks every
  restored Codex tab.
- User hooks in `~/.codex/config.toml` as `[[hooks.SessionStart]]` with
  `matcher = "startup|resume|clear|compact"` and `[[hooks.SessionStart.hooks]]`
  `type="command"`. Trust state is read from `[hooks.state."…"]` tables
  (`trusted_hash`, enabled flag). Text-appended, never reserialized.
- Local models: `codex --oss -c oss_provider="ollama" -m <model>` as the
  fallback when `ollama launch codex` cannot be used; reasoning is turned off
  with `-c model_reasoning_effort="none"`; the model catalog Codex expects is
  `model.json` (written under Eldrun's own state dir, not `~/.codex`).
- Preface commands `/new /compact /status`; `/status` is *not* available in
  exec mode, so there is no usage recipe.
- Mobile: modes `working (silent) | plan | read only | auto | full access`;
  Shift+Tab is sent as CSI-u. Verified against codex-cli 0.151.0.

**Verify**

```sh
codex --version
codex --help; codex exec --help | grep skip-git-repo-check
head -c 300 "$(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1)"
grep -n 'hooks' ~/.codex/config.toml
cargo test --manifest-path src-tauri/Cargo.toml codex
```

### 1.3 Gemini CLI

**Assumes** `gemini --resume latest` (index or `latest`, not a uuid),
`gemini -p`; preface `/clear /compact /stats`; footer says `NN% used`
without the word "context" (mobile `statusLine.ts`); since ~0.5 the approval
mode is conveyed only as prompt text, so the phone cannot read it.
Install via `npm install -g @google/gemini-cli`.

**Verify** `gemini --help | grep -E 'resume|prompt'`; open a tab, `/stats`.

### 1.4 Qwen Code

**Assumes** `qwen --continue`, `qwen -p`; mode phrases `ask permissions |
plan | auto-accept | auto | yolo` on the Shift+Tab cycle, and `*` as the
YOLO input-line marker (mobile `statusLine.ts`). `npm install -g @qwen-code/qwen-code`.

### 1.5 Everyone else

| Agent | Resume flag | Warm-up | Install |
|-------|-------------|---------|---------|
| Vibe (Mistral) | `--continue` (`--resume` alone opens a picker — never use) | `-p` | `curl … mistral.ai/vibe/install.sh` |
| OpenCode | `--continue` | `run` | `curl … opencode.ai/install` / `npm i -g opencode-ai` |
| Copilot | `--continue` | `-p` | `npm i -g @github/copilot` |
| Cursor agent | `--continue` | `-p` | `curl … cursor.com/install` |
| Grok | `--session latest` | `-p` | `npm i -g @vibe-kit/grok-cli` |
| Antigravity (`agy`) | `--continue` | — | `curl … antigravity.google/cli/install.sh` |
| Kimi | — | `-p` | `curl … code.kimi.com/install.sh` |
| Pi | — | `-p` | `npm i -g @mariozechner/pi-coding-agent` |
| Amp | — | `-x` | `npm i -g @sourcegraph/amp` |
| Goose | — | `run -t` | GitHub release `download_cli.sh` |
| Crush | — | `run` | `npm i -g @charmland/crush` |
| Aider | — | refused (no print mode) | `curl … aider.chat/install.sh` (uv) |
| Kiro, Cline, OpenClaw, OpenHands, Plandex, SWE-agent, mini-SWE-agent, Mentat, gpt-engineer, Qoder | — | — | see `AGENTS` |

Vibe and OpenCode are full-screen (alternate-screen) TUIs; the phone's Focus
view cannot read them — a release that changes that is an *opportunity*, not a
break. Droid, OpenClaw and OpenCode are also `LOCAL_DRIVERS` (Ollama-backed
tabs via `ollama launch <agent>`).

---

## 2. Ollama

**Where** `commands/ollama.rs` (everything), `services/mail_ai.rs`,
`src/lib/ollamaStatus.ts`, `src/lib/localDrivers.ts`, `src/lib/gpu.ts`.
Headless probe: `cargo run --example ollama_probe --manifest-path src-tauri/Cargo.toml`.

**Assumes**

- HTTP/1.0 over a raw TCP stream to `127.0.0.1:11434` (or `Settings::ollama_host`),
  endpoints `/api/tags`, `/api/ps`, `/api/show`, `/api/pull`, `/api/generate`,
  `/api/chat` (mail assistant, `system` role, verified against llama3.2:3b),
  `/api/version`.
- Fields read: `models[].{name,size,digest,details.{family,parameter_size,
  quantization_level}}`, `/api/ps` `size_vram` and `expires_at`, `/api/show`
  `capabilities` (`tools`, `thinking`, `embedding`) and `model_info.*.context_length`
  (matched by *suffix*, so new architectures need no table entry), `keep_alive`,
  `options.num_gpu` (`auto` omits it, `gpu` = `MAX_GPU_LAYERS`, `cpu` = `0`).
- Registry update check: HEAD on the model manifest, `ollama-content-digest`
  response header compared with the local digest.
- `ollama --version` prints `ollama version is X.Y.Z` (a warning line may
  precede it; `parse_version` scans for a version token). Newest release via
  the GitHub releases API.
- `ollama launch <agent> --model <m>` exists since **0.15** and is the only way
  to hand Claude Code an Anthropic-compatible endpoint; sub-commands used:
  `claude`, `codex`, `opencode`, `droid`, `openclaw`. `ollama launch --help` is
  read to learn which agents the installed server supports. `launch` writes
  `~/.codex/model.json` and forwards no extra flags.
- **≥ 0.32 drops integrated GPUs** unless `OLLAMA_IGPU_ENABLE=1`; Eldrun sets it
  on the server it spawns and offers a systemd drop-in for the unit. The flag's
  existence is read from `ollama serve --help`, not from the version.
- `OLLAMA_HOST`, `OLLAMA_MODELS` env semantics (a bare number is a port).
- systemd unit named `ollama` (`systemctl is-active/show -p User/start/stop`),
  install via `curl -fsSL https://ollama.com/install.sh | sh`, `winget
  install --id Ollama.Ollama`, macOS `launchctl setenv`.
- Error strings matched literally: `does not support tools`,
  `"<model>" does not support thinking`, `dropping integrated GPU`,
  `Model metadata for '<model>' not found`.
- Default model names used as examples in tests/UI (`qwen2.5-coder:7b`,
  `qwen3-coder`, `llama3.2`, `nomic-embed-text`, …) — cosmetic, but a
  renamed tag makes an example install fail.

**Verify**

```sh
ollama --version; ollama serve --help | grep -i igpu; ollama launch --help
curl -s localhost:11434/api/show -d '{"model":"<any>"}' | jq '.capabilities, (.model_info|keys)'
cargo run --example ollama_probe --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml ollama
```

Release-note triggers: any `/api/*` shape change, a new capability keyword,
`launch` gaining/losing agents or flags, GPU discovery changes, the version
string format, a rename of the systemd unit.

---

## 3. Tailscale (Eldrun Mobile)

**Where** `services/mobile_control/config.rs` (`verify_tailscale_serve`,
detect settings), `services/mobile_control/host.rs`, `src/components/mobile/
MobileSettings.tsx` (the guide command), `mobile-web/src/connection.ts`.

**Assumes**

- `tailscale serve status --json` exists and returns `Web.<authority>.Handlers.
  "/".Proxy` plus `AllowFunnel.<authority>`; exactly one eligible HTTPS
  mapping proxying to `http://127.0.0.1:<port>`; Funnel must be **off** (refused
  otherwise).
- The guide tells the user `tailscale serve --bg http://127.0.0.1:<port>`.
- MagicDNS `*.ts.net` origins; re-verification after a `tailscaled` restart.

**Verify**

```sh
tailscale version; tailscale serve status --json | jq '.Web, .AllowFunnel'
cargo test --manifest-path src-tauri/Cargo.toml mobile_control::config
```

Triggers: `serve` JSON schema changes (they have renamed keys before), `--bg`
semantics, Funnel defaults, a new "Services" mapping type that the detector
should treat as eligible or not.

---

## 4. tmux

**Where** `services/tmux_local.rs`, `services/remote.rs` (remote tabs),
`src/lib/tmuxSession.ts`, `services/mobile_control/*` (phone replay),
`docs/context/tmux_sessions.md`.

**Assumes** `tmux -V` parses as `tmux <major>.<minor>[letter]` (`next-3.4`
too); `-e KEY=VAL` on `new-session` needs **≥ 3.2** (older exports the key
from the shell instead); `history-limit` option; `ls -F …`, `kill-session -t`,
`rename-session -t`, `capture-pane` before attach; standalone `;` splits argv;
new sessions inherit the *server's* global environment.

**Verify** `tmux -V`; `cargo test --manifest-path src-tauri/Cargo.toml tmux`.
Also check the remote host's tmux, which is usually older.

---

## 5. Docker (project containers)

**Where** `services/sandbox.rs`, `docs/context/docker_containers.md`.

**Assumes** `docker --version`, `ps --filter label=… --format`, `run -d --init
--name --label --user 1000:1000 --cap-drop --security-opt --pids-limit
--memory --cpus --network --read-only --tmpfs … sleep infinity`, `exec`,
`rm -f`, `build -t`, `pull`; the image tag Eldrun builds/pulls; bind-mount of
the project at its identical absolute path.

**Verify** `docker --version; docker run --help | grep -E 'pids-limit|init'`;
`cargo test --manifest-path src-tauri/Cargo.toml sandbox`. Podman is not
supported; a `docker` shim over podman will surface here.

---

## 6. QEMU / cloud images (VM projects)

**Where** `services/vm.rs`, `commands/vm.rs`, `docs/context/vm_projects.md`.

**Assumes** `qemu-system-x86_64` (`qemu-system-aarch64` on arm64 hosts) with
`-enable-kvm` / `-accel hvf` / `-accel whpx` per host, `-daemonize` except on
Windows (spawned detached, pidfile polled), virtio devices, `qemu-img`, one of
`genisoimage -output … | mkisofs | cloud-localds` for the cloud-init seed or
the in-process `services::iso9660` writer, a `qmp.sock` (loopback TCP on
Windows), `qemu.pid`, `serial.log`, the arm64 `edk2-aarch64-code.fd` firmware
under QEMU's share dir; the cloud image
download URL + `SHA256SUMS` of the chosen distro release; a proxy at
`http://10.0.2.100:3128` <!-- privacy-check: ok — QEMU slirp, not a real host -->for the egress knob. Never live-booted so far — a
distro that rotates its cloud-image URL or checksum file name breaks silently.

**Verify** `qemu-system-x86_64 --version; qemu-img --version`; the image URL
resolves; `cargo test --manifest-path src-tauri/Cargo.toml vm::`.

---

## 7. bubblewrap (agent fence)

**Where** `services/agent_fence.rs`, `src/lib/agentFence.ts`,
`docs/agent_fence_plan.md`.

**Assumes** `bwrap` flags `--ro-bind --ro-bind-try --bind --bind-try --dev
--proc --tmpfs --symlink --unshare-pid --die-with-parent --new-session
--chdir`; unprivileged user namespaces allowed (AppArmor on Ubuntu ≥ 23.10
restricts them); missing/unusable bwrap **fails closed**. The per-agent home
list in §1 is what the fence exposes.

**Verify** `bwrap --version; bwrap --ro-bind / / --unshare-pid true`;
`cargo test --manifest-path src-tauri/Cargo.toml agent_fence`.

---

## 8. OpenVPN + polkit

**Where** `services/openvpn.rs`, `commands/openvpn.rs`,
`docs/context/openvpn.md`.

**Assumes** `pkexec openvpn --config --daemon --writepid --log --management
--verb --mute --connect-retry-max --connect-timeout --persist-tun
--auth-nocache` and, depending on the config, `--auth-user-pass` (file) or
`--askpass`; the management-interface protocol (`>PASSWORD:`, `>STATE:`, <!-- privacy-check: ok — OpenVPN management-protocol tokens, not a credential -->
`>HOLD:` lines) for status and teardown; `openvpn.exe` on Windows; config
directives `auth-user-pass` / encrypted key detection by text.

**Verify** `openvpn --version`; connect once via the header indicator and
watch the progress stream; `cargo test --manifest-path src-tauri/Cargo.toml openvpn`.

---

## 9. OpenSSH, SFTP, rsync, git

**Where** `services/remote.rs`, `ssh_common.rs`, `ssh_exec.rs`, `sftp.rs`
(`openssh-sftp-client` crate), `remote_credentials.rs`, `remote_sync.rs`,
`worker_sync.rs`, `git_peer.rs`, `docs/context/remote_credentials.md`,
`docs/context/git_sync.md`.

**Assumes**

- `-o ControlMaster=auto -o ControlPath=<state>/ssh-control/cm-<hash>
  -o ControlPersist=… -o ServerAliveInterval/CountMax`; `SSH_ASKPASS` +
  `SSH_ASKPASS_REQUIRE=force` (OpenSSH **≥ 8.4**) for passwords on Unix,
  `sshpass -e` on Windows; OpenSSH re-asks a rejected passphrase three times.
- `ssh-keygen -F/-l/-lf -/-t ed25519`, `ssh-keyscan` for host keys.
- rsync present on **both** ends for the bulk fast path (`rsync >/dev/null
  && echo eldrun-rsync-yes`), pull-only.
- `git bundle create … --not …` and git's literal refusal text; `-c
  core.hooksPath=` suppresses hooks (verified against git 2.53.0);
  `GIT_OPTIONAL_LOCKS=0`.
- `keyring` crate → Secret Service / KWallet / keyutils / Windows Credential
  Manager / macOS Keychain; a locked keyring answers within 4 s or shows amber.

**Verify** `ssh -V; rsync --version | head -1; git --version`;
`cargo test --manifest-path src-tauri/Cargo.toml remote`; connect a remote
project and run the lockstep matrix (`docs/git_lockstep_case_matrix.md`).

---

## 10. GPU tooling, SLURM, HPC probes

**Where** `src-tauri/src/gpustat.rs`, `sysstat.rs`, `services/remote_usage.rs`,
`commands/slurm.rs`, `src/lib/slurm.ts`, `services/hpc_mode.rs`,
`docs/context/hpc_careful_mode.md`.

**Assumes**

- `nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,
  temperature.gpu,power.draw,power.limit,clocks.sm,clocks.mem,fan.speed,
  driver_version,pcie.link.gen.current,pcie.link.width.current
  --format=csv,noheader,nounits` and `--query-compute-apps=pid,process_name,
  used_memory`; `[N/A]` cells; the same parser runs on remote hosts.
- AMD/Intel via `/sys/class/drm/card*` and `/sys/class/hwmon/hwmon*`;
  `/proc/{stat,meminfo,loadavg,uptime}`; `ps -eo user,pid,pcpu,pmem,comm`.
- SLURM: `squeue --me --noheader -o '%i %j %T %M %R'` (falls back to `-u`),
  `scontrol show job <id>`, `sbatch`, `scancel`, `srun --pty … bash -l`;
  `command -v sbatch` to classify a host; the literal `sbatch: error: Batch
  job submission failed` text.

**Verify** `nvidia-smi --query-gpu=… --format=csv` on the driver in question;
`squeue --version` on the cluster; `cargo test --manifest-path
src-tauri/Cargo.toml -- gpustat slurm`.

---

## 11. TeX toolchain

**Where** `commands/tex.rs`, `commands/synctex.rs`, `src/lib/texPdfLink.ts`,
`src/lib/viewers/*`, `docs/context` (none) — see `src-tauri/CLAUDE.md`.

**Assumes** `latexmk` argv per engine (pdflatex/xelatex/lualatex, shell-escape
opt-in), `bibtex`/`biber` reruns, `kpsewhich`, the `.synctex(.gz)` record
format (`Input:` mid-file, `72/72.27` sp→bp; LuaTeX + `luaotfload` tag
artefacts; beamer `\end{frame}` runs), `synctex edit` CLI as fallback, and
`pdfjs-dist` **≥ 6.x** for beamer shadows (below 6, black bars).

**Verify** `latexmk --version; synctex help`; `cargo run --example
synctex_probe --manifest-path src-tauri/Cargo.toml`; compile a beamer deck
after any TeX Live / pdf.js bump.

---

## 12. Mail servers (IMAP/SMTP)

**Where** `services/mail_engine.rs` (`async-imap`, `mail-send`, `mail-parser`,
`rustls-platform-verifier`), `mail_authres.rs`, `mail_sanitize.rs`
(`ammonia`), `docs/context/mail_encryption.md`, `docs/mail_qa_gmail.md`.

**Assumes** IMAP `IDLE`, `MOVE`, folder listing; Gmail's `[Gmail]/All Mail`,
`[Gmail]/Entwürfe` (modified-UTF-7 names) and app-password login (no OAuth);
`Authentication-Results` header grammar for the DKIM/SPF lamps; provider TLS
certs validated by the platform verifier. Rust crates own the protocol — an
`async-imap` / `rustls` major bump is the real risk.

**Verify** `cargo run --example mail_probe --manifest-path src-tauri/Cargo.toml`
against a test account, then the `docs/mail_qa_gmail.md` checklist;
`cargo test --manifest-path src-tauri/Cargo.toml mail_`.

---

## 13. CalDAV servers

**Where** `services/caldav.rs`, `commands/caldav.rs`, `src/lib/caldav*.ts`,
`docs/context/caldav.md`.

**Assumes** RFC 4791/6578 REPORT bodies, `/.well-known/caldav` discovery,
Radicale path-only hrefs, SOGo's namespace-prefix pickiness, merge-by-resource-URL
sync. A server upgrade (Nextcloud, Radicale, SOGo, iCloud) can change href
shape or ctag/sync-token behaviour.

**Verify** sync against the server in question, then `cargo test
--manifest-path src-tauri/Cargo.toml caldav`.

---

## 14. Desktop shells and host tools

**Where** `src-tauri/src/platform/{x11,wayland_kde,windows,macos,null}.rs`,
`commands/{default_apps,apps,workspace,screenshot,printing,clipboard,format}.rs`.

**Assumes**

- KDE: DBus `org.kde.KWin` scripting + `org.kde.KWin.VirtualDesktopManager`,
  `org.kde.plasmashell`; `workspace.*` JS API inside KWin scripts (Plasma 6
  renamed several members once already).
- Cinnamon/Muffin: `gsettings` schemas `org.cinnamon.desktop.wm.preferences`,
  `org.cinnamon.muffin`; X11 EWMH atoms `_NET_CLIENT_LIST(_STACKING)`,
  `_NET_WM_DESKTOP`, `_NET_CURRENT_DESKTOP`, `_NET_NUMBER_OF_DESKTOPS`,
  `_NET_WM_PID`, `_NET_WM_NAME`; `XDG_CURRENT_DESKTOP`, `XDG_DATA_{HOME,DIRS}`.
- Default apps: `xdg-mime query/default`; app launch via `.desktop` files.
- Screenshots: `spectacle | flameshot | gnome-screenshot | scrot | maim | grim |
  import`, `screencapture` (macOS), PowerShell (Windows) — first one found wins.
- Printing: `lp`, `lpstat` (CUPS). Clipboard: `arboard` with
  `wayland-data-control`. Formatters: `prettier`, `rustfmt`, `black`, `gofmt`.
- Power: `systemctl`, `starship-battery`; network: `ss`.

**Verify** after a desktop-environment upgrade: switch projects and confirm the
workspace follows; run `xprop` on the window (see
`memory: project_xprop_window_debug`); take a screenshot from the tab menu.

---

## 15. Git hosting CLIs

**Where** `commands/git_hosting.rs`, `git_fork.rs`, `git_publish.rs`,
`services/git_credentials.rs`.

**Assumes** `gh auth login/status`, `gh api`, `gh repo create`; `glab auth
login`, `glab api`, `glab repo create/edit`; the login-status text each
prints (parsed to learn the account); token env vars honoured by each CLI.

**Verify** `gh --version; glab --version`; publish a throwaway repo.

---

## 16. Python environment tooling

**Where** `commands/python.rs`, `src/lib/pythonRun.ts`.

**Assumes** `conda env list` output shape (`#` comments, `name  prefix`),
`poetry env info`, active venv detection; interpreter precedence is ranked in
the backend only. `uv`, `pixi`, `pyenv` are not ranked — a user on those sees
the system interpreter.

**Verify** `conda env list; poetry --version`; `cargo test --manifest-path
src-tauri/Cargo.toml python`.

---

## 17. Spell dictionaries

**Where** `services/spell.rs` (`spellbook` crate), `commands/spell.rs`,
`src/lib/spellDictionaries.ts`.

**Assumes** `https://raw.githubusercontent.com/wooorm/dictionaries/main/
dictionaries/<code>/index.{aff,dic}` layout and Hunspell locale codes
(`hunspellToBcp47`); LibreOffice-style `.aff/.dic` pairs.

**Verify** fetch one dictionary from the UI after a `wooorm/dictionaries`
restructure or a `spellbook` bump.

---

## 18. Agent Skills

**Where** `services/skills.rs`, `commands/skills.rs`, `src/lib/skills.ts`,
`docs/skills_plan.md`.

**Assumes** the `SKILL.md` frontmatter (`name`, `description`), install
target `.claude/skills/<name>/`, catalog source
`https://github.com/anthropics/skills` (cloned). Other agents' skill dirs are
not written.

**Verify** import one skill from the catalog after an upstream spec change;
`cargo test --manifest-path src-tauri/Cargo.toml skills`.

---

## 19. Runtime and dependency floors

| Dependency | Pinned / floor | Why it is load-bearing |
|------------|----------------|------------------------|
| WebKitGTK | 2.52 observed | no renderer-pid API (watchdog probes instead); scrollbar built once; DMABUF off (flicker + SIGBUS) |
| Tauri / wry / plugins | `^2` | IPC fallback path evaluates PDF bytes as script — keep the custom protocol |
| `@xterm/xterm` + addons | `^5.5`, webgl `^0.18` | key encodings (`ESC [ Z`, CSI-u) the mobile bridge relies on |
| `pdfjs-dist` | `^6.3` (floor 6.0) | beamer shadow compositing |
| `portable-pty` | 0.9 | PTY registry / reconnect |
| `keyring` | 3 | platform credential stores |
| `async-imap`, `mail-send`, `mail-parser`, `rustls` 0.23 | see `Cargo.toml` | mail protocol + TLS |
| `openssh-sftp-client` | 0.15 | SFTP over the ControlMaster |
| `zbus`, `xcb` | — | DBus/X11 desktop integration |
| `spellbook` | 0.4 | Hunspell-compatible checker |
| `mermaid`, `katex` | `^11`, `^0.17` | markdown viewers |

On a bump: `npm run build && npm test`, `cargo test`, `cargo clippy
--all-targets -- -D warnings` (CI uses *today's* stable — `rustup update`
first), then `npm run package:dev` and click through the viewers.

---

## 20. Eldrun's own updater

**Where** `services/app_update.rs`, `commands/app_update.rs`.

**Assumes** `https://api.github.com/repos/fseiffarth/ProjectEldrun/releases/latest`
(unauthenticated, rate-limited), asset names
`eldrun_<v>_amd64.AppImage`, `Eldrun_<v>_x64-setup.exe`, `.dmg`, `.deb`,
download only from `https://github.com/fseiffarth/ProjectEldrun/releases/download/`.
A GitHub API or release-naming change breaks the update banner.

**Verify** `curl -s https://api.github.com/repos/fseiffarth/ProjectEldrun/releases/latest | jq '.assets[].name'`.

---

## 21. Quick routine after any update

```sh
rustup update && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run build && npm test && npm run lint
cargo run --example ollama_probe --manifest-path src-tauri/Cargo.toml   # if Ollama moved
tmux -V; bwrap --version; docker --version; tailscale version; ssh -V; git --version
for a in claude codex gemini qwen vibe opencode copilot; do command -v $a >/dev/null && $a --version; done
```

Then, in a window the user launched: one agent tab per updated CLI (prompt →
decision lamp → resume after relaunch), one Ollama-backed tab, the phone's
status sheet, and a project switch on the desktop in question. Record the
verified versions in the code comments named above.
