//! Per-tab Claude session tracking so Eldrun can resume the *current* session
//! after a `/clear`.
//!
//! Claude is launched with a deterministic launch id (`--session-id <uuid>`),
//! but `/clear` rolls Claude onto a fresh session id with no recorded link back
//! to the launch id — so resuming the launch id brings back the pre-`/clear`
//! conversation. To follow the live id we install a global Claude `SessionStart`
//! hook (fires on startup / resume / clear / compact) that records the live
//! `session_id` keyed by `$ELDRUN_TAB_UID` — an env var Eldrun sets on the
//! spawned agent to the stable launch id (see `terminal::resolve_claude_session`).
//! The hook no-ops for any Claude not launched by Eldrun (no `ELDRUN_TAB_UID`),
//! so it is safe to install once, globally.

use std::path::PathBuf;

use crate::paths;
use crate::storage;
use crate::terminal::PtyOptions;

// The hook body is platform-specific: a POSIX `#!/bin/sh` script that the agents'
// shell (`/bin/sh`) runs directly on unix, and a PowerShell script on Windows
// (there is no `/bin/sh`; the agents run the hook `command` through `cmd.exe`).
#[cfg(not(windows))]
const HOOK_SCRIPT_NAME: &str = "eldrun_session_start.sh";
#[cfg(windows)]
const HOOK_SCRIPT_NAME: &str = "eldrun_session_start.ps1";

// ── Agent session resolution ────────────────────────────────────────────────
//
// At spawn time a tracked agent tab (Claude/Codex) must (re)attach to the right
// conversation. These resolvers live here, next to the SessionStart hook
// installer that records each tab's live session id, so all session logic is in
// one module. `terminal::spawn_pty` and the remote-aware spawn path call
// `resolve_agent_session` *before* any ssh wrapping, so remote tabs still pick
// up `--resume`/`resume` on the original `claude`/`codex` command.

/// Resolve a tracked agent tab's session args at spawn so it resumes the right
/// conversation. Dispatches per agent; non-tracked commands pass through.
pub fn resolve_agent_session(opts: PtyOptions) -> PtyOptions {
    match opts.cmd.as_str() {
        "claude" => resolve_claude_session(opts),
        "codex" => resolve_codex_session(opts),
        _ => opts,
    }
}

/// Resolve a Codex tab's session args. Unlike Claude, Codex mints its own session
/// id (no launch-time `--session-id`), so the only stable per-tab key is the
/// `ELDRUN_TAB_UID` env var Eldrun sets from the tab's id. The global Codex
/// `SessionStart` hook records the live session id under that key (see
/// `install_session_start_hook`); here we read it and, when a matching rollout
/// log exists, launch `codex resume <live-id>`. With no record yet (first launch,
/// or the hook not trusted), we leave the args untouched → a fresh Codex session.
fn resolve_codex_session(opts: PtyOptions) -> PtyOptions {
    let sessions = paths::home_dir().join(".codex").join("sessions");
    resolve_codex_session_impl(opts, &sessions, read_live_session)
}

/// Testable core of [`resolve_codex_session`].
fn resolve_codex_session_impl<F>(
    mut opts: PtyOptions,
    sessions_root: &std::path::Path,
    live_lookup: F,
) -> PtyOptions
where
    F: Fn(&str) -> Option<String>,
{
    if opts.cmd != "codex" {
        return opts;
    }
    let Some(uid) = opts.env.get("ELDRUN_TAB_UID").cloned() else {
        return opts;
    };
    if let Some(id) = live_lookup(&uid).filter(|id| codex_session_exists(sessions_root, id)) {
        opts.args = vec!["resume".to_string(), id];
    }
    opts
}

/// Whether Codex has a persisted rollout log for `uuid`. Codex stores sessions at
/// `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`, so we walk the
/// date buckets (bounded depth) for a `.jsonl` whose name contains the uuid.
fn codex_session_exists(root: &std::path::Path, uuid: &str) -> bool {
    fn walk(dir: &std::path::Path, uuid: &str, depth: u8) -> bool {
        if depth > 5 {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if walk(&path, uuid, depth + 1) {
                    return true;
                }
            } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.ends_with(".jsonl") && name.contains(uuid) {
                    return true;
                }
            }
        }
        false
    }
    walk(root, uuid, 0)
}

/// Resolve a Claude tab's session args at spawn so it (re)attaches to the right
/// conversation, including after a `/clear`.
///
/// The tab is launched with a deterministic *launch id* (`--session-id <uuid>`),
/// which doubles as the tab's stable key. We:
///
/// 1. Expose that launch id to the global `SessionStart` hook via the
///    `ELDRUN_TAB_UID` env var, so the hook can record this tab's *live* session
///    id. The live id diverges from the launch id after `/clear` (Claude rolls
///    onto a fresh session with no recorded back-link), so this is the only
///    reliable way to follow it.
/// 2. Pick the resume target: the hook-recorded live id when it has a persisted
///    log, else the launch id when *it* has one.
/// 3. Emit `--resume <target>` only when a session log actually exists; Claude
///    writes the log lazily (first message), so a never-used tab has none — in
///    that case keep `--session-id <launch>` and start fresh under the reserved
///    id (nothing is lost, and `--resume` would exit with "No conversation
///    found"). This also safely downgrades a restore that asked for `--resume`.
fn resolve_claude_session(opts: PtyOptions) -> PtyOptions {
    let projects = paths::home_dir().join(".claude").join("projects");
    resolve_claude_session_impl(opts, &projects, read_live_session)
}

/// Testable core of [`resolve_claude_session`]: `projects` is the Claude session
/// root and `live_lookup` maps a launch id → recorded live id (if any).
fn resolve_claude_session_impl<F>(
    mut opts: PtyOptions,
    projects: &std::path::Path,
    live_lookup: F,
) -> PtyOptions
where
    F: Fn(&str) -> Option<String>,
{
    if opts.cmd != "claude" {
        return opts;
    }
    let Some(i) = opts
        .args
        .iter()
        .position(|a| a == "--session-id" || a == "--resume")
    else {
        return opts;
    };
    if i + 1 >= opts.args.len() {
        return opts;
    }
    let launch_id = opts.args[i + 1].clone();

    // The stable per-tab key is the launch id; expose it to the SessionStart hook.
    opts.env
        .entry("ELDRUN_TAB_UID".to_string())
        .or_insert_with(|| launch_id.clone());

    // Prefer the hook-recorded live id (survives /clear); fall back to launch id.
    let resume_target = live_lookup(&launch_id)
        .filter(|id| claude_session_exists(projects, id))
        .or_else(|| claude_session_exists(projects, &launch_id).then(|| launch_id.clone()));

    match resume_target {
        Some(id) => {
            opts.args[i] = "--resume".to_string();
            opts.args[i + 1] = id;
        }
        None => {
            // No resumable log yet → (re)create under the launch id.
            opts.args[i] = "--session-id".to_string();
            opts.args[i + 1] = launch_id;
        }
    }
    opts
}

/// Whether Claude has a persisted session log for `uuid` under `projects`
/// (`~/.claude/projects`). Claude stores sessions at
/// `<projects>/<encoded-cwd>/<uuid>.jsonl`; since uuids are globally unique we
/// scan the project dirs for `<uuid>.jsonl` rather than re-deriving the cwd
/// encoding.
fn claude_session_exists(projects: &std::path::Path, uuid: &str) -> bool {
    let file = format!("{uuid}.jsonl");
    let Ok(dirs) = std::fs::read_dir(projects) else {
        return false;
    };
    dirs.flatten()
        .any(|entry| entry.path().join(&file).is_file())
}

/// `~/.local/share/eldrun/live_sessions/` — one file per tab (named by the
/// tab's stable launch uuid) holding that tab's current live Claude session id.
pub fn live_sessions_dir() -> PathBuf {
    storage::state_dir().join("live_sessions")
}

fn hook_script_path() -> PathBuf {
    storage::state_dir().join("hooks").join(HOOK_SCRIPT_NAME)
}

/// The `command` string Eldrun registers in the agents' SessionStart hook config
/// (Claude `settings.json` / Codex `config.toml`). The agents run this through the
/// OS shell, so it must be runnable there: on unix the bare `#!/bin/sh` script path
/// suffices, but on Windows `cmd.exe` cannot execute that script, so we invoke the
/// PowerShell hook explicitly. `-File` makes PowerShell read the script while still
/// forwarding the hook's stdin JSON payload to it.
fn hook_command() -> String {
    let path = hook_script_path();
    #[cfg(windows)]
    {
        format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            path.to_string_lossy()
        )
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}

/// uuid-ish guard: hex digits + dashes only, non-empty. Doubles as path-traversal
/// protection for the file key.
pub fn is_uuidish(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Read the live Claude session id recorded for `uid` (the tab's stable launch
/// id), if the hook has written one. Returns `None` when absent or malformed.
pub fn read_live_session(uid: &str) -> Option<String> {
    read_live_session_in(&live_sessions_dir(), uid)
}

/// Testable core of [`read_live_session`] against an explicit directory.
pub fn read_live_session_in(dir: &std::path::Path, uid: &str) -> Option<String> {
    if !is_uuidish(uid) {
        return None;
    }
    let raw = std::fs::read_to_string(dir.join(uid)).ok()?;
    let id = raw.trim().to_string();
    if is_uuidish(&id) {
        Some(id)
    } else {
        None
    }
}

/// Record `id` as the live session for `uid` — the same file, in the same
/// format, that the SessionStart hook writes. This is what lets
/// [`crate::services::codex_bind`] act as a drop-in stand-in for an untrusted
/// Codex hook without touching the resolve path.
pub fn write_live_session(uid: &str, id: &str) -> std::io::Result<()> {
    write_live_session_in(&live_sessions_dir(), uid, id)
}

/// Testable core of [`write_live_session`]. The uuid-ish guard on both keys is
/// path-traversal defense (`uid` becomes a filename). Writes via a temp file +
/// rename so a hook writing the same key concurrently can never observe a torn
/// value.
pub fn write_live_session_in(dir: &std::path::Path, uid: &str, id: &str) -> std::io::Result<()> {
    if !is_uuidish(uid) || !is_uuidish(id) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "live-session keys must be uuid-ish",
        ));
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{uid}.tmp"));
    std::fs::write(&tmp, id)?;
    std::fs::rename(&tmp, dir.join(uid))?;
    Ok(())
}

// ── Codex hook trust state ──────────────────────────────────────────────────

/// What Eldrun's Codex `SessionStart` hook is actually doing right now.
///
/// Codex gates *user-level* hooks behind a one-time trust approval (`/hooks`
/// inside Codex), recording the verdict in a `[hooks.state."…"]` table. An
/// untrusted or disabled hook simply never runs — silently — which is why Codex
/// tabs used to restore into a blank conversation: no live id was ever recorded,
/// so [`resolve_codex_session`] had nothing to resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexHookState {
    /// No `~/.codex` — Codex isn't in use, so there is nothing to report.
    NoCodex,
    /// Codex is in use but our hook isn't in its config (registration failed).
    NotRegistered,
    /// Registered, but Codex has no trust verdict for it yet → it never runs.
    Untrusted,
    /// Registered and known to Codex, but explicitly `enabled = false`.
    Disabled,
    /// Registered and trusted → the precise resume path is live.
    Enabled,
}

/// Classify Eldrun's hook in the user's Codex config.
pub fn codex_hook_state() -> CodexHookState {
    let codex_dir = paths::home_dir().join(".codex");
    if !codex_dir.is_dir() {
        return CodexHookState::NoCodex;
    }
    let config = codex_dir.join("config.toml");
    let src = std::fs::read_to_string(&config).unwrap_or_default();
    codex_hook_state_in(&src, &config.to_string_lossy(), &hook_command())
}

/// Testable core of [`codex_hook_state`].
///
/// A line scanner, not a TOML parse — deliberately, for the same reason
/// [`register_codex_hook_in`] text-appends: taking a `toml` dependency just to
/// read two keys isn't worth it, and the shapes involved are fixed.
///
/// Codex keys its trust verdicts by *position*: `<config path>:session_start:
/// <group>:<hook>`, where the indices count `[[hooks.SessionStart]]` tables and
/// the `[[hooks.SessionStart.hooks]]` tables within each. So we find our hook by
/// its `command`, note where it sits, and look the verdict up under that key.
pub fn codex_hook_state_in(src: &str, config_path: &str, cmd: &str) -> CodexHookState {
    let mut group: i64 = -1;
    let mut hook: i64 = -1;
    let mut in_hook_table = false;
    let mut ours: Option<(i64, i64)> = None;
    let mut state_key: Option<String> = None;
    let mut verdicts: std::collections::HashMap<String, bool> = std::collections::HashMap::new();

    for raw in src.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_hook_table = false;
            state_key = None;
            if line.starts_with("[[hooks.SessionStart]]") {
                group += 1;
                hook = -1;
            } else if line.starts_with("[[hooks.SessionStart.hooks]]") {
                hook += 1;
                in_hook_table = true;
            } else if let Some(key) = toml_state_table_key(line) {
                state_key = Some(key);
            }
            continue;
        }
        if in_hook_table {
            if toml_value(line, "command").as_deref() == Some(cmd) {
                ours = Some((group.max(0), hook.max(0)));
            }
        } else if let Some(key) = state_key.as_ref() {
            if let Some(v) = toml_value(line, "enabled") {
                verdicts.insert(key.clone(), v == "true");
            }
        }
    }

    let Some((g, h)) = ours else {
        return CodexHookState::NotRegistered;
    };
    let suffix = format!(":session_start:{g}:{h}");
    let verdict = verdicts
        .get(&format!("{config_path}{suffix}"))
        // Fall back to any entry at our position: Codex builds the key from the
        // config path *it* resolved, which can differ from ours in spelling (a
        // symlinked `$CODEX_HOME`, a `/private` prefix on macOS).
        .or_else(|| {
            verdicts
                .iter()
                .find(|(k, _)| k.ends_with(&suffix))
                .map(|(_, v)| v)
        });
    match verdict {
        Some(true) => CodexHookState::Enabled,
        Some(false) => CodexHookState::Disabled,
        None => CodexHookState::Untrusted,
    }
}

/// `[hooks.state."<key>"]` → `<key>`. Any other table header → `None`.
fn toml_state_table_key(header: &str) -> Option<String> {
    let inner = header
        .strip_prefix("[hooks.state.")?
        .strip_suffix(']')?
        .trim();
    let unquoted = inner
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(inner);
    Some(unquoted.to_string())
}

/// `key = <value>` → the value, unquoted. `None` when the line isn't `key`'s.
fn toml_value(line: &str, key: &str) -> Option<String> {
    let (lhs, rhs) = line.split_once('=')?;
    if lhs.trim() != key {
        return None;
    }
    let v = rhs.trim();
    let unquoted = v
        .strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
        .or_else(|| v.strip_prefix('"').and_then(|s| s.strip_suffix('"')))
        .unwrap_or(v);
    Some(unquoted.to_string())
}

/// Whether the hook-free rollout binder ([`crate::services::codex_bind`]) should
/// run for a Codex tab. It is the *fallback*: when the hook is trusted it is
/// strictly more precise (it fires on `/clear` immediately and can't confuse two
/// tabs sharing a cwd), so we stay out of its way.
pub fn codex_binder_enabled() -> bool {
    !matches!(codex_hook_state(), CodexHookState::Enabled)
}

/// Install (idempotently) the `SessionStart` hook and its script for every agent
/// Eldrun can track (Claude + Codex), so it learns each tab's live session id.
/// Safe to call on every startup. The shared script keys by `$ELDRUN_TAB_UID`
/// and reads `session_id` from the hook's stdin JSON — both CLIs use that schema.
pub fn install_session_start_hook() -> std::io::Result<()> {
    write_hook_script()?;
    register_hook_in_settings(&paths::home_dir().join(".claude").join("settings.json"))?;
    // Codex stores config as TOML and only installs hooks where `~/.codex` exists.
    // Best-effort: a Codex failure must not stop the Claude hook from installing.
    if let Err(e) = register_codex_hook() {
        eprintln!("agent_session: register codex hook: {e}");
    }
    Ok(())
}

fn write_hook_script() -> std::io::Result<()> {
    let live_dir = live_sessions_dir();
    std::fs::create_dir_all(&live_dir)?;
    let script_path = hook_script_path();
    if let Some(parent) = script_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&script_path, hook_script_body(&live_dir.to_string_lossy()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = std::fs::metadata(&script_path)?.permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&script_path, perm)?;
    }
    Ok(())
}

/// POSIX-sh hook body. Reads the SessionStart JSON on stdin, extracts
/// `session_id`, and records it under `<live_dir>/<ELDRUN_TAB_UID>`. No jq
/// dependency: a single `sed` pulls the uuid out of the one-line JSON.
#[cfg(not(windows))]
fn hook_script_body(live_dir: &str) -> String {
    format!(
        "#!/bin/sh\n\
         # Eldrun SessionStart hook — records Claude's live session id per tab so\n\
         # Eldrun can resume the current session (incl. after /clear). No-op unless\n\
         # launched by Eldrun (ELDRUN_TAB_UID set). Managed by Eldrun; do not edit.\n\
         [ -n \"$ELDRUN_TAB_UID\" ] || exit 0\n\
         case \"$ELDRUN_TAB_UID\" in *[!a-zA-Z0-9-]*|\"\") exit 0 ;; esac\n\
         input=$(cat)\n\
         sid=$(printf '%s' \"$input\" | tr '\\n' ' ' | sed -n 's/.*\"session_id\"[[:space:]]*:[[:space:]]*\"\\([0-9a-fA-F-]*\\)\".*/\\1/p')\n\
         [ -n \"$sid\" ] || exit 0\n\
         dir=\"{live_dir}\"\n\
         mkdir -p \"$dir\" 2>/dev/null || exit 0\n\
         printf '%s' \"$sid\" > \"$dir/$ELDRUN_TAB_UID\"\n\
         exit 0\n",
        live_dir = live_dir,
    )
}

/// PowerShell hook body (Windows). Mirrors the POSIX script: reads the SessionStart
/// JSON on stdin, extracts `session_id` with a regex (no jq/`Get-Content` JSON
/// dependency), and writes it to `<live_dir>/<ELDRUN_TAB_UID>` using the same key
/// scheme `read_live_session` reads back. No-op unless launched by Eldrun
/// (`ELDRUN_TAB_UID` set); the uuid-ish guard doubles as path-traversal defense.
/// `[IO.File]::WriteAllText` writes UTF-8 *without* a BOM, so the stored id round-
/// trips cleanly through `read_live_session`'s `trim()`/`is_uuidish` checks.
#[cfg(windows)]
fn hook_script_body(live_dir: &str) -> String {
    // `live_dir` is a Windows path (backslashes); embed it in a single-quoted
    // PowerShell literal so backslashes are not treated as escapes.
    let live_dir = live_dir.replace('\'', "''");
    format!(
        "# Eldrun SessionStart hook - records the agent's live session id per tab so\r\n\
         # Eldrun can resume the current session (incl. after /clear). No-op unless\r\n\
         # launched by Eldrun (ELDRUN_TAB_UID set). Managed by Eldrun; do not edit.\r\n\
         $ErrorActionPreference = 'SilentlyContinue'\r\n\
         $uid = $env:ELDRUN_TAB_UID\r\n\
         if ([string]::IsNullOrEmpty($uid)) {{ exit 0 }}\r\n\
         if ($uid -notmatch '^[A-Za-z0-9-]+$') {{ exit 0 }}\r\n\
         $payload = [Console]::In.ReadToEnd()\r\n\
         $m = [regex]::Match($payload, '\"session_id\"\\s*:\\s*\"([0-9A-Fa-f-]+)\"')\r\n\
         if (-not $m.Success) {{ exit 0 }}\r\n\
         $sid = $m.Groups[1].Value\r\n\
         $dir = '{live_dir}'\r\n\
         [void](New-Item -ItemType Directory -Force -Path $dir -ErrorAction SilentlyContinue)\r\n\
         [IO.File]::WriteAllText((Join-Path $dir $uid), $sid)\r\n\
         exit 0\r\n",
        live_dir = live_dir,
    )
}

/// Merge our `SessionStart` handler into a Claude `settings.json`, preserving all
/// other content and other hooks. Idempotent: a handler already pointing at our
/// script is left untouched. The matcher is omitted so the hook fires for every
/// `source` (startup / resume / clear / compact).
fn register_hook_in_settings(settings_path: &std::path::Path) -> std::io::Result<()> {
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut root: serde_json::Value = std::fs::read_to_string(settings_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let cmd = hook_command();

    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let session_start = hooks
        .as_object_mut()
        .unwrap()
        .entry("SessionStart")
        .or_insert_with(|| serde_json::json!([]));
    if !session_start.is_array() {
        *session_start = serde_json::json!([]);
    }
    let arr = session_start.as_array_mut().unwrap();

    let already = arr.iter().any(|group| {
        group
            .get("hooks")
            .and_then(|h| h.as_array())
            .is_some_and(|hs| {
                hs.iter()
                    .any(|h| h.get("command").and_then(|c| c.as_str()) == Some(cmd.as_str()))
            })
    });
    if already {
        return Ok(());
    }
    arr.push(serde_json::json!({
        "hooks": [ { "type": "command", "command": cmd } ]
    }));

    let serialized = serde_json::to_string_pretty(&root)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(settings_path, serialized)?;
    Ok(())
}

/// Register our `SessionStart` hook in Codex's `~/.codex/config.toml`. Only acts
/// when `~/.codex` exists (Codex is in use). Codex config is TOML with no parser
/// dependency here, so we **text-append** an array-of-tables block rather than
/// reparse/reserialize the user's file (which would drop comments and reorder
/// their many `[projects.*]` tables). `[[hooks.SessionStart]]` is a top-level
/// array-of-tables, so appending at EOF is always valid regardless of preceding
/// content. Idempotent: skipped once our script path is present.
///
/// NOTE: user-level Codex hooks require a one-time trust approval (`/hooks` in
/// Codex) before they run, so resume tracking through *this* path is inert until
/// the user trusts it — see [`codex_hook_state`], which detects that, and
/// [`crate::services::codex_bind`], the hook-free fallback that keeps Codex tabs
/// resumable meanwhile.
fn register_codex_hook() -> std::io::Result<()> {
    let codex_dir = paths::home_dir().join(".codex");
    if !codex_dir.is_dir() {
        return Ok(());
    }
    register_codex_hook_in(&codex_dir.join("config.toml"))
}

/// Testable core of [`register_codex_hook`] against an explicit config path.
fn register_codex_hook_in(config_path: &std::path::Path) -> std::io::Result<()> {
    let cmd = hook_command();
    let mut content = std::fs::read_to_string(config_path).unwrap_or_default();
    if content.contains(&cmd) {
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&format!(
        "\n# Eldrun: record the live Codex session id per tab so Eldrun can resume\n\
         # the current session (incl. after /clear). Keyed by $ELDRUN_TAB_UID; a\n\
         # no-op for any Codex not launched by Eldrun. Managed by Eldrun.\n\
         [[hooks.SessionStart]]\n\
         matcher = \"startup|resume|clear|compact\"\n\n\
         [[hooks.SessionStart.hooks]]\n\
         type = \"command\"\n\
         command = '{cmd}'\n\
         timeout = 10\n",
        cmd = cmd,
    ));
    std::fs::write(config_path, content)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── agent session resolution ────────────────────────────────────────────

    /// Process-and-test-unique temp path. Tests run in parallel threads sharing
    /// one pid, so a counter keeps each test's dir distinct.
    fn unique_tmp(prefix: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()))
    }

    fn opts_with_args(args: &[&str]) -> PtyOptions {
        PtyOptions {
            id: "t".to_string(),
            cmd: "claude".to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: Default::default(),
            cwd: "/".to_string(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            project_id: None,
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
        }
    }

    /// Temp Claude `projects` root containing a persisted log for each given uuid.
    fn projects_with_sessions(uuids: &[&str]) -> std::path::PathBuf {
        let tmp = unique_tmp("eldrun-resolve");
        let proj = tmp.join("-encoded-cwd");
        std::fs::create_dir_all(&proj).unwrap();
        for u in uuids {
            std::fs::write(proj.join(format!("{u}.jsonl")), b"{}").unwrap();
        }
        tmp
    }

    #[test]
    fn resolve_dispatches_by_command() {
        // Non-tracked commands pass straight through.
        let mut opts = opts_with_args(&["--session-id", "abc-123"]);
        opts.cmd = "bash".to_string();
        let out = resolve_agent_session(opts);
        assert_eq!(out.cmd, "bash");
        assert_eq!(out.args, vec!["--session-id".to_string(), "abc-123".to_string()]);
    }

    #[test]
    fn resolve_is_a_noop_once_command_is_wrapped_to_ssh() {
        // Regression for the ssh-resume ordering bug: `wrap_pty_options` rewrites
        // `opts.cmd` to "ssh". If resolution ran AFTER wrapping, the dispatcher
        // would see "ssh" (not "claude"/"codex") and never inject resume args.
        // This asserts that an already-wrapped command is untouched, which is why
        // `pty_spawn` must resolve BEFORE wrapping.
        let mut opts = opts_with_args(&["-tt", "host", "exec claude --session-id abc"]);
        opts.cmd = "ssh".to_string();
        let out = resolve_agent_session(opts);
        assert_eq!(out.cmd, "ssh");
        assert_eq!(
            out.args,
            vec![
                "-tt".to_string(),
                "host".to_string(),
                "exec claude --session-id abc".to_string()
            ]
        );
        // And resume args are only ever injected while the command is still the
        // bare agent CLI (the pre-wrap state) — proven by the claude/codex tests.
    }

    #[test]
    fn resolve_keeps_session_id_when_no_log_exists() {
        // A never-used tab must not turn into `--resume` (Claude would exit with
        // "No conversation found with session ID ...").
        let uuid = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[]);
        let out =
            resolve_claude_session_impl(opts_with_args(&["--session-id", uuid]), &projects, |_| None);
        assert_eq!(out.args, vec!["--session-id".to_string(), uuid.to_string()]);
        // The launch id is always exposed to the SessionStart hook.
        assert_eq!(out.env.get("ELDRUN_TAB_UID").map(String::as_str), Some(uuid));
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_resumes_launch_id_when_its_log_exists() {
        let uuid = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[uuid]);
        let out =
            resolve_claude_session_impl(opts_with_args(&["--session-id", uuid]), &projects, |_| None);
        assert_eq!(out.args, vec!["--resume".to_string(), uuid.to_string()]);
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_follows_live_id_after_clear() {
        // After /clear the hook records a fresh live id under the launch key; we
        // resume that, not the (pre-clear) launch id.
        let launch = "00000000-0000-0000-0000-000000000000";
        let live = "99999999-8888-7777-6666-555555555555";
        let projects = projects_with_sessions(&[launch, live]);
        let out = resolve_claude_session_impl(
            // restore path passes `--resume <launch>`; we rewrite the id to live.
            opts_with_args(&["--resume", launch]),
            &projects,
            |uid| (uid == launch).then(|| live.to_string()),
        );
        assert_eq!(out.args, vec!["--resume".to_string(), live.to_string()]);
        assert_eq!(out.env.get("ELDRUN_TAB_UID").map(String::as_str), Some(launch));
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_downgrades_resume_without_log_to_session_id() {
        // Restore asked for `--resume <launch>` but no log exists (never-used tab)
        // → downgrade to `--session-id` so Claude starts fresh instead of erroring.
        let launch = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[]);
        let out = resolve_claude_session_impl(
            opts_with_args(&["--resume", launch]),
            &projects,
            |_| None,
        );
        assert_eq!(out.args, vec!["--session-id".to_string(), launch.to_string()]);
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_ignores_non_claude_commands() {
        let mut opts = opts_with_args(&["--session-id", "abc-123"]);
        opts.cmd = "bash".to_string();
        let projects = projects_with_sessions(&[]);
        let out = resolve_claude_session_impl(opts, &projects, |_| Some("x".to_string()));
        assert_eq!(out.args, vec!["--session-id".to_string(), "abc-123".to_string()]);
        assert!(out.env.get("ELDRUN_TAB_UID").is_none());
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn claude_session_exists_detects_persisted_log() {
        let tmp = std::env::temp_dir().join(format!("eldrun-sess-test-{}", std::process::id()));
        let proj = tmp.join("-some-encoded-cwd");
        std::fs::create_dir_all(&proj).unwrap();
        let uuid = "11111111-2222-3333-4444-555555555555";
        std::fs::write(proj.join(format!("{uuid}.jsonl")), b"{}").unwrap();

        assert!(claude_session_exists(&tmp, uuid));
        assert!(!claude_session_exists(&tmp, "no-such-uuid"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_leaves_args_without_session_flag_untouched() {
        let projects = projects_with_sessions(&[]);
        let out = resolve_claude_session_impl(opts_with_args(&["--foo", "bar"]), &projects, |_| None);
        assert_eq!(out.args, vec!["--foo".to_string(), "bar".to_string()]);
        let _ = std::fs::remove_dir_all(&projects);
    }

    /// Temp Codex sessions root with a `YYYY/MM/DD/rollout-…-<uuid>.jsonl` log.
    fn codex_sessions_with(uuid: &str) -> std::path::PathBuf {
        let tmp = unique_tmp("eldrun-codex-sess");
        let day = tmp.join("2026").join("06").join("08");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(
            day.join(format!("rollout-2026-06-08T17-10-09-{uuid}.jsonl")),
            b"{}",
        )
        .unwrap();
        tmp
    }

    fn codex_opts() -> PtyOptions {
        let mut o = opts_with_args(&[]);
        o.cmd = "codex".to_string();
        o
    }

    #[test]
    fn codex_resumes_live_id_when_rollout_exists() {
        let live = "019ea7c8-b7d5-7a13-80e2-1ad6608db5e6";
        let root = codex_sessions_with(live);
        let mut opts = codex_opts();
        opts.env.insert("ELDRUN_TAB_UID".to_string(), "tab-key-123".to_string());
        let out = resolve_codex_session_impl(opts, &root, |uid| {
            (uid == "tab-key-123").then(|| live.to_string())
        });
        assert_eq!(out.args, vec!["resume".to_string(), live.to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_starts_fresh_without_record_or_without_uid() {
        let root = codex_sessions_with("00000000-0000-0000-0000-000000000000");
        // No live record → fresh launch (args stay empty).
        let mut opts = codex_opts();
        opts.env.insert("ELDRUN_TAB_UID".to_string(), "tab-key".to_string());
        let out = resolve_codex_session_impl(opts, &root, |_| None);
        assert!(out.args.is_empty());
        // No ELDRUN_TAB_UID at all → cannot track → fresh launch.
        let out2 = resolve_codex_session_impl(codex_opts(), &root, |_| Some("x".to_string()));
        assert!(out2.args.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_ignores_when_recorded_session_missing_on_disk() {
        let root = codex_sessions_with("aaaaaaaa-0000-0000-0000-000000000000");
        let mut opts = codex_opts();
        opts.env.insert("ELDRUN_TAB_UID".to_string(), "tab-key".to_string());
        // Recorded id has no rollout log → don't pass a bad `resume` arg.
        let out = resolve_codex_session_impl(opts, &root, |_| {
            Some("ffffffff-1111-2222-3333-444444444444".to_string())
        });
        assert!(out.args.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── hook installer ──────────────────────────────────────────────────────

    #[test]
    fn read_live_session_round_trips_and_rejects_junk() {
        let tmp = std::env::temp_dir().join(format!("eldrun-live-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let uid = "11111111-2222-3333-4444-555555555555";
        let live = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        std::fs::write(tmp.join(uid), format!("{live}\n")).unwrap();

        assert_eq!(read_live_session_in(&tmp, uid).as_deref(), Some(live));
        assert_eq!(read_live_session_in(&tmp, "no-such-uid"), None);
        // path-traversal / non-uuid keys are refused before any read.
        assert_eq!(read_live_session_in(&tmp, "../etc/passwd"), None);

        // malformed stored value is rejected.
        std::fs::write(tmp.join(uid), "not a uuid!").unwrap();
        assert_eq!(read_live_session_in(&tmp, uid), None);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(not(windows))]
    #[test]
    fn hook_body_is_no_op_without_env_and_bakes_dir() {
        let body = hook_script_body("/home/x/.local/share/eldrun/live_sessions");
        assert!(body.starts_with("#!/bin/sh"));
        assert!(body.contains("[ -n \"$ELDRUN_TAB_UID\" ] || exit 0"));
        assert!(body.contains("/home/x/.local/share/eldrun/live_sessions"));
        assert!(body.contains("\"session_id\""));
    }

    #[cfg(windows)]
    #[test]
    fn hook_body_is_no_op_without_env_and_bakes_dir() {
        let body = hook_script_body(r"C:\Users\x\AppData\Roaming\eldrun\live_sessions");
        assert!(body.contains("$uid = $env:ELDRUN_TAB_UID"));
        assert!(body.contains("if ([string]::IsNullOrEmpty($uid)) { exit 0 }"));
        assert!(body.contains(r"C:\Users\x\AppData\Roaming\eldrun\live_sessions"));
        assert!(body.contains("\"session_id\""));
    }

    #[test]
    fn register_hook_is_idempotent_and_preserves_other_keys() {
        let tmp = std::env::temp_dir().join(format!("eldrun-settings-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let settings = tmp.join("settings.json");
        std::fs::write(&settings, r#"{"model":"opus","hooks":{"Stop":[{"hooks":[]}]}}"#).unwrap();

        register_hook_in_settings(&settings).unwrap();
        register_hook_in_settings(&settings).unwrap(); // second call must not duplicate

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        // unrelated keys survive
        assert_eq!(v["model"], "opus");
        assert!(v["hooks"]["Stop"].is_array());
        // exactly one SessionStart handler was added
        let ss = v["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(ss.len(), 1);
        let cmd = ss[0]["hooks"][0]["command"].as_str().unwrap();
        // unix registers the bare script path (ends with the name); Windows wraps it
        // in a `powershell ... -File "<path>"` invocation, so assert containment.
        assert!(cmd.contains(HOOK_SCRIPT_NAME));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn register_codex_hook_appends_once_and_preserves_toml() {
        let tmp = std::env::temp_dir().join(format!("eldrun-codex-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let config = tmp.join("config.toml");
        // A realistic pre-existing config with project tables.
        std::fs::write(
            &config,
            "model = \"o3\"\n\n[projects.\"/home/x\"]\ntrust_level = \"trusted\"\n",
        )
        .unwrap();

        register_codex_hook_in(&config).unwrap();
        register_codex_hook_in(&config).unwrap(); // idempotent

        let out = std::fs::read_to_string(&config).unwrap();
        // original content preserved verbatim at the top
        assert!(out.starts_with("model = \"o3\""));
        assert!(out.contains("[projects.\"/home/x\"]"));
        // hook appended exactly once
        assert_eq!(out.matches("[[hooks.SessionStart]]").count(), 1);
        assert!(out.contains("matcher = \"startup|resume|clear|compact\""));
        assert!(out.contains(HOOK_SCRIPT_NAME));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── Codex hook trust state ──────────────────────────────────────────────

    const CFG: &str = "/home/x/.codex/config.toml";
    const CMD: &str = "/home/x/.local/share/eldrun/hooks/eldrun_session_start.sh";

    /// Our hook block as `register_codex_hook_in` writes it.
    fn our_hook() -> String {
        format!(
            "[[hooks.SessionStart]]\n\
             matcher = \"startup|resume|clear|compact\"\n\n\
             [[hooks.SessionStart.hooks]]\n\
             type = \"command\"\n\
             command = '{CMD}'\n\
             timeout = 10\n"
        )
    }

    #[test]
    fn codex_hook_state_reports_disabled_when_the_trust_gate_is_off() {
        // Regression test for the bug this whole path exists to fix: Codex had
        // hashed our hook and recorded `enabled = false`, so it never ran and
        // Codex tabs silently restored blank.
        let src = format!(
            "model = \"o3\"\n\n{}\n[hooks.state]\n\n[hooks.state.\"{CFG}:session_start:0:0\"]\n\
             trusted_hash = \"sha256:93f0\"\nenabled = false\n",
            our_hook()
        );
        assert_eq!(codex_hook_state_in(&src, CFG, CMD), CodexHookState::Disabled);
    }

    #[test]
    fn codex_hook_state_reports_untrusted_without_a_verdict() {
        let src = our_hook();
        assert_eq!(codex_hook_state_in(&src, CFG, CMD), CodexHookState::Untrusted);
    }

    #[test]
    fn codex_hook_state_reports_enabled_when_trusted() {
        let src = format!(
            "{}\n[hooks.state.\"{CFG}:session_start:0:0\"]\nenabled = true\n",
            our_hook()
        );
        assert_eq!(codex_hook_state_in(&src, CFG, CMD), CodexHookState::Enabled);
    }

    #[test]
    fn codex_hook_state_indexes_our_hook_past_the_users_own() {
        // A user hook group precedes ours, so our verdict key is `:0:0` → no,
        // `:1:0`. Their `enabled = true` at `:0:0` must not be read as ours.
        let src = format!(
            "[[hooks.SessionStart]]\n\n[[hooks.SessionStart.hooks]]\n\
             type = \"command\"\ncommand = '/usr/bin/their-hook.sh'\n\n\
             {}\n[hooks.state.\"{CFG}:session_start:0:0\"]\nenabled = true\n",
            our_hook()
        );
        assert_eq!(codex_hook_state_in(&src, CFG, CMD), CodexHookState::Untrusted);

        // And with the verdict at *our* index, we read it.
        let trusted = format!("{src}\n[hooks.state.\"{CFG}:session_start:1:0\"]\nenabled = true\n");
        assert_eq!(
            codex_hook_state_in(&trusted, CFG, CMD),
            CodexHookState::Enabled
        );
    }

    #[test]
    fn codex_hook_state_is_not_registered_without_our_command() {
        let src = "model = \"o3\"\n\n[projects.\"/home/x\"]\ntrust_level = \"trusted\"\n";
        assert_eq!(
            codex_hook_state_in(src, CFG, CMD),
            CodexHookState::NotRegistered
        );
    }

    #[test]
    fn codex_hook_state_tolerates_a_config_path_spelled_differently() {
        // Codex builds the key from the path *it* resolved (symlinked CODEX_HOME,
        // macOS `/private` prefix …), so we fall back to matching our position.
        let src = format!(
            "{}\n[hooks.state.\"/private{CFG}:session_start:0:0\"]\nenabled = false\n",
            our_hook()
        );
        assert_eq!(codex_hook_state_in(&src, CFG, CMD), CodexHookState::Disabled);
    }

    #[test]
    fn write_live_session_round_trips_and_refuses_junk_keys() {
        let tmp = unique_tmp("eldrun-live-write");
        let uid = "11111111-2222-3333-4444-555555555555";
        let id = "019ea7c8-b7d5-7a13-80e2-1ad6608db5e6";

        write_live_session_in(&tmp, uid, id).unwrap();
        assert_eq!(read_live_session_in(&tmp, uid).as_deref(), Some(id));

        // The uid becomes a filename, so a traversal key must never be written.
        assert!(write_live_session_in(&tmp, "../../etc/passwd", id).is_err());
        assert!(write_live_session_in(&tmp, uid, "not a uuid!").is_err());
        // …and the good value survives the refused writes.
        assert_eq!(read_live_session_in(&tmp, uid).as_deref(), Some(id));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_codex_session_reads_a_binder_written_record() {
        // The seam the hook-free fallback relies on: whatever `codex_bind` writes
        // with `write_live_session_in` must come back out of the *unchanged*
        // resolve path as `codex resume <id>`.
        let live = "019ea7c8-b7d5-7a13-80e2-1ad6608db5e6";
        let uid = "11111111-2222-3333-4444-555555555555";
        let root = codex_sessions_with(live);
        let live_dir = unique_tmp("eldrun-live-seam");

        write_live_session_in(&live_dir, uid, live).unwrap();

        let mut opts = codex_opts();
        opts.env.insert("ELDRUN_TAB_UID".to_string(), uid.to_string());
        let out =
            resolve_codex_session_impl(opts, &root, |u| read_live_session_in(&live_dir, u));
        assert_eq!(out.args, vec!["resume".to_string(), live.to_string()]);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&live_dir);
    }
}
