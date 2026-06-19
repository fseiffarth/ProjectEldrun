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

const HOOK_SCRIPT_NAME: &str = "eldrun_session_start.sh";

/// `~/.local/share/eldrun/live_sessions/` — one file per tab (named by the
/// tab's stable launch uuid) holding that tab's current live Claude session id.
pub fn live_sessions_dir() -> PathBuf {
    storage::state_dir().join("live_sessions")
}

fn hook_script_path() -> PathBuf {
    storage::state_dir().join("hooks").join(HOOK_SCRIPT_NAME)
}

/// uuid-ish guard: hex digits + dashes only, non-empty. Doubles as path-traversal
/// protection for the file key.
fn is_uuidish(s: &str) -> bool {
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
    let cmd = hook_script_path().to_string_lossy().into_owned();

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
/// Codex) before they run, so resume tracking is inert until the user trusts it.
fn register_codex_hook() -> std::io::Result<()> {
    let codex_dir = paths::home_dir().join(".codex");
    if !codex_dir.is_dir() {
        return Ok(());
    }
    register_codex_hook_in(&codex_dir.join("config.toml"))
}

/// Testable core of [`register_codex_hook`] against an explicit config path.
fn register_codex_hook_in(config_path: &std::path::Path) -> std::io::Result<()> {
    let cmd = hook_script_path().to_string_lossy().into_owned();
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

    #[test]
    fn hook_body_is_no_op_without_env_and_bakes_dir() {
        let body = hook_script_body("/home/x/.local/share/eldrun/live_sessions");
        assert!(body.starts_with("#!/bin/sh"));
        assert!(body.contains("[ -n \"$ELDRUN_TAB_UID\" ] || exit 0"));
        assert!(body.contains("/home/x/.local/share/eldrun/live_sessions"));
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
        assert!(cmd.ends_with(HOOK_SCRIPT_NAME));

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
}
