//! Small pieces of old-name tolerance that code outside the migrator needs:
//! the script preambles that read an old environment variable, and the
//! mapping of an old tool or command name to the current one. Each is empty
//! or the identity while the name is unchanged.

use crate::brand::{Name, Pair};

/// `sh` lines that give each of the app's variables in `names` the value of
/// its old-named twin when it is unset or empty. A process an older build
/// started (an agent in a tmux session that outlived the update) has only
/// the old names in its environment, and it runs the scripts this build
/// writes. Empty while the prefix is unchanged, so the scripts are then
/// byte-for-byte what they were.
pub fn legacy_env_preamble_sh(pair: &Pair, names: &[&str]) -> String {
    let mut out = String::new();
    for name in names {
        if let Some(old) = pair.legacy_env_name(name) {
            let new = pair.cur.env_name(name);
            out.push_str(&format!(": \"${{{new}:=${{{old}:-}}}}\"\n"));
        }
    }
    out
}

/// The PowerShell twin of [`legacy_env_preamble_sh`], `\r\n`-terminated.
pub fn legacy_env_preamble_ps1(pair: &Pair, names: &[&str]) -> String {
    let mut out = String::new();
    for name in names {
        if let Some(old) = pair.legacy_env_name(name) {
            let new = pair.cur.env_name(name);
            out.push_str(&format!("if (-not $env:{new}) {{ $env:{new} = $env:{old} }}\r\n"));
        }
    }
    out
}

/// What follows the app's prefix in a tmux session name (`<slug>-<rest>`),
/// when `session` is one of the app's: under the current prefix, or under
/// the one an older build minted (counted as a legacy hit). Sessions on a
/// remote host outlive an update by weeks and end under their old names; new
/// ones are only ever minted under the current prefix.
pub fn tmux_session_rest<'a>(pair: &Pair, session: &'a str) -> Option<&'a str> {
    if let Some(rest) = session.strip_prefix(pair.cur(Name::TMUX_PREFIX).as_str()) {
        return Some(rest);
    }
    let rest = session.strip_prefix(pair.legacy(Name::TMUX_PREFIX)?.as_str())?;
    crate::brand::legacy_hit("tmux-prefix");
    Some(rest)
}

/// A shell fragment that removes the Ollama systemd drop-in an older build
/// wrote under the app's old name, to splice in before the `daemon-reload`
/// of the command that writes the current one: `sudo rm -f <old file> && `.
/// The drop-ins need root, so the old file can only go when the user next
/// runs that command — and it has to go then, or two drop-ins would set the
/// same variable. Empty while the name is unchanged.
pub fn ollama_dropin_cleanup(pair: &Pair, dropin: Name) -> String {
    match pair.legacy(dropin) {
        Some(old) => format!("sudo rm -f /etc/systemd/system/ollama.service.d/{old} && "),
        None => String::new(),
    }
}

/// The name of the manifest inside a project export, given which entries
/// the bundle `has`: the current name, or — for a bundle an older build wrote
/// — the old one (counted as a legacy hit). Old bundles sit in backups for
/// years, so this lookup is meant to stay.
pub fn export_manifest_name(pair: &Pair, has: impl Fn(&str) -> bool) -> String {
    let current = pair.cur(Name::EXPORT_MANIFEST);
    match pair.legacy(Name::EXPORT_MANIFEST) {
        Some(old) if !has(&current) && has(&old) => {
            crate::brand::legacy_hit("export-manifest");
            old
        }
        _ => current,
    }
}

/// The help MCP tools, whose names carry the app's name.
const HELP_TOOLS: [Name; 4] = [
    Name::HELP_TOOL_SEARCH,
    Name::HELP_TOOL_READ,
    Name::HELP_TOOL_TOPICS,
    Name::HELP_TOOL_STATUS,
];

/// The current name of an MCP tool a client called by the name an older
/// build listed (counted as a legacy hit), or `tool` itself. An agent
/// session that outlived the update still holds the old tool list.
pub fn current_tool_name<'a>(pair: &Pair, tool: &'a str) -> std::borrow::Cow<'a, str> {
    for name in HELP_TOOLS {
        if pair.legacy(name).as_deref() == Some(tool) {
            crate::brand::legacy_hit("mcp-tool");
            return pair.cur(name).into();
        }
    }
    tool.into()
}

/// The current command of a saved built-in tab (`__<slug>_mail__`) or the
/// app's time-log id, when `command` is the one an older build saved (counted
/// as a legacy hit); otherwise `command` itself.
pub fn current_tab_command<'a>(pair: &Pair, command: &'a str) -> std::borrow::Cow<'a, str> {
    if let Some(old_id) = pair.legacy(Name::APP_TIMER_ID) {
        if command == old_id {
            crate::brand::legacy_hit("timer-id");
            return pair.cur(Name::APP_TIMER_ID).into();
        }
    }
    let Some(old_prefix) = pair.legacy(Name::TAB_COMMAND_PREFIX) else {
        return command.into();
    };
    match command.strip_prefix(&old_prefix) {
        Some(view) if view.ends_with("__") => {
            crate::brand::legacy_hit("tab-command");
            format!("{}{view}", pair.cur(Name::TAB_COMMAND_PREFIX)).into()
        }
        _ => command.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::hits;
    use super::super::testing::RENAMED;
    use super::*;
    use crate::brand::{LEGACY, PAIR};

    #[test]
    fn the_preambles_are_empty_while_the_name_is_unchanged() {
        if PAIR.renamed() {
            return;
        }
        assert_eq!(legacy_env_preamble_sh(&PAIR, &["TAB_UID", "PROJECT_DIR"]), "");
        assert_eq!(legacy_env_preamble_ps1(&PAIR, &["TAB_UID"]), "");
    }

    #[test]
    fn the_powershell_preamble_reads_the_old_name() {
        assert_eq!(
            legacy_env_preamble_ps1(&RENAMED, &["TAB_UID"]),
            format!(
                "if (-not $env:NEWNAME_TAB_UID) {{ $env:NEWNAME_TAB_UID = $env:{} }}\r\n",
                LEGACY.env_name("TAB_UID")
            )
        );
    }

    /// Run the preamble in a real shell: the old value is taken when the
    /// current name is unset, and a current value wins.
    #[cfg(unix)]
    #[test]
    fn the_sh_preamble_gives_a_script_the_old_value() {
        let script = format!(
            "{}printf '%s|%s' \"$NEWNAME_TAB_UID\" \"$NEWNAME_PROJECT_DIR\"",
            legacy_env_preamble_sh(&RENAMED, &["TAB_UID", "PROJECT_DIR"])
        );
        let run = |env: &[(&str, &str)]| {
            let out = std::process::Command::new("sh")
                .args(["-c", &script])
                .env_clear()
                .envs(env.iter().copied())
                .output()
                .expect("sh runs");
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let old_uid = LEGACY.env_name("TAB_UID");
        let old_dir = LEGACY.env_name("PROJECT_DIR");
        assert_eq!(run(&[(&old_uid, "u-old"), (&old_dir, "/p")]), "u-old|/p");
        assert_eq!(run(&[(&old_uid, "u-old"), ("NEWNAME_TAB_UID", "u-new")]), "u-new|");
        assert_eq!(run(&[]), "|");
    }

    #[test]
    fn the_old_ollama_dropin_is_removed_by_the_command_that_writes_the_new_one() {
        assert_eq!(
            ollama_dropin_cleanup(&RENAMED, Name::OLLAMA_MODELS_DROPIN),
            format!(
                "sudo rm -f /etc/systemd/system/ollama.service.d/{} && ",
                LEGACY.name(Name::OLLAMA_MODELS_DROPIN)
            )
        );
        if !PAIR.renamed() {
            assert_eq!(ollama_dropin_cleanup(&PAIR, Name::OLLAMA_IGPU_DROPIN), "");
        }
    }

    #[test]
    fn an_export_written_by_an_older_build_is_still_recognised() {
        let _ = hits::taken();
        let old = LEGACY.name(Name::EXPORT_MANIFEST);
        assert_eq!(export_manifest_name(&RENAMED, |name| name == old), old);
        assert_eq!(hits::taken(), ["export-manifest"]);
        assert_eq!(export_manifest_name(&RENAMED, |name| name == "newname-export.json"), "newname-export.json");
        assert_eq!(export_manifest_name(&RENAMED, |_| true), "newname-export.json");
        // Neither inside: the current name, so the error names what is expected.
        assert_eq!(export_manifest_name(&RENAMED, |_| false), "newname-export.json");
        assert_eq!(export_manifest_name(&PAIR, |_| false), crate::brand::EXPORT_MANIFEST);
        assert!(hits::taken().is_empty());
    }

    #[test]
    fn a_tmux_session_is_the_apps_under_either_prefix() {
        let _ = hits::taken();
        let old = format!("{}p1--agent-0123456789", LEGACY.name(Name::TMUX_PREFIX));
        assert_eq!(tmux_session_rest(&RENAMED, &old), Some("p1--agent-0123456789"));
        assert_eq!(hits::taken(), ["tmux-prefix"]);
        assert_eq!(tmux_session_rest(&RENAMED, "newname-p1--shell-1"), Some("p1--shell-1"));
        assert_eq!(tmux_session_rest(&RENAMED, "train"), None);
        assert_eq!(
            tmux_session_rest(&PAIR, &format!("{}p1--x", crate::brand::TMUX_PREFIX)),
            Some("p1--x")
        );
        assert!(hits::taken().is_empty());
    }

    #[test]
    fn an_old_help_tool_name_maps_to_the_current_one_and_is_counted() {
        let _ = hits::taken();
        let old = LEGACY.name(Name::HELP_TOOL_SEARCH);
        assert_eq!(current_tool_name(&RENAMED, &old), "newname_help_search");
        assert_eq!(hits::taken(), ["mcp-tool"]);
        assert_eq!(current_tool_name(&RENAMED, "newname_help_read"), "newname_help_read");
        assert_eq!(current_tool_name(&RENAMED, "mail_search"), "mail_search");
        assert_eq!(current_tool_name(&PAIR, crate::brand::HELP_TOOL_READ), crate::brand::HELP_TOOL_READ);
        assert!(hits::taken().is_empty());
    }

    #[test]
    fn an_old_tab_command_maps_to_the_current_one_and_is_counted() {
        let _ = hits::taken();
        let old_mail = format!("{}mail__", LEGACY.name(Name::TAB_COMMAND_PREFIX));
        assert_eq!(current_tab_command(&RENAMED, &old_mail), "__newname_mail__");
        assert_eq!(current_tab_command(&RENAMED, &LEGACY.name(Name::APP_TIMER_ID)), "__newname__");
        assert_eq!(hits::taken(), ["tab-command", "timer-id"]);
        // A user's own command that merely starts alike, and current ones.
        let lookalike = format!("{}tool --flag", LEGACY.name(Name::TAB_COMMAND_PREFIX));
        assert_eq!(current_tab_command(&RENAMED, &lookalike), lookalike);
        assert_eq!(current_tab_command(&RENAMED, "bash"), "bash");
        assert_eq!(current_tab_command(&RENAMED, "__newname_mail__"), "__newname_mail__");
        assert_eq!(current_tab_command(&PAIR, crate::app_tab_command!("mail")), crate::app_tab_command!("mail"));
        assert!(hits::taken().is_empty());
    }
}
