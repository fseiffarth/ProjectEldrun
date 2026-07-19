## Group G — Remote / SSH & Containerized Projects (work axes)
*Files: `src-tauri/src/schema/project.rs` (project model is local-only:
`directory` is a local path, no host/remote/container fields), `services/project_runtime.rs`,
`services/ssh_mount.rs` (mount lifecycle — the pattern for container lifecycle),
`terminal/` (PTY cwd / exec target), `commands/projects.rs` (create/import),
`commands/ssh.rs`, file-tree commands. These items share a theme: a **work
axis** — *where the project's process and files live* (host, SSH remote, or
container) — as opposed to the git **push** axis (#21/#22).*

28. ✅ **SSH-based projects (remote path, remote agent).** Implemented via an
    **sshfs mount**: a remote project's bytes live on `host:remote_path` and are
    mounted to `~/.local/share/eldrun/mounts/<project-id>/`; the project's
    `directory` points at that mountpoint so the file tree, terminal cwd, and git
    keep working unchanged. New `RemoteSpec` (`user?`, `host`, `port?`,
    `remote_path`) on the project schema + `projects.json` `extra`. New
    `commands/ssh.rs` (`ssh_connect`, `ssh_default_dir`, `ssh_list_dir`,
    `ensure_project_mounted`) shells out to system `ssh` in `BatchMode=yes`
    (keys/agent/`~/.ssh/config` are the source of truth; no in-app passwords).
    New `services/ssh_mount.rs` handles mount/unmount lifecycle (idempotent
    mount, `/proc/mounts` check, `fusermount -u` with `umount` fallback,
    sshfs-missing guard, unmount-all on app exit). `create_project`/
    `import_project` accept an optional `remote` and scaffold over the mount
    (remote import is `keep`-only). `ProjectSwitcher.tsx` add/import dialog gains an
    SSH-address field + Connect and an in-app remote folder browser. Active
    remote project is mounted on startup (best-effort, non-blocking) and on
    switch. Requires `sshfs`/FUSE locally. **Runtime QA pending** (agents can't
    launch Eldrun); password/interactive auth out of scope for v1;
    project-removal unmount is a follow-up (no delete command exists yet — stale
    mounts are cleaned up on next app exit). See `docs/ssh_projects_plan.md`.
    - *Test (e.g.):* add a project via SSH address against a key-auth host
      → folder browser lists the remote dir, the project mounts under
      `mounts/<id>/`, terminal cwd + file tree work on the remote files, and the
      mount is cleaned up on app exit.
    - [x] 🤖 Automated test — `services/ssh_mount.rs` unit tests (validate_arg, mountpoint_for, sshfs_args)
    - [ ] 🖐️ Manual test
    - **Manual QA checklist (live, step-by-step).** Runtime test plan for
      #28/#28b — agents can't launch Eldrun, so these are hand-checks. Each box is
      one check; a phase is done when all its boxes are ticked.
      - *Phase 0 — prerequisites / baseline.*
        - [ ] Local tooling on `PATH`: `sshfs`, `fusermount` (or `umount`); for
          password auth `sshpass`; for VPN-gated hosts `openvpn` + `pkexec`.
        - [ ] A reachable host with working key/agent auth; ideally a second
          host/account that requires a **password** (no key) to exercise `sshpass`.
        - [ ] `cargo test --manifest-path src-tauri/Cargo.toml` green.
        - [ ] `npx tsc --noEmit` green.
      - *Phase 1 — connect (`ssh_connect`/`ssh_default_dir`).*
        - [ ] Tick **Remote (SSH) project** → SSH address + password + Connect
          section appears.
        - [ ] `user@host` (key auth, blank password) → Connect succeeds.
        - [ ] `user@host:port` with a non-default port → Connect succeeds.
        - [ ] Bare `host` (no user, via `~/.ssh/config`) → Connect succeeds.
        - [ ] Password-only host + correct password → Connect succeeds (`sshpass`).
        - [ ] Wrong password → clear ssh-stderr error, no hang.
        - [ ] Password auth with `sshpass` not installed → actionable error.
        - [ ] Unreachable host/bad name → fails within ~10s (ConnectTimeout), UI
          stays responsive.
        - [ ] Editing the address/password after connect resets to disconnected.
      - *Phase 2 — browse (`ssh_default_dir`/`ssh_list_dir`).*
        - [ ] Browser opens at remote `$HOME`.
        - [ ] Dirs-first, case-insensitive name sort; hidden entries shown;
          `.`/`..` hidden.
        - [ ] Click a dir descends; **Up** ascends; can't go above `/`.
        - [ ] Dir names with spaces/unicode render correctly.
        - [ ] No-permission directory → error surfaced, dialog stays usable.
        - [ ] "Use this folder" commits the chosen remote path.
      - *Phase 3 — create remote project.*
        - [ ] Connect → browse → Use folder → Create → project created with a
          generated id.
        - [ ] Mounted under `~/.local/share/eldrun/mounts/<id>/`; `directory`
          points at the mountpoint (check `/proc/mounts`).
        - [ ] Scaffold files written **over the mount** only where missing.
        - [ ] `project.json` carries `remote`; `projects.json` entry mirrors it
          under `extra`.
        - [ ] Create against a password-only host → confirm mount behavior /
          error (mount path still `BatchMode=yes`; see 28c password half-state).
      - *Phase 4 — import remote project.*
        - [ ] Import an existing remote dir (keep-only) → mounts, persists
          `remote`, does not relocate bytes.
        - [ ] Scaffold-fill agent tabs are local-disk-only on remote import.
      - *Phase 5 — mount lifecycle.*
        - [ ] Switch away and back → mount persists / re-mount is a no-op.
        - [ ] Restart with a remote project active → startup best-effort mount;
          an offline host at boot does **not** block app start.
        - [ ] Quit → `unmount_all` tears down every mount (`/proc/mounts` clean).
        - [ ] Hard-kill leaving a stale mount → relaunch reuses it without error.
        - [ ] Host offline mid-session → reconnect/keepalive recovers; no
          permanent wedge.
      - *Phase 6 — behaves like local (over the mount).*
        - [ ] File tree lists remote files.
        - [ ] Open/edit/save a file → change lands on the remote.
        - [ ] Git status/history work against the mountpoint.
        - [ ] Plain shell tab cwd/behavior as expected (see Phase 7).
      - *Phase 7 — remote agent execution (`ssh_exec.rs`).*
        - [ ] Claude agent tab runs **on the remote** via `ssh -tt` (verify
          hostname/env inside the agent).
        - [ ] Resize resizes the remote PTY; exit/kill ends the remote session.
        - [ ] Second tab multiplexes over the ControlMaster socket; master
          persists ~600s after the last session.
        - [ ] Userspace CLI (`~/.local/bin`/nvm/pyenv) is found (login-shell PATH).
        - [ ] Auto-bootstrap (probe → install → re-probe; `exit 127` + hint on
          failure) runs live in the PTY on a remote missing the CLI.
        - [ ] First-run `claude login` works inside the remote PTY.
        - [ ] Local `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is **stripped** from the
          remote env (remote's own login used).
        - [ ] `local_only` tabs (local Ollama) are **not** wrapped — run locally.
        - [ ] Codex/Gemini/Vibe remote tabs — note current behavior (recipes may
          not be generalized yet).
      - *Phase 8 — OpenVPN-gated hosts.*
        - [ ] Project with `remote.openvpn.config` → tunnel comes up first; VPN
          password prompted and **never persisted**.
        - [ ] `openvpn_status` detects an already-up tunnel (no double-connect).
        - [ ] Missing `openvpn`/`pkexec` → actionable error.
        - [ ] Quit → `disconnect_all` brings tunnels down.
      - *Phase 9 — security / argument injection (spot-check; mostly auto).*
        - [ ] UI can't send a host/user/path beginning with `-` to ssh.
        - [ ] Control chars / newline / NUL in any field rejected.
        - [ ] Empty host (or empty user when provided) rejected.
        - [ ] During a password connect, the password is only in the `SSHPASS`
          env, never in argv (inspect the process list).
      - *Phase 10 — persistence & restart.*
        - [ ] Resumable Claude/Codex tabs in a remote project restore and resume
          on the remote on relaunch.
        - [ ] `project.json`/`projects.json` round-trip `remote` across restart.
    - **28b — Remote agent execution (decided 2026-06-19: agents run ON the
      remote).** A remote project's bytes are sshfs-mounted **only** for
      Eldrun's own file tree / git / `list_dir`; terminal **and agent** tabs
      instead run on the remote host via `ssh -tt`. `services/ssh_exec.rs`
      (`wrap_pty_options`) rewrites any spawn whose cwd is under the mounts root
      into `ssh -tt [-p port] [user@]host '<remote_command>'`, multiplexed over a
      ControlMaster socket; `remote_subdir` maps the local mount cwd back to the
      remote path and `remote_command` builds `cd <dir> && export … && exec
      <cli> …`. VPN-gated hosts bring an OpenVPN tunnel up first via
      `services/openvpn.rs` (pkexec + askpass temp file + ready-marker wait,
      disconnect-all on exit) when `RemoteSpec.openvpn` is set. Rationale and the
      rejected alternatives (local-CLI-over-sshfs; per-command `ssh host -- …`
      helper) are in `docs/ssh_projects_plan.md` → *Remote execution model*. This
      makes a **userspace** agent-CLI install on the remote load-bearing; the
      items below close the gaps.
      - [x] **Login-shell PATH for agent tabs.** `remote_command` now runs agent
        tabs through `exec "${SHELL:-/bin/bash}" -lc '<quoted cli + args>'` (was a
        bare `exec '<cli>'` under ssh's non-login shell), so a userspace
        `~/.local/bin`/nvm/pyenv CLI is on PATH and resolves. Shell tabs keep
        `$SHELL -l`.
        - [x] 🤖 Automated test — `remote_command_agent_runs_under_login_shell`
          asserts the `-lc` login-shell wrap with correct single-quoting
      - [x] **Auto-bootstrap + detect the remote CLI.** Implemented in new
        `services/remote_agents.rs` (recipe table keyed by agent base name:
        probe `bin`, userspace `install`, manual hint). Rather than a separate
        command, `bootstrap_prelude` is **folded into** `remote_command`'s
        `$SHELL -lc` script for recognised agents: it probes
        `command -v <bin>`, runs the userspace installer if missing
        (claude → `npm install -g @anthropic-ai/claude-code`), re-probes, and
        `exit 127`s with a manual hint on failure — all live in the PTY, so
        install progress and the first-run `login` show in the terminal. Unknown
        commands get no prelude. (Chose PTY-folded over a Tauri
        `ensure_remote_agent` command: no event plumbing, fully unit-testable.)
        - [x] 🤖 Automated test — `remote_agents` (`recipe_for` base-name match,
          `bootstrap_prelude` probe/install/abort) + `ssh_exec`
          `remote_command_agent_bootstraps_known_cli`
      - [x] **Remote auth = the remote's own login.** Decided: the remote `claude`
        authenticates with its own `~/.claude` credentials; the first run prompts
        an interactive `claude login` in the PTY (works because agent tabs get a
        real `-tt` PTY). `remote_command` now strips agent-auth env vars
        (`AGENT_AUTH_ENV`: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
        `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
        `GOOGLE_API_KEY`) from the exported env so a local key can't clobber the
        remote session.
        - [x] 🤖 Automated test — `remote_command_strips_agent_auth_env` asserts
          auth vars (and their values) are excluded while ordinary env is kept
      - [ ] **Generalize bootstrap/detect to other agent CLIs** (Codex, Gemini,
        Vibe): add one `AgentRecipe` row per agent to `remote_agents::RECIPES`
        (the framework + claude recipe already ship); keep honoring the existing
        `local_only` flag (local Ollama agents are never wrapped).
      - [ ] 🖐️ Manual test — connect (VPN if needed) → open a remote agent tab →
        the CLI is detected/installed, logs in on first run, and runs a pipeline
        on the remote (remote GPU/env), with edits visible in Eldrun's file tree.
    - **28c — Hardening & gaps (two-reviewer review, 2026-06-19).** A
      code-correctness/security pass plus an architecture pass over #28/#28b.
      Ordered by severity.
      - [ ] **[Critical] Remote command injection in the browse commands.**
        `ssh_list_dir`/`ssh_default_dir`/`ssh_connect` (`commands/ssh.rs`) hand
        remote argv tokens to `ssh`, which space-joins them into one remote
        `$SHELL -c` string; `validate_arg` only blocks a leading `-`/control
        chars, so a `path` containing `;`/`$()`/backticks/spaces (e.g. a remote
        dir name the user clicks while browsing) runs arbitrary remote code.
        Route these through a shared `shell_quote` (lift from `ssh_exec`) and
        send a single pre-quoted remote string; add injection tests (`;`, `$()`,
        backtick, space, quote).
      - [ ] **[Critical] Remote agent tabs never resume (ordering bug).**
        `wrap_pty_options` rewrites `opts.cmd` `claude`/`codex`→`ssh`
        (`commands/terminal.rs`) *before* `spawn_pty`'s `resolve_agent_session`
        dispatches on `opts.cmd` (`terminal/mod.rs`), so `--resume`/`codex
        resume` are never injected; the ELDRUN_TAB_UID + SessionStart mechanism
        is also local-only (it reads the local `~/.claude`/live_sessions while a
        remote agent logs on the remote). Resolve session args *before* the
        ssh-exec rewrite and embed them in `remote_command`, and install the
        SessionStart hook + live-id lookup on the remote — or document remote
        agents as non-resumable for now.
      - [ ] **[High] Serialize `mount()` per project id.** The
        `is_mounted`→`sshfs` sequence in `ssh_mount::mount` is TOCTOU and
        `ensure_project_mounted` runs from several call sites concurrently, so
        two activations can stack FUSE mounts (the second shadows the first;
        `unmount` removes only one → leak). Guard with a per-id global mutex and
        re-verify `is_mounted` after `sshfs`.
      - [ ] **[High] Validate exported env in `remote_command`.** Env keys are
        interpolated raw into `export {k}=…` (`ssh_exec.rs`); a key containing
        `=`/space/newline injects a second `&&` command. Require keys to match
        `^[A-Za-z_][A-Za-z0-9_]*$` and reject NUL in any quoted value; test a
        malicious key.
      - [ ] **[High] Centralize VPN-gated activation ordering.** The backend
        mount path (`project_runtime::ensure_remote_mounted`,
        `ensure_project_mounted`) never calls `openvpn::connect` — only the
        frontend does — so switching to a VPN-gated project from the backend
        fails with an opaque ssh timeout. One entry point should do VPN-connect →
        mount → exec and fail loudly ("VPN not connected — use Connect in the
        dialog"), since the backend can't prompt for the password.
      - [ ] **[High] Resolve the password-auth half-state.** `ssh_mount`/
        `ssh_exec` hardcode `BatchMode=yes`, so a password-only host browses in
        the dialog but then fails at mount/exec. Either thread the password via
        `sshpass`/`SSHPASS` (as `commands/ssh.rs` already does for browse) or
        gate remote create/import on key/agent auth and mark password hosts
        browse-only — don't ship the silent half-state.
      - [ ] **[High] Connection-loss / stale-handle recovery + UX.** sshfs
        `reconnect` doesn't heal a stale FUSE handle (`is_mounted` still returns
        true → `mount()` no-ops), and exec tabs die silently. Treat a statfs
        failure on a mounted path as not-mounted so `mount()` remounts; add a
        reconnect/remount action and a connection-state badge on remote project
        pills.
      - [ ] **[Medium] OpenVPN robustness.** (a) `wait_for_ready` only checks the
        timeout when a new stdout line arrives, so a silent hang (stuck auth /
        black-hole) blocks `connect` forever — read on a thread with
        `recv_timeout`. (b) `is_connected` tracks only tunnels this process
        started, so a tunnel surviving a crash isn't detected and `connect`
        spawns a duplicate / `pkexec` re-prompts — reconcile via the pidfile/tun
        device. (c) teardown via `pkexec kill` re-prompts polkit at exit, so the
        root tunnel can survive app exit — launch once with a teardown trap or a
        persistent privileged helper.
      - [ ] **[Medium] Mount-detection edge cases.** Unescape `/proc/mounts`
        octal sequences (`\040` etc.) and canonicalize before comparing in
        `is_mounted` (refactor the field parsing into a pure, unit-tested fn) to
        avoid stacking/leaks when the state-dir path contains spaces; treat
        `Some(port) == 0` as "no port"; bound/short-hash the ControlPath so it
        stays under the AF_UNIX 108-byte limit.
      - [ ] **[Medium] Host-key (TOFU) trust UX.** Browse/mount use
        `BatchMode=yes`, which *fails* on an unknown host key with no prompt,
        while the exec path drops BatchMode to prompt in-terminal — but that's
        only reached after a mount that already failed. Add an explicit
        `ssh-keyscan`/known_hosts confirmation step in the connect flow.
      - [ ] **[Medium] Project-delete teardown + startup GC.** When a delete
        command lands, `unmount` + remove the mountpoint dir + `ssh -O exit` the
        control master + `openvpn::disconnect` if unused; add startup GC of stale
        mounts (ties into the stale-handle fix above).
      - [ ] **[Medium] Generalization auth stories (extends the open item in
        #28b).** Adding Codex/Gemini recipes is one `AgentRecipe` row each (npm:
        `@openai/codex`, `@google/gemini-cli`); Vibe likely needs a
        `manual_hint`-only entry. Each needs a documented remote-auth story, and
        verify `local_only` is actually set end-to-end for Ollama-backed tabs.
      - [ ] **[Low] Smaller items.** Replace `which`-based binary detection
        (`sshfs`/`sshpass`/`openvpn`) with in-process PATH search; lazy-unmount
        (`-z`) as a last resort at exit; feed the askpass passphrase to OpenVPN
        via stdin/fd instead of a 0600 temp file (plaintext currently survives a
        crash); document `parse_ls_output` symlink-vs-dir `-p` semantics.
      - [ ] 🤖 **Test coverage to add** — injection-safety of the browse `path`;
        malicious env keys in `remote_command`; a pure `/proc/mounts` field
        parser (`\040`); `wait_for_ready` timeout with no output; mount
        double-spawn; `shell_quote` round-trip incl. NUL/newline.
      - **Refactor / future ideas.**
        - [ ] **Factor a target-agnostic spawn-rewrite layer (only load-bearing
          at #38f, remote Docker).** `ssh_exec::wrap_pty_options` hardcodes
          mount-path detection, `AGENT_AUTH_ENV`, `shell_quote`, the `-lc`
          login wrap, and the `remote_agents` bootstrap. #38's v2 shape
          (local project containers, `services/sandbox.rs`) needs none of
          this — `pty_spawn` keeps its plain two-way dispatch. This refactor
          only earns its cost once #38f composes a container spawn-rewrite
          with SSH's (`ssh … docker exec …`). Extract a trait ("PtyOptions +
          target descriptor → rewritten argv") with SSH and
          Docker impls so the resume fix, the recipes, and Phase-2 composition
          (`ssh … docker exec …`) land once.
        - [ ] **Document the split-model consistency tradeoffs.** git/`list_dir`/
          file-tree run locally over sshfs while the agent edits on the remote:
          slow git, weak sshfs inotify (stale tree), line-ending/identity
          mismatches. Document the model; consider running `git` on the remote
          via the exec wrapper; add a manual "refresh file tree" affordance.
        - [ ] **SSH `LocalForward` per project** to reach remote dev-server ports
          at `localhost:port`.
        - [ ] **Remote-status panel** (mount state, control-master liveness, VPN
          state, last error) for debuggability.

38. **Widen the Docker sandbox into a full project container.** ~~Run projects
    inside Docker containers~~ — **superseded 2026-07-13: this is now an
    evolution of the shipped agent sandbox (`services/sandbox.rs`), not a
    second containerization feature.** There is exactly one such feature.
    Full plan (v2): `docs/docker_projects_plan.md`. **Implemented 2026-07-13
    (38a–38e; 38f stays deferred; manual/live Docker QA pending — see the
    plan's runtime checklist).** The `DockerSpec` /
    `docker_runtime.rs` / `docker_exec.rs` / `commands/docker.rs` design
    below (dated 2026-06-19) is **superseded** — kept struck through for
    history, do not implement it as written:

    ~~Let a project be started in a Docker container instead of (or in
    addition to) directly on the host: the project's terminal/agent tabs run
    via `docker exec` into a container, with the project directory
    bind-mounted as the working dir so the file tree and git keep working.
    Mirrors the two-mechanism split the SSH axis (#28) settled on — a
    lifecycle service `services/docker_runtime.rs` (cf. `ssh_mount.rs`) and a
    spawn-rewrite service `services/docker_exec.rs` (cf. `ssh_exec.rs`).~~

    **v2 shape.** The existing per-tab ephemeral sandbox (`SandboxSpec`,
    `services::sandbox`) grows into a per-project, session-lived container:
    same toggle, same `SandboxSpec` (gains `dockerfile`), same `sandbox` key
    in `project.json`/`projects.json` `extra` — already-toggled projects
    upgrade in place, no migration, no new schema/`DockerSpec`. Mounts stay
    at their **identical host path** (not `/workspace` — keeps agent session
    resume valid), so the v1 `container_workdir` translation layer, the
    `ContainerSource` enum, `run_args`, and `engine` (podman) are all dropped
    for v1. `services/sandbox.rs` gains the lifecycle half itself
    (`up`/`down`/`down_all`/`sweep_orphans`, `eldrun-<project-id>` naming +
    `eldrun.owner`/`eldrun.spec-hash` labels, mirroring `services/remote.rs`'s
    per-project connection lifecycle) instead of a new `docker_runtime.rs`;
    `wrap_pty_options_docker` becomes run-once-then-exec-per-tab instead of a
    new `docker_exec.rs`; no new `commands/docker.rs`. `pty_spawn`'s existing
    two-way dispatch (sandbox else ssh, `commands/terminal.rs:116-136`) is
    unchanged — no third rewriter.

    - [x] **38a — Phase 0: fix the shipped sandbox** (independently
      shippable, lands first because the lifecycle rewrite touches the same
      lines): preflight daemon-down vs image-missing misdiagnosis; toggle
      preserves existing `SandboxSpec` fields instead of resetting to
      default; `--init` + `eldrun.owner`/`eldrun.project` labels on every
      container; hide/disable the toggle in the Windows UI (backend already
      refuses, #86).
    - [x] **38b — Phase 1: container lifecycle.** `up`/`down`/`down_all`/
      `sweep_orphans` in `services/sandbox.rs`; three-state machine
      (running+fingerprint-match → no-op; stopped/mismatch → recreate;
      missing → create) keyed on a `spec_fingerprint` label; mount/hardening
      code reused from today's per-tab path, moved to the create step;
      staged hook-registration copies become per-project
      (`sandbox-stage/<project-id>/`), refreshed at each `up` (fixes today's
      per-tab stage-dir leak).
    - [x] **38c — Phase 2: run → exec + tab-kill contract.**
      `wrap_pty_options_docker` resolves the container via `up()` then
      rewrites to `docker exec`; per-tab env (incl. `host_auth_env`) moves to
      the exec step. Docker does not kill an exec'd process when the exec
      client dies, so tab close needs an explicit kill path (pidfile wrapper
      + `docker exec <name> kill …` on the PtyRegistry kill, containerized
      tabs only) — required, not optional, once tabs share one long-lived
      container.
    - [x] **38d — Phase 3: wiring + frontend scope widen.**
      `project_runtime::switch` calls `up`/`down` on activate/deactivate
      (worker thread, never main — cf. the remote sync-command freeze
      lesson); `lib.rs` exit hook calls `down_all()`, startup calls
      `sweep_orphans()`; `CenterPanel.tsx`'s per-tab gate widens from
      `tab.kind === "agent"` to any non-`local_only` tab of a toggled
      project; `ProjectPill.tsx` label becomes "Run this project in a
      container". Flag stays in `TerminalView`'s spawn-effect deps, so
      toggling still respawns live tabs — Gemini/Vibe lose their
      conversation on flip, same hazard class as `tabs/agentModes.ts`.
    - [x] **38e — Phase 4: spec sources & UX.** Auto-detect an in-repo
      `Dockerfile`/`.devcontainer/devcontainer.json` as the container source;
      fall back to the existing `eldrun-agent-sandbox:latest` reference
      image; preflight's "image missing" error becomes a one-click
      open-new-tab-paste-run build flow (house convention); minimal spec UI
      for image/network/memory/cpus/readonly (safe now that 38a makes the
      toggle spec-preserving).
    - [ ] **38f — Phase 5 (deferred): compose / pre-existing-container
      variants, persistent (non-session-scoped) containers, remote Docker
      (container on an SSH host, composing with #28's `ssh_exec` wrapping —
      this is where the target-agnostic spawn-rewrite refactor below
      actually becomes load-bearing), Windows (#86).**
    - [x] 🤖 Automated test — see `docs/docker_projects_plan.md` Tests
      section (argv/state-machine assertions, no daemon needed): sandbox.rs
      unit suite (name/fingerprint/up-decision/create+exec argv/stage refresh)
      + `projects_commands.rs` toggle-preservation/legacy-spec tests
    - [ ] 🖐️ Manual test

80. **Native SFTP remote browsing (drop `ssh ls` for the folder picker).**
    Replace the shell-out browse commands in `commands/ssh.rs`
    (`ssh_list_dir`, `ssh_default_dir`) with an in-process **SFTP** client, so
    the new/import dialog's remote folder picker no longer parses `ls` text and
    no longer feeds user-controlled paths to a remote `$SHELL -c`. This is the
    JetBrains *Deployment*-style model (in-process SFTP browse), and it
    **supersedes** the #28c "[Critical] Remote command injection in the browse
    commands" item — SFTP is a binary protocol, so paths are never
    shell-interpreted and `shell_quote`/`validate_arg` are no longer load-bearing
    for browsing. **Scope is browsing only:** the project *mount* still uses
    sshfs (kernel FUSE is unavoidable for a local mountpoint regardless of
    language — see the install-helper work), and remote *agent/terminal* exec
    still uses `ssh -tt` (#28b). Nothing here changes the mount or exec paths.
    - **Library: `openssh-sftp-client`** (rides the system `ssh` ControlMaster).
      Chosen over `russh-sftp` (pure-Rust but reimplements auth/known_hosts) and
      `ssh2`/libssh2 (C + openssl build dep) because it reuses the user's
      `~/.ssh/config`/agent/keys — the "source of truth" the existing `ssh.rs`
      already commits to — and keeps a single auth story shared with mount/exec.
    - **Prototype steps.** ✅ **Code-complete (🤖 covered; 🖐️ live QA pending)** —
      built over `openssh-sftp-client` driving a child `ssh -s sftp` over its
      pipes (no `openssh` ControlMaster crate needed); the password-arg builder
      was lifted to `services::ssh_mount::ssh_password_base_args` so browse +
      SFTP share one validated auth path.
      - [x] **80a — Dep + thin `services/sftp.rs` session helper.** ✅ Done.
        `open_session(user, host, port, password)` spawns `ssh`/`sshpass -e ssh`
        with the shared base args, splices `-s <target> sftp`, and hands the
        child's stdin/stdout to `Sftp::new`. Keeps the `validate_arg` guard on
        `path` as defense in depth. (Drove the design: chose raw-pipe `Sftp::new`
        over the `openssh`-feature `from_session` so no ControlMaster crate is
        pulled in; `ReadDir` is `!Unpin` → `Box::pin` to drive the stream.)
      - [x] **80b — `ssh_default_dir` over SFTP.** ✅ Done. `fs.canonicalize(".")`
        (SFTP REALPATH) — no remote `pwd`.
      - [x] **80c — `ssh_list_dir` over SFTP.** ✅ Done. `open_dir` + drain the
        `ReadDir` stream, `is_dir` from SFTP `file_type()`; reuses the
        dirs-first/ci sort + dot-filter via pure `finalize_entries`. Empty path →
        SFTP home (`.`).
      - [x] **80f — Resolve symlink targets.** ✅ Done. `readdir`'s `file_type()`
        is lstat-style (a symlink reports as a symlink, not its target), so a
        second pass follow-stats each **symlink** (`fs.metadata`, which follows
        the link) to flag a symlink-to-directory `is_dir` and make it navigable;
        only symlinks cost an extra round-trip, and a broken/denied link resolves
        to non-dir. Pure `resolve_child_path` (join child vs `.`/home) is
        unit-tested; the live follow-stat is a manual check.
      - [x] **80d — Command signatures + frontend untouched.** ✅ Done. Same
        command names/params; `RemoteEntry` mapped from `services::sftp::Entry`.
        No `useRemoteSession`/`RemoteProjectSection` change.
      - [x] **80e — Async wiring.** ✅ Done. Both commands are now `async`;
        `lib.rs` registration unchanged; `cargo check --all-targets` clean.
      - **Removed dead code:** the old `parse_ls_output`/`shell_quote` in
        `commands/ssh.rs` (and their tests) — superseded; their sort/filter +
        injection-inert coverage moved to `services::sftp` tests.
    - *Test (e.g.):* a host with a dir literally named `foo; touch pwned`
      lists as one inert entry (no remote command runs), symlinked dirs are
      flagged `is_dir`, and the home dir resolves without a `pwd` shell-out.
    - [x] 🤖 Automated test — `services::sftp` unit tests: `sftp_subsystem_args`
      splices `-s` before the target; `finalize_entries` dirs-first/ci sort,
      dot/blank filter, hidden-entry retention, and the injection-named dir is
      one inert entry. (Pure, no live host; the network round-trip is manual.)
    - [ ] 🖐️ Manual test — re-run #28 Phase 2 (browse) against key-auth and
      password-only hosts; injection-named dirs are inert; mount/exec (Phases
      3–7) still work unchanged.
    - **Follow-on (not this pass):** once browse is SFTP, evaluate a
      JetBrains-*Deployment*-style **edit-over-SFTP** path for the in-app viewers
      to shrink the sshfs surface further (read/write single files over SFTP,
      mount only when local tooling/agents need a real directory).
      → Pursued in full by **#28e–#28j** below (mount-free remote projects).

81. **Mount-free remote projects — replace sshfs with SSH/SFTP-native.**
    📋 **Planned, not started.** Full plan + file:line map + exit criteria per
    phase in **`docs/mountfree_remote_plan.md`** (read it first). Remote projects
    drop the FUSE mount entirely: agent tabs over `ssh -tt`, file browsing/I-O
    over SFTP, git on the host over SSH. **Decisions (locked):** fully *replace*
    sshfs (no coexistence); git *runs over SSH* for remote projects. The keystone
    is making remoteness **explicit** (a backend `remote_target_for(project_id)`
    resolver) instead of inferring it from a cwd under `ssh_mount::mounts_root()`
    (`services/ssh_exec.rs:297`). Phases are ordered so each is independently
    shippable; Phase 1 alone delivers the main goal (remote agent tabs). Built to
    be picked up by an agent team after a context `/clear` — the plan doc is the
    source of truth.
    - [x] **28e — Explicit remoteness + pooled SSH/SFTP** (Phase 0; do first).
      `services/remote.rs` resolver + one ControlMaster & persistent `Sftp`
      session per active remote project (auth once, reused by tabs/browse/git);
      shift commands from `project_dir` path to `project_id` + `rel_path`.
    - [x] **28f — Mount-free remote agent tabs** (Phase 1; main goal). Replace
      `project_id_from_cwd` detection in `ssh_exec::wrap_pty_options` with the
      explicit `RemoteTarget`; remote cwd = `spec.remote_path`.
    - [x] **28g — Live remote file browsing over SFTP** (Phase 2). Project-aware
      `list_dir`; wire `FileTree.tsx`/`FileBrowser.tsx`; drop inotify for remote
      (manual refresh).
    - [x] **28h — Remote file I/O over SFTP** (Phase 3). Add write half to
      `services/sftp.rs` (read/create/write/mkdir/remove/rename/download);
      route `commands/fs.rs` + viewers for remote projects.
    - [x] **28i — Git over SSH for remote projects** (Phase 4). One
      `run_git(target, args)` dispatcher in `commands/git.rs`; remote →
      `ssh_exec::remote_command("cd <path> && git …")`; parsers unchanged.
    - [x] **28j — Remove sshfs** (Phase 5). Deleted `services/ssh_mount.rs`
      (shared `validate_arg`/`ssh_*_base_args`/`ssh_target`/`sshpass_available`
      relocated to `services/ssh_common.rs`), `ensure_*_mounted`, the exit-unmount
      hook, the sshfs tooling probe + install-guide UI, and the frontend mount
      calls. `remote_target_for` now resolves from the always-local `projects.json`
      `extra["remote"]` (so existing remote projects keep working with no mount);
      a remote project's `directory` is a local per-project state dir
      (`remote-projects/<id>`) holding `project.json`, while its tree lives on the
      host. Docs/lessons/tour stripped of FUSE. **Follow-up:** writing the
      canonical scaffold to both the local mirror and remote host is tracked as
      **#28o** below. (The `git_change_stats` untracked-line counts that assumed a
      local tree are now fixed in #28k.) Needs a live-host QA pass.
    - [x] **28k — Review-team follow-ups** (2026-06-30; ✅ Done · 🧪 Remote
      half needs live-host QA). From the post-merge code review of the mount-free
      change (most findings already fixed in the `fix(remote): harden SSH/SFTP
      pool…` commit). Both remaining items resolved:
      - [x] **Remote untracked-line counts read +0.** `count_added_lines`
        (`commands/git.rs`) did a local `std::fs::read` on `project_dir.join(rel)`;
        for a remote project `project_dir` is the local state dir, so every read
        failed and the git "Add" panel showed untracked remote files as `+0 /
        non-binary`. Fixed via the SFTP-read option: `git_change_stats` is now
        `async` + takes the `RemotePoolState`; local projects keep `std::fs::read`,
        remote projects read each untracked file's bytes over the pooled SFTP
        session (`count_added_lines_remote` → `fs::remote_join_confined` +
        `fs::remote_read`, both now `pub(crate)`), with the shared byte→`(lines,
        binary)` logic factored into `count_lines_in_bytes`. The `rel` path is
        confined under `spec.remote_path`; any confinement/read error degrades to
        `(0, false)` as before. Stale "still-present mountpoint" comment replaced.
        **Live-host QA:** confirm `+N`/binary/empty counts against a real SSH
        project, cold-pool (one-shot fallback) counts, and latency on a large
        untracked tree (each file is now an individual SFTP read).
      - [x] **`ConnectionLog` keys by array index.** `key={i}` over a `slice(-500)`
        log forced full re-creation of every line node when the cap trimmed the
        head. Fixed: `ConnectionLog` now takes `LogLine[]` (`{ id; text }`) and
        keys on the id; both push sites (`useRemoteSession.ts`,
        `VpnPasswordPrompt.tsx`) mint a monotonic id from a dedicated `useRef`
        counter that never resets on slice, so surviving lines keep their nodes.
      - Gates: `npx tsc --noEmit`, `cargo test` (412 + 25, 0 failed) all green.
    - **Cross-cutting (all phases):** single auth (one ControlMaster, no 3×
      prompts), no page cache (pooled session + lazy reads), fail-fast offline,
      OpenVPN brought up before the master, git-over-ssh keeps `shell_quote`
      defenses. Per-phase `cargo test` + `npx tsc --noEmit`; runtime QA adapts
      #28 Phases 1–8 minus all mount/`/proc/mounts` steps.
    - [x] **28l — Stepped remote dialog + connection lamps** (2026-06-30; ✅
      Done · 🧪 Untested). New-project dialog reworked into a stepped remote flow
      (connect → browse → details) via `step` in `useRemoteSession`; the
      name/git/details body is gated to the final step (local projects keep the
      single form). **Browse in both connection modes:** non-headless now rides
      the embedded login's ControlMaster to SFTP-browse (auto-poll of a
      credential-less `ssh_connect` after `startSshTerm`, + an "I've logged in —
      browse" fallback), converging on the same `isRemote` browser headless uses;
      Windows non-headless (no control socket → `winManual`) keeps the typed-path
      input. `buildRemoteSpec` collapsed to one branch + Windows fallback. Added
      red/orange/green `ConnLamp` for SSH + OpenVPN, shown in-dialog and
      persistently in the header for the active remote project, driven by a new
      `stores/remoteStatus.ts` (keyed by project id). Activation (`stores/projects.ts`)
      drives the lamps (pooled `remote_connect` with retry; VPN from the prompt
      result or a bounded `openvpn_status` poll) and fires a dedicated `connToast`
      ("VPN connected · <proj>"). **Known gaps for live QA:** (a) ~~macOS
      `openvpn_status` is a stub (always false), so the VPN lamp never goes green
      on macOS~~ — fixed by the macOS OpenVPN backend (31e, 2026-07-11):
      `is_connected` now probes the daemon pid with EPERM-counts-as-alive, so
      the lamp reflects real tunnel state (still needs mac runtime QA);
      (b) a headless password-auth host with no live master can't open the pool
      with a null password, so its SSH lamp goes red after the retry budget —
      accurate, but the path itself is the unstored-password limitation, not a lamp
      bug. Gates: `npx tsc --noEmit`, `vitest` (714), `cargo test` (25) all green.

    - [x] **28m — Auto-sync for files/folders** (2026-07-01; ✅ Done · 🧪
      Untested). Per-path auto-sync layered on the selective-sync manifest: a new
      `SyncEntry::auto_sync` flag (`#[serde(default)]`, implies `selected`; folder
      markers cover their subtree, resolved by `remote_sync::is_auto`) + the
      `sync_set_auto` command; `SyncStatusEntry.auto_sync` surfaces the effective
      flag. New `services::sync_auto` reconcile engine: one per-project task
      (`AutoSyncState` registry) started on `remote_connect`, stopped on
      `remote_disconnect`/exit, triggered by a recursive mirror `notify` watcher
      (debounced ~1.5s) + a ~25s interval. Each pass judges every auto path with a
      new pure `remote_sync::divergence` split and acts on the SAFE direction only
      (host-moved → pull, local-moved → guarded push, **both-moved/amber → skip**),
      reusing `walk_host_files`/`walk_mirror_files`/`pull_file`/`push_file_atomic`/
      `record_*`; emits an `auto-sync` event to refresh the frontend. UI:
      file-tree right-click "Auto-sync this folder/file" (both source trees), a ⟳
      row glyph, a viewer-header ⟳ toggle (remote projects, via a
      `ViewerHeaderInfoContext`), and a right-panel "orange" list view + count
      badge that lists all diverged files with Take-host / Keep-local resolve
      actions. **Deferred:** deletion propagation is intentionally out of scope
      (a one-sided delete is skipped, never mirrored) — needs a tombstone design;
      the mirror watcher fires on Eldrun's own pull writes (harmless: the next
      pass finds those files green) — add a post-write suppression window only if
      it proves chatty. Gates: `npx tsc --noEmit`, `cargo test` (448 lib) green;
      needs live-host QA (auto pull/push timing, orange skip, lifecycle).

    - [ ] **28n — Git-aware local↔remote lockstep sync.** **Phases 1–3 ✅ Done
      (2026-07-02; opt-in per project; checkout lockstep + fast-forward-only ref
      transfer + desync detection/display · 🧪 live-host QA pending).** Phase 2
      (Use-local/Use-remote resolution + `refs/eldrun/backup/*` reset) and Phase 3
      (initial-pairing authority + streaming transport for large bundles) landed
      2026-07-02: `transfer_and_apply` gained a `force` path that, for diverged /
      dest-ahead branches and conflicting tags, saves the overwritten tip to a
      timestamped `refs/eldrun/backup/*` ref then resets to the authority (a
      checked-out loser branch via `reset --hard`, moving ref + tree); `resolve`/
      `resolve_inner` (pause auto-sync → force winner→loser → restamp bases →
      reconcile) back the `git_peer_resolve(authority)` command + Use local / Use
      remote buttons (confirm-gated) in the desync bar. `init_pairing` (`git init`
      the empty side, full-bundle transfer, `symbolic-ref`+`reset --hard` / detached
      checkout to populate) runs from `reconcile` when exactly one side is a repo
      (remote-import → mirror-from-remote, extend-local → remote-from-local; both-
      exist-and-diverge still routes to the explicit authority choice). `move_bundle`
      now streams via new `sftp::{upload,download}_file_streaming_on` (256 KiB
      chunks, `bytes` dep) so the 64 MiB whole-file cap is gone and initial-pairing
      bundles carrying whole histories transfer without buffering. New unit tests:
      `winner_is_local` default, tag backup-ref naming, force-targets-diverged/
      dest-ahead truth pins; frontend `GitLockstep.test.tsx` +2 (resolve routes to
      `git_peer_resolve`, confirm-dismiss no-ops). Gates: `cargo test` (603),
      `npx tsc`, `vitest` (745) green.
      New `services/git_peer.rs` (AppHandle-free: `Peer` enum runner, pure parsers/
      `decide`/`bundle_create_args`, `probe`, `reconcile` via delta `git bundle` over
      the pooled SFTP into `refs/eldrun/incoming/*` + ff-apply, `checkout_lockstep`,
      `.git`-watcher + host-poll detection loop, `GitPeerRegistry`) + `commands/
      git_peer.rs` (`git_peer_{status,set_enabled,sync_now,checkout}`, `git-peer-status`
      event). `services/sync_auto.rs` gained a per-project `paused` `AtomicBool` (checked
      in `reconcile_pass`) so a checkout's mirror writes aren't pushed, with base
      re-stamping via `record_pull` before resume; `remote_sync` walkers now skip
      `.git`. Lifecycle wired into `remote_connect`/`disconnect` + app-exit `stop_all`;
      `GitHistory.tsx` gained a lockstep toggle + status pill + Sync/Retry and routes
      checkout through `git_peer_checkout` when enabled. Gates: `cargo test` (473),
      `npx tsc`, `vitest` (743) green. Original spec (still governs Phase 2/3):
      For an SSH project's
      paired local mirror and remote working tree, keep Git state synchronized
      **semantically** rather than copying `.git/` bytes. Transfer commits and
      refs through Git over the existing SSH ControlMaster; synchronize local
      branches, tags, HEAD branch/detached commit, and all Git-tracked working-tree
      files (including safe tracked deletions). Existing selective sync remains
      authoritative for untracked/ignored files. Never copy machine-specific or
      unsafe Git internals (`config`, hooks, reflogs, index/lock files, remotes,
      stashes, or worktree metadata).
      - **Checkout lockstep.** A branch switch on either side checks out the same
        branch at the same commit on its peer; checking out a commit synchronizes
        the same detached HEAD. Eldrun-triggered checkouts reconcile immediately;
        a local `.git` watcher plus connected-host polling detects CLI-driven
        changes. Pause ordinary file auto-sync during checkout, then refresh its
        tracked-file bases so checkout writes do not become false conflicts.
      - **Safe ref/history reconciliation.** Missing objects/refs transfer in
        either direction and branch updates auto-apply only when fast-forward.
        Diverged histories, simultaneous incompatible checkouts, or a dirty peer
        that blocks checkout enter a visible **desynchronized** state; never
        force-checkout or discard work. Offer Retry after cleanup and an explicit
        Use local / Use remote resolution, creating timestamped `refs/eldrun/backup/*`
        safety refs before resetting the losing side.
      - **Initial pairing.** Remote import initializes the mirror from the remote;
        extending a local project initializes the remote from local. If both
        repositories already exist and diverge, require the same explicit
        authority choice instead of guessing. The paired main working trees are
        covered; extra worktrees and checked-out submodule contents are deferred.
      - **Backend/UI.** Add a per-project Git-peer sync service and persisted
        observed local/remote HEAD/ref/status state; commands for status, retry,
        and authority resolution; and a project-scoped status event. Extend
        coordinated checkout with project id + initiating side while preserving
        camelCase payload compatibility. Show synchronized/syncing/desynchronized
        state and actionable errors in the Git UI.
      - [x] 🤖 Automated test (Phases 1–3) — `git_peer` unit tests: ref/HEAD parsing,
        `decide` fast-forward-vs-divergence truth table, `bundle_create_args`/
        incoming-refspec shape guardrails (never `--all`/`refs/remotes` → `.git`
        internals never copied), tracked-file/deletion discovery, safety-ref naming,
        camelCase state round-trip; frontend `GitLockstep.test.tsx` (checkout routes
        through `git_peer_checkout` when enabled, falls back otherwise, pill renders,
        local project shows no bar; Phase 2: resolve routes to `git_peer_resolve`,
        confirm-dismiss no-ops). Phase 2/3 pure-logic tests: `winner_is_local`,
        tag backup-ref naming, force-targets-diverged/dest-ahead pins.
      - [ ] 🖐️ Manual test — live SSH host: edit/commit/checkout from Eldrun and
        from local/remote shells, verify both trees remain on the same branch or
        detached commit, then exercise dirty-peer recovery and Use-local/Use-remote
        resolution (confirm the loser's overwritten tip lands under
        `refs/eldrun/backup/*` and both trees converge). Also verify initial pairing:
        import a remote repo → mirror initializes from it; extend a local repo onto a
        host → remote initializes from local; and a large-history bundle streams
        through without the old 64 MiB rejection.

    - [ ] **28o — Scaffold both sides of SSH projects.** New and imported SSH
      projects must receive the canonical Eldrun scaffold in both their local
      mirror and remote project root. Create only missing files: existing content
      on either side is authoritative and must never be truncated or replaced.
      The existing **Skip scaffolding** option suppresses generation on both
      sides. Remote scaffold failure is blocking: surface the error in the
      project dialog and do not register the project as successfully
      created/imported.
      - **Remote path.** Add an async
        `scaffold_remote_project(user, host, port, password, remotePath)` Tauri
        command. Open one SFTP session, create the remote root and required
        parent directories, then atomically create each absent canonical file.
        If writing a newly-created file fails, remove that partial file before
        returning the error. A submitted password is ephemeral and must never be
        persisted or logged; when it is absent, resolve any saved SSH credential
        through the existing credential service.
      - **Dialog ordering.** For both remote create and import, invoke remote
        scaffolding before `create_project` / `import_project`. Reuse the
        dialog's existing error state for failures, leaving registration
        untouched. A retry is safe because remote creation is idempotent and
        non-overwriting.
      - **Local mirror.** Keep the existing new-remote mirror scaffolding and
        extend remote import to call the same local `scaffold_project` helper.
        The canonical set remains the existing `SCAFFOLD_FILES`,
        `.gitignore`, and `.claude/settings.json` definitions so both sides start
        with identical defaults.
      - **Compatibility.** No persisted project-schema change. Keep Git
        initialization and agent-assisted scaffold filling behavior unchanged.
      - [ ] 🤖 Automated test — remote imports create the complete local-mirror
        scaffold without overwriting existing content; frontend create/import
        call remote scaffolding before registration; Skip bypasses both paths;
        and a rejected remote-scaffold call prevents registration and surfaces
        its error.
      - [ ] 🖐️ Manual test — create and import projects against key-auth and
        password-auth SSH hosts; verify both trees contain all missing scaffold
        files, pre-existing files remain byte-identical, Skip touches neither
        side, and an unwritable remote root blocks registration with an
        actionable error.

    - [x] **28p — Git lockstep hardening (#28n follow-up)** (2026-07-13; ✅ All
      eight defects fixed · 🧪 Live-host QA still owed). Plan:
      `docs/git_lockstep_hardening_plan.md`. Tracing the full local↔remote case
      matrix over the shipped #28n code surfaced eight defects, two of them
      data-loss/correctness class. Root cause of most: **byte-sync
      (`sync_auto`) and git lockstep (`git_peer`) were blind to each other** —
      byte-sync's candidate walk excludes only `.git`/`.eldrun` and has no notion
      of "git-tracked", so a file lockstep is about to deliver as a *commit* may
      first be shipped as *loose bytes* and land on the peer **untracked**, which
      then blocks the very fast-forward that would have delivered it. Verified
      experimentally: `git merge --ff-only` refuses to overwrite an untracked file
      **even when byte-identical**, while `git reset --hard` silently clobbers it.
      - [x] **D1 (blocking) — byte-sync/git race.** Which outcome you got was a debounce
        race (auto-sync 1500 ms vs lockstep 800 ms): commit fast → clean ff; hesitate
        → wedged `Desynchronized`. Fixed in two layers: `git_peer::tracked_paths` is
        subtracted from the `sync_auto::reconcile_pass` candidate set whenever lockstep
        is on (**lockstep owns the tracked tree, byte-sync owns the rest** — the
        invariant that removes the race by construction), plus
        `retry_ff_clearing_identical`, which clears colliding untracked files **only**
        when every one of them is provably byte-identical to the incoming blob
        (`hash-object` vs `rev-parse <sha>:<path>`, all-or-nothing) and retries the ff.
        That second layer is what makes the *first* enable succeed on a project whose
        files byte-sync already mirrored. Pinned against real git, not just parsers:
        `ff_retry_clears_byte_identical_untracked_files_and_succeeds` /
        `ff_retry_refuses_when_any_colliding_file_differs`. The old
        "never enable auto-sync-all with lockstep" caveat is lifted.
      - [x] **D3 (blocking) — `init_pairing` could clobber host files.** Extend-local does
        `git init` + `reset --hard` on the host; the pre-backup saves *refs*, but a
        not-yet-a-repo host has none, and `reset --hard` destroys colliding untracked
        files with no backup and no prompt. Fixed: `pairing_conflicts` fingerprints the
        source's tracked tree (`ls-tree -r -l -z`) against the dest's existing files
        (size first, then a `git hash-object` batch over the same-size residue — it works
        outside a repo, so it runs on the not-yet-init'ed dest) and **refuses** when any
        collision differs, surfacing `pairingConflict` so the UI names the files and
        demands an explicit `git_peer_pair_confirm`. Unprovable equality counts as a
        difference. The `probe_error` refusal is now symmetric
        (`pairing_dest_probe_error`): the *remote* dest — reached over a flaky link, so
        the likelier to misprobe — is guarded exactly like the local one.
      - [x] **D4 — disconnected "Sync now" reported green.** A dropped SSH connection
        surfaces as `Ok(nonzero)`, so `probe_error` stayed false and the host read as
        a clean empty side → doomed `init_pairing` → status fell through the
        `!final_remote.is_repo` arm to `Synchronized`. Fixed: every entry point
        (`reconcile`/`detect_and_sync`/`checkout_lockstep`/`resolve`/`restore_backup`)
        gates on `connected()` (the pooled SFTP session) up front, and a new
        `SyncStatus::Disconnected` carries the last-known heads without claiming
        anything about the host. The pill renders it grey and disables Sync-now.
      - [x] **D2 — the desync detail lied.** A blocked ff always rendered "A peer has
        uncommitted changes", but the cause is usually *untracked* collisions, and the
        merge stderr naming the files was discarded. Fixed: `TransferResult.dirty_blocked:
        bool` → `blocked: Option<String>`, composed by `blocked_detail` from the parsed
        stderr (`parse_untracked_overwrite_paths`, incl. git's C-quoted paths), so the
        bar names the actual files instead of inventing uncommitted changes.
      - [x] **D5 — SSH chattiness.** `probe` was 6 round trips; `is_ancestor` 2 more per
        branch per direction; both directions ran every 12 s *and* on every `git add`
        (≈80 round trips/pass on a 20-branch repo). Fixed: `PROBE_SCRIPT` (one `\x1e`-
        delimited `sh` script → `parse_probe_block`) makes the probe **1** round trip, and
        `ancestry_script` collapses all `2·N` ancestry checks into **1**; both fall back to
        the per-command path if the output doesn't parse (a host with no POSIX `sh`), and
        both are tested through a *real* `sh` so a syntax error can't silently disable the
        batching. `can_early_out` skips the whole pass when neither side's ref signature
        moved and we were green — which is what kills the `git add` storm; a manual Retry
        always forces a full pass (`ReconcileOpts::forced`).
      - [x] **D6 — backup refs were write-only.** `refs/eldrun/backup/*` accrued forever,
        pinned objects, and had no list/restore/prune UI — which also hollowed out the
        "it's recoverable" defence of Use-local/Use-remote. Fixed: `git_peer_backups`
        (both peers, newest first) + a Backups affordance in the lockstep bar +
        `git_peer_restore_backup`, which backs the current tip up *first* so a restore is
        itself undoable. `select_prunable` keeps the newest 20 per peer and anything
        <30 days, never the newest; pruning runs where backups are *born* (resolve /
        restore), keeping it off the hot reconcile path.
      - [x] **D7 — the paired mirror had no `origin`.** `init_pairing` left the mirror with
        no remote (bundles carry no config/remotes), so `git push` from a local agent tab
        just failed. Fixed: `should_propagate_origin` copies the source's
        `remote.origin.url` — **URL only**, never credentials or other config keys — into a
        freshly-paired dest, and never over a dest that already has its own origin.
      - [x] **D8 — divergence offered authority, not merge.** Only Use-local/Use-remote:
        pick a winner, the loser's commits leave the tree. Fixed (deliberately minimal —
        no merge UI): a reconcile that detects a divergence parks the peer's tip at
        `refs/eldrun/peer/<branch>` (`peer_ref_op`; the objects are already there from the
        bundle, so it is free) and clears it again once the branch is back in step; a
        **Resolve in terminal** action opens a local shell in the mirror so the user
        merges/rebases with plain git and the next pass fast-forwards the host normally.
        Both heads' sha + subject now show in the bar (`head_subject`, carried in the
        batched probe) so the authority choice is informed rather than blind.
      - **Phasing.** Shipped in one pass, in the planned dependency order: Phase 1
        (trust) D1 → D3 → D4 → D2; Phase 2 (viability on a real link) D5, D6; Phase 3
        (polish) D7, D8.
      - [x] 🤖 Automated test — all of the planned pure/unit coverage landed:
        untracked-overwrite stderr parser (incl. C-quoted paths); tracked-path exclusion
        from the auto-sync candidate set (and its no-op when lockstep is off);
        pairing-collision detection over two path→(size,hash) maps (incl. "unprovable =
        differs"); symmetric `probe_error` refusal truth table; cold-pool gate +
        `disconnected_state`; `parse_probe_block` round-trip; early-out predicate;
        backup-ref parse + prune selection; origin propagation skipped when the dest has
        one; only diverged branches park `refs/eldrun/peer/*`. **Plus three that exercise
        the real thing rather than a parser**, because the two riskiest behaviours here are
        git's and the shell's, not ours: the ff-retry against a real repo (it clears
        byte-identical untracked collisions and fast-forwards; one differing file aborts
        the whole retry and deletes nothing), and both batched scripts through a real `sh`,
        asserted to agree with the per-command path they replace — a syntax error would
        otherwise disable the D5 batching *silently*. Frontend: disconnected pill +
        disabled Sync-now, the pairing-overwrite confirm naming the files, backups
        list/restore, resolve-in-terminal spawning a local mirror shell.
      - [ ] 🖐️ Manual test — live SSH host, the six-row matrix at the end of the plan:
        auto-sync-all + lockstep with a slow commit still fast-forwards green; the
        fast-commit path does not regress; enabling lockstep over already-byte-synced
        tracked files succeeds on first reconcile; extend-local onto a host dir holding
        a differing `README.md` is refused with the file named and the host file
        intact; disconnect → Sync now reports disconnected rather than green; and a
        two-sided divergence resolved with Use local leaves a listable backup ref.

    - [x] **28q — Warn when sync or git destroys something on the LOCAL side**
      (2026-07-13; ✅ Code-complete · 🧪 Live-host QA owed). Re-scanning the remote
      surface for local-side deletions: byte-sync (`sync_auto`) turns out to be
      non-destructive **by construction** — it pulls only when the local side is
      unchanged, pushes only when the host is, and skips an amber file rather than
      pick a winner — so *every* local deletion comes from the git side, plus one
      overwrite from the manual pull commands. All five were correct, deliberate, and
      **silent**, which is the bug: they run in the mirror during background passes
      nobody triggered, so a file the user was looking at simply vanished.
      - **The five sites**, each now filing a warning (`services::local_loss`, an
        append-only per-project log): a fast-forward or `reset --hard` on the mirror's
        checked-out branch (deletes the tracked files the incoming commit dropped); a
        lockstep checkout, including the one that *follows a branch switch made on the
        host* — the least expected of the lot; the `git clean` inside
        `retry_ff_clearing_identical` (deletes **untracked** files, which no `git diff`
        can ever name); a confirmed initial pairing overwriting the colliding mirror
        files it warned about; and `sync_now`/`sync_pull` overwriting a mirror file that
        held unsynced local edits — the only one of the five that is **not
        recoverable**, since those bytes were never committed or pushed anywhere, and
        the dialog says so in as many words rather than leaving the recovery line blank.
      - **Reports, does not gate.** The gates that *prevent* a destructive write already
        exist (`pairing_conflict`, the blocked-ff refusal, `push_decision`); this is for
        what they deliberately let through. `audit_local_head_move` reads the mirror's
        HEAD before and after each mutation, so an op that failed records nothing, and a
        nested reconcile can never double-report its caller's deletion.
      - **A file, not an event:** the services are `AppHandle`-free and a background pass
        can delete with no window listening, so a warning that existed only as an event
        would be dropped exactly when it mattered. The frontend re-reads the log on every
        lockstep/sync pass, so a loss recorded while the app was closed still surfaces.
      - [x] 🤖 Automated test — `deleted_between_names_only_what_a_move_removes` (a
        forward fast-forward warns about nothing; only a move *back* deletes), the
        `FfRetry` variants pinned against real git (`Cleared` names what it removed even
        when the ff puts identical bytes straight back), and
        `src/__tests__/LocalLossDialog.test.tsx` (raises unacked losses, says outright
        when nothing can be recovered, acks through the backend, never shows one
        project's losses over another).
      - [ ] 🖐️ Manual test — live SSH host: commit a file deletion on the host and let
        the background pass land it (the warning names the file and gives the
        `git checkout <sha> -- <path>` line that brings it back); switch branches on the
        host so the mirror follows into a checkout that drops a file; edit a byte-synced
        file locally, then Sync now, and confirm the overwrite is reported as
        unrecoverable; and confirm a project that loses nothing never sees the dialog.

82. **Split-tunnel the OpenVPN connection (per-project opt-in).** Eldrun passes
    OpenVPN *no* routing flags (`services/openvpn::openvpn_args`), so whatever the
    `.ovpn` pushes applies to the whole machine — typically `redirect-gateway def1`
    plus DNS, which reroutes the browser and every other process while the tunnel is
    up. The tunnel is now *disclosed* as machine-wide (header `VpnIndicator`, connect
    dialog copy) but not *scoped*. Scope it: `--route-nopull` plus an explicit route
    to the project's SSH host only, leaving the rest of the OS on its normal gateway.
    - **Must be opt-in per project.** Some hosts are only reachable via the pushed
      routes, so this cannot be the default without breaking working setups.
    - **The chicken-and-egg to solve first:** if the host is an internal-only
      *hostname*, it resolves only through the VPN's pushed DNS — which
      `--route-nopull` drops. So the route can't be computed before the tunnel is up.
      Options: resolve once with a full tunnel and cache the IP; accept the pushed
      DNS but not the default route; or require an IP/`ssh_config` `HostName` for
      opt-in projects.
    - **Failure mode is opaque** (a connect timeout), so this needs live QA against a
      real VPN before it can be trusted — it cannot be verified from tests alone.
    - [ ] 🤖 Automated test — `openvpn_args` emits `--route-nopull` + the host route
      only when the project opts in, and never for a non-opted project.
    - [ ] 🖐️ Manual test — with split-tunnel on, `ip route` shows a route to the SSH
      host via `tun0` while the default route is unchanged; SSH/SFTP/agent tabs work;
      a browser fetch does *not* egress via the VPN. With it off, behaviour is
      unchanged from today.

83. ✅ **Interactive (non-headless) tunnels are visible and killable.** With
    `connections_headless: false`, the tunnel is `pkexec openvpn` inside a terminal
    tab. It used to carry no `--writepid`, so it never entered the backend registry:
    `openvpn_status`/`openvpn_active` could not see it, `openvpn_disconnect` could not
    kill it, and `disconnect_all()` at exit missed it — **it outlived Eldrun with the
    machine's routing still changed**. `pollVpnUp` (`stores/projects.ts`) polls
    `openvpn_status`, so it could never observe such a tunnel come up either, and
    always timed out to a red lamp.
    Fixed by *arming* the interactive connect: `interactive_connect_command` now
    picks a pidfile Eldrun owns, deletes any stale one, appends
    `--writepid <runtime>/<stem>.interactive.pid`, and registers the claim in a new
    pid-keyed `interactive_registry` (`services/openvpn.rs`). `is_connected`,
    `active_configs`, `disconnect` and `disconnect_all` all consult it, so a
    terminal-started tunnel is now exactly as visible and as killable as a headless
    one — on all three platforms (`pid_alive` is `kill(pid, 0)` with **EPERM = alive**
    on unix, `tasklist` on Windows; the kill re-escalates via `pkexec`/`osascript`/
    `taskkill`). A registered-but-pidless tunnel is `Pending`, not dead — reaping it
    would forget a tunnel in the seconds before it comes up.
    - [x] 🤖 Automated test — `interactive_command_claims_a_pidfile`,
      `interactive_tunnel_with_a_live_pid_is_up`,
      `interactive_tunnel_with_a_dead_pid_is_reaped`, `arming_clears_a_stale_pidfile`
      (`services/openvpn.rs` tests).
    - [ ] 🖐️ Manual test — with headless connections off, bring a tunnel up in a
      terminal tab; the VPN lamp goes green by itself, the header indicator offers a
      working Disconnect, and quitting Eldrun brings the tunnel down (`ip route`
      restored).

84. ✅ **The header VPN indicator is a machine-level VPN control.** The tunnel reroutes
    the whole OS, so it gets a surface that does not hang off a project:
    `components/header/VpnIndicator.tsx`, always present in the header (dim when no
    tunnel is up), backed by `stores/vpnStatus.ts` (config-keyed state + holder
    refcount, seeded from the new `openvpn_active` command and re-seated on window
    focus, so a tunnel that outlived a reload or a previous run still shows).
    It lists every stored `.ovpn`, brings one **up** as well as down (a VPN is a thing
    you use, not only a precondition for an SSH project — the prompt's `projectId` is
    now nullable so a tunnel can be connected with no project behind it), names which
    projects hold each tunnel, and is the only place a tunnel is killed outright.
    Project-side teardowns go through `releaseVpn`, which disconnects **only** when the
    last holder leaves — previously `logoutRemote` and the Connect modal's Disconnect
    both called `openvpn_disconnect` unconditionally, killing a tunnel a *second*
    project (and the rest of the OS) was still riding.
    - [x] 🤖 Automated test — `src/__tests__/VpnMachineScope.test.tsx` (refcounted
      shared tunnel; indicator shows/holders/disconnects; header-initiated connect
      with no holder; backend reconcile).
    - [ ] 🖐️ Manual test — connect a VPN-gated project, confirm `ip route` shows the
      tunnel owning the default route and the header indicator appears; open a second
      project on the same `.ovpn`, log out of the first, confirm the second stays up;
      disconnect from the header and confirm routing is restored. Connect a tunnel
      from the header with no project active.

85. ✅ **Persistent sessions (tmux) — remote + local.** *(Implemented — `RemoteSpec.persist_sessions`,
    `settings.persist_local_sessions`, `PtyOptions.tmux_session`/`tmux_attach`, `ssh_exec::{TmuxWrap,
    tmux_wrap_exec,tmux_kill_session_script,tmux_rename_session_script,tmux_ls_script,parse_tmux_ls,
    valid_tmux_session_name}`, `services::tmux_local`, `remote_tmux_{list,kill,rename}` +
    `local_tmux_{list,kill,rename}` + `set_project_persist_sessions` commands;
    frontend `lib/tmuxSession.ts`, `lib/closeRemoteTab.ts`, CenterPanel/TabPane/TerminalView
    plumbing, the pill toggle + a global Settings toggle, and the multi-host Sessions view in
    `ProjectFilesView`.)* Shipped **default ON** rather than behind the experimental flag (per user).
    Beyond the original remote scope it also covers: **local** persistence (Unix — survives an
    Eldrun *crash*), **worker-host** sessions (the Sessions view aggregates every connected host),
    and per-row **Rename**. Agent tabs are excluded (they resume via their own session).
    Live-QA on a real host / crash still pending (Done ≠ Tested). A remote shell/script is a child of
    the `ssh -tt` channel, so it dies (`SIGHUP`) on any channel break — network
    blip, laptop sleep, VPN drop, or Eldrun quitting. Run it **inside a tmux
    server on the host** instead, decoupled from SSH: reconnect or relaunch and
    the same command reattaches to the still-running session. Server-side, so it
    works identically for a Windows/macOS Eldrun (only the local `ssh` client
    differs); **remote projects only** (a local process is Eldrun's own child,
    not decoupled by SSH). One seam: `remote_command` (`ssh_exec.rs:117`) wraps
    the final `exec` in `tmux new-session -A -D -s eldrun-<tab-uid> -- …`, nesting
    the existing `cd`/env-export/`remote_agents` prelude untouched — `-A` makes
    the one command both start and resume, the stable per-tab name is what
    reattach keys on. Restart-resume is then nearly free (a remote shell tab is
    already restorable, `tabs.ts:3416`). The one new decision is **kill vs.
    detach**: explicit tab-close runs `tmux kill-session` via `run_remote_script`
    (`ssh_exec.rs:300`); app-exit/disconnect leave the session alive. Behind the
    experimental flag; tmux-absent falls back to today's plain `exec` + a notice.
    Headline surface is a **Sessions view** in the file viewer, alongside Files /
    Git / Search / Apps / Orange (`ProjectFilesView.tsx:33,607`) — a remote-only
    toolbar toggle (mirrors the Orange/diverged view) listing host `tmux ls`
    sessions (incl. hand-started ones and orphans from a crashed Eldrun); click a
    row → open a shell tab that **attaches** (`tmux new-session -A -D -s <name>`),
    per-row kill/reveal. Renders in both the right panel and the Files tab for
    free (one component). Plan: `docs/tmux_remote_plan.md`. `dtach`/`abduco`
    (more transparent, less available) kept as a deferred alt backend.
    - [x] 🤖 Automated test — argv builder (`remote_command_off_is_unchanged`,
      `remote_command_tmux_wraps_shell_tab`/`_command_tab_preserving_prelude`/
      `_tmux_attach_ignores_target`); `tmux ls` parse
      (`parse_tmux_ls_reads_rows_and_tolerates_empty`);
      `tmux_kill_session_script_quotes_name`; frontend `TmuxSessions.test.ts`
      (uuid mint is tmux-safe, default-ON gate, shell-only rule, attach-tab restore,
      and the **key-regenerates-but-tmuxSession-stays-stable** reattach guarantee).
    - [ ] 🖐️ Manual test — remote long-running `python -u` run: kill network /
      sleep → reconnect → output continues; quit Eldrun mid-run → relaunch →
      shell tab reattaches, run still going; explicit tab-close → `tmux ls` shows
      the session gone; tmux-less host → tab works, notice shown, no persistence;
      hand-start a session on the host → it appears in the `☰` Sessions view →
      click → tab attaches to the live process → per-row Kill drops it.

---
