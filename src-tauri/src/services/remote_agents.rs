//! Detect-and-bootstrap recipes for remote agent CLIs.
//!
//! A remote agent (#28b) runs *on* the remote host, so its CLI must exist there.
//! Rather than a separate install step, we fold a tiny POSIX-sh prelude into the
//! remote command (`ssh_exec::remote_command`): inside the remote login shell,
//! `command -v <bin>` is probed and, if missing, a **userspace** (no sudo)
//! installer runs before the agent is exec'd. Progress and any first-run
//! `login` happen live in the PTY; an install failure prints an actionable
//! manual hint and aborts (`exit 127`) before exec.
//!
//! Recipes are matched by the spawn's command base name. Unknown commands get no
//! prelude — we never try to install something we don't recognise.

/// A known agent CLI and how to detect / install it on a remote host.
pub struct AgentRecipe {
    /// Executable probed with `command -v` and finally exec'd.
    pub bin: &'static str,
    /// POSIX-sh install command, userspace (no sudo), run when `bin` is absent.
    pub install: &'static str,
    /// Hint shown if auto-install fails, so the user can fix it by hand.
    pub manual_hint: &'static str,
}

/// The recipe table. Extend this to support more agents (Codex, Gemini, Vibe);
/// each entry just needs a probe binary name and a userspace install command.
static RECIPES: &[AgentRecipe] = &[AgentRecipe {
    bin: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    manual_hint: "npm install -g @anthropic-ai/claude-code (needs Node >= 18)",
}];

/// Look up the recipe for a spawn command, matching on its base name so an
/// absolute path (`/usr/bin/claude`) still resolves. `None` for unknown
/// commands.
pub fn recipe_for(cmd: &str) -> Option<&'static AgentRecipe> {
    let base = cmd.rsplit('/').next().unwrap_or(cmd);
    RECIPES.iter().find(|r| r.bin == base)
}

/// Build the POSIX-sh prelude that guarantees `recipe.bin` is present —
/// installing it userspace if needed — before the caller exec's it, run inside
/// the remote login shell. Probes once, installs if missing, then probes again
/// and aborts with `exit 127` + a manual hint if it is still absent. Returned as
/// a single `;`-joined line so it can be embedded in `$SHELL -lc '<…>'`.
pub fn bootstrap_prelude(recipe: &AgentRecipe) -> String {
    let AgentRecipe {
        bin,
        install,
        manual_hint,
    } = recipe;
    format!(
        "command -v {bin} >/dev/null 2>&1 || \
         {{ echo 'eldrun: {bin} not found on remote, installing...'; {install}; }}; \
         command -v {bin} >/dev/null 2>&1 || \
         {{ echo 'eldrun: {bin} not found and auto-install failed - install it manually: \
         {manual_hint}' >&2; exit 127; }}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipe_for_matches_base_name() {
        assert!(recipe_for("claude").is_some());
        assert!(recipe_for("/usr/local/bin/claude").is_some());
        assert!(recipe_for("definitely-not-an-agent").is_none());
    }

    #[test]
    fn bootstrap_prelude_probes_installs_and_aborts() {
        let r = recipe_for("claude").unwrap();
        let p = bootstrap_prelude(r);
        assert!(p.contains("command -v claude >/dev/null 2>&1"));
        assert!(p.contains("npm install -g @anthropic-ai/claude-code"));
        assert!(p.contains("exit 127"));
        // Probed twice: once before install, once after to confirm it worked.
        assert_eq!(p.matches("command -v claude").count(), 2);
    }
}
