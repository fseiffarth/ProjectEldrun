use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One entry in `settings["global_apps"]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalAppEntry {
    pub exec: String,
    pub visible: bool,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// `~/.local/share/eldrun/settings.json`.
///
/// Ollama fields (ollama_host, ollama_model, ollama_autostart) are preserved
/// as optional so existing files round-trip cleanly and the Python app can
/// still roll back. They are not used in Tauri app logic.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_profile_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_scheme: Option<String>,
    /// Global UI zoom factor for the whole interface (helps on high-DPI/4K
    /// monitors). `1.0` (or unset) is 100% — the current default look. Applied
    /// frontend-side as a CSS `zoom`; the backend only round-trips the value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_zoom: Option<f32>,
    /// Calendar: first column of the week — `0` = Sunday (default), `1` = Monday.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_week_start: Option<u8>,
    /// Calendar: the view a fresh calendar tab opens on
    /// (`day`/`week`/`multiweek`/`month`/`agenda`/`tasks`). Frontend logic only —
    /// the backend just round-trips the value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_default_view: Option<String>,
    /// Calendar: 24-hour clock instead of AM/PM.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_time_format_24h: Option<bool>,
    /// Calendar: first/last hour the day and week grids scroll to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_day_start_hour: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_day_end_hour: Option<u8>,
    /// Calendar: minutes-before reminder pre-filled on a new event. `0` = none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_default_reminder_minutes: Option<i64>,
    /// Preserved for Python rollback; not used by the Tauri app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ollama_host: Option<String>,
    /// Preserved for Python rollback; not used by the Tauri app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ollama_model: Option<String>,
    /// Per-task local-model assignments set from the 🧠 menu's role chips. Maps a
    /// task key (`"autocomplete"`, `"grammar"`, `"tabs"`) to the model name that
    /// serves it, so several loaded models can run different jobs in parallel.
    /// Optional + flat so older settings files round-trip cleanly; a task absent
    /// here falls back to `ollama_model`. Frontend logic only — persisted here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ollama_roles: Option<HashMap<String, String>>,
    /// Preserved for Python rollback; not used by the Tauri app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ollama_autostart: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_agent_cmd: Option<String>,
    /// When true (the default), running a `.sh` from the right panel spawns it
    /// as a detached background process instead of opening a terminal tab.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_scripts_in_background: Option<bool>,
    /// When true (the default), `claude` agent tabs are spawned with
    /// `--remote-control` so the session can be monitored/steered from the Claude
    /// app/web. Only Claude supports the flag; other agents ignore it. Default ON.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_remote_control: Option<bool>,
    /// When true (the default), the usage recap opens by itself on the first
    /// launch of each day. Turning it off leaves the recap reachable from
    /// Settings — it stops the popup, it does not stop the counting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_stats_recap: Option<bool>,
    /// UTC date ("YYYY-MM-DD") the recap was last auto-shown, so it opens once a
    /// day rather than on every window. Written by the recap host itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_stats_last_shown: Option<String>,
    /// EXPERIMENTAL, default OFF. When true, agent tabs whose agent supports it
    /// (currently only Claude) show a Plan/Auto badge that switches the tab's
    /// authority mode — `--permission-mode plan` vs `acceptEdits`. Switching
    /// respawns the agent (the mode is a launch flag), which is only safe because
    /// the backend resumes the conversation; see `services::agent_session`. Purely
    /// a frontend gate: the flag reaches the backend inside `opts.args` like any
    /// other launch arg, so nothing in the spawn path reads this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_mode_toggle: Option<bool>,
    /// EXPERIMENTAL, default OFF. When true, a Python file in the native code
    /// viewer gets the Run/Debug buttons and the breakpoint gutter (#87). Purely a
    /// frontend gate, and off by default because Run *executes the file*: the
    /// button is one click from an editor, so it is opt-in rather than something a
    /// user discovers by mis-clicking. Go-to-definition is not gated — it reads,
    /// it never runs anything. Nothing in the backend reads this: Run/Debug open an
    /// ordinary terminal tab, which reaches `pty_spawn` like any other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub python_run_debug: Option<bool>,
    /// Persistent LOCAL (tmux) sessions (TODO #85): when true (the default on Unix),
    /// a local project's shell/script tabs run inside a tmux session on the machine,
    /// so a long run survives an Eldrun crash and the tab reattaches on restart.
    /// `None`/`Some(true)` = on; `Some(false)` = off. No effect on Windows (no tmux):
    /// `services::tmux_local` no-ops there. Read via `persist_local_sessions()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persist_local_sessions: Option<bool>,
    /// When true (the default), remote SSH/OpenVPN connections are made headlessly
    /// in the background, with Eldrun handling the password transiently (sshpass /
    /// askpass). When false, those connections are launched as interactive
    /// terminal tabs in the Eldrun **root** scope so the password is typed directly
    /// into the live terminal and Eldrun never handles it at all. Default ON
    /// (headless) so existing behaviour is preserved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connections_headless: Option<bool>,
    /// Path of the stored `.ovpn` config Eldrun brings up **on launch**, with no
    /// project behind it. Unset (the default) = no tunnel is started by itself.
    ///
    /// One config, not a list: a tunnel reroutes the whole machine, so arming two
    /// would be arming them to fight over the routing. The frontend re-checks at
    /// launch that the connect can still be made without a prompt and stays down if
    /// it can't (see `lib/vpnAutoConnect.ts`); the backend only round-trips this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vpn_auto_connect: Option<String>,
    /// Energy-saver mode: "off" | "battery" (default) | "always". When active
    /// (mode "always", or "battery" while discharging) Eldrun pauses the blob
    /// auto-spin, collapses idle animations, and widens always-on UI timers.
    /// Read entirely on the frontend; kept here only so it round-trips.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy_saver: Option<String>,
    /// Header resource-monitor row toggles. Each defaults ON when unset so the
    /// pill shows CPU/RAM/GPU by default; flip one off to hide that row. Shown in
    /// every build (independent of `debug`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_cpu_usage: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_ram_usage: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_gpu_usage: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global_apps: Option<HashMap<String, GlobalAppEntry>>,
    /// Minimum subwindow (split pane) width in px a divider drag may shrink a
    /// pane to. Unset falls back to the frontend's DEFAULT_MIN_SUBWINDOW_PX.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_subwindow_width: Option<u32>,
    /// Minimum subwindow (split pane) height in px a divider drag may shrink a
    /// pane to. Unset falls back to the frontend's DEFAULT_MIN_SUBWINDOW_PX.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_subwindow_height: Option<u32>,
    /// When true, the in-app text/TeX/markdown viewers debounce-save edits to
    /// disk automatically (#47). Defaults OFF; the #43 diff-aware reload is its
    /// counterpart for external changes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub autosave: Option<bool>,
    /// When true (the default), the in-app text/TeX editors tint recently typed
    /// runs with a sequential new→old colour trail that fades as typing
    /// continues. Defaults ON; only an explicit `false` disables it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_tint: Option<bool>,
    /// Per-file-type native-viewer preferences (#48), keyed by a type id derived
    /// from `fileUtils` (e.g. "tex", "text", "markdown"). Holds the opt-in
    /// autocomplete toggle (#45). Optional + flat so older settings files
    /// round-trip cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_prefs: Option<HashMap<String, ViewerPref>>,
    /// User overrides for the rebindable navigation chords (Group L / #62),
    /// keyed by action id (e.g. "cycleTabs", "closeTab"). Optional + defaulted
    /// so existing settings.json files without it still load; unset actions
    /// fall back to the built-in defaults in the frontend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyboard_shortcuts: Option<HashMap<String, ChordDescriptor>>,
    /// Download *source* folders scanned by the right-panel Downloads section
    /// (fast-copy of freshly downloaded files into a project). A machine-wide
    /// list, read-only — Eldrun never changes any browser's download path.
    /// Unset/empty → the frontend falls back to the user's `~/Downloads`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_sources: Option<Vec<String>>,
    /// Where the MAIN window was when Eldrun last ran, so it reopens on the same
    /// monitor in the same place. Unset (fresh install, or a saved rect no live
    /// monitor can host) → the window opens as `tauri.conf.json` configures it:
    /// maximized, wherever the WM puts it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_state: Option<WindowState>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Last-known geometry of the MAIN window, in PHYSICAL desktop pixels — the
/// canonical cross-window coordinate space (see `src/lib/coords.ts`). Tauri's
/// `outerPosition`/`outerSize`/`set_position`/`set_size` are all physical; only a
/// *builder*'s `.position()`/`.inner_size()` are logical, which is the trap
/// `commands::subwindow::detached_position` exists to document.
///
/// `x`/`y`/`w`/`h` is the *restore* (non-maximized) rect: it is refreshed only
/// while the window is floating. Storing the maximized rect here instead would
/// recreate the bug `WindowControls.tsx` works around — a window whose only known
/// "normal" size is the whole monitor, so un-maximizing appears to do nothing and
/// KWin's edge-snap stays suppressed.
///
/// There is deliberately no `fullscreen` field. Linux must never enter fullscreen
/// (a `_NET_WM_STATE_FULLSCREEN` window is unmovable under KWin — see the note in
/// `lib.rs`'s setup), and macOS is unconditionally fullscreen. Persisting the flag
/// could only ever strand the window.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub maximized: bool,
}

/// One entry in `settings["keyboard_shortcuts"]` (Group L / #62). A serializable
/// key chord mirroring the frontend `ChordDescriptor`. The modifier flags default
/// to false when absent so the JSON stays compact.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChordDescriptor {
    pub key: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub ctrl: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub shift: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub alt: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub meta: bool,
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !*b
}

/// One per-type entry in `settings["viewer_prefs"]` (#48).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ViewerPref {
    /// Whether this native viewer is used at all. Absent/true renders the type
    /// in-app; false opts it out so its files open in the external default app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Whether Ctrl+Space local autocomplete is enabled for this type (#45).
    /// Defaults OFF (privacy: no model call unless explicitly turned on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autocomplete: Option<bool>,
    /// Default completion-length mode for this type (#45 modes): `"sentence"`
    /// (default), `"block"`, or `"scope"`. Cycled live in-editor with Shift+Tab
    /// while a suggestion is showing; this is just the starting mode. Absent →
    /// `"sentence"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autocomplete_mode: Option<String>,
    /// Whether the local-model grammar/spelling check is enabled for this type.
    /// Like `autocomplete`, defaults OFF (no model call unless explicitly on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grammar_check: Option<bool>,
    /// Editor font size in px for this type's in-app code editor. Adjusted from
    /// the viewer's A−/A+ controls (or Ctrl +/−/0). Unset falls back to the
    /// frontend default (12px).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f32>,
}

impl Settings {
    pub fn color_scheme(&self) -> &str {
        self.color_scheme.as_deref().unwrap_or("light_lavender")
    }

    /// Whether Claude agent tabs should be spawned with `--remote-control`.
    /// Defaults ON when unset so existing settings files opt in automatically.
    pub fn agent_remote_control(&self) -> bool {
        self.agent_remote_control.unwrap_or(true)
    }

    /// Whether the usage recap auto-opens once a day. Defaults ON when unset, so
    /// an existing install gets the recap without having to find the toggle.
    pub fn daily_stats_recap(&self) -> bool {
        self.daily_stats_recap.unwrap_or(true)
    }

    /// The rule every experimental flag follows (mirrors `src/lib/experimental.ts`):
    /// unset means **debug mode decides**, so someone building Eldrun gets each new
    /// experiment without re-ticking a list, and everyone else gets none of them. An
    /// explicit value always wins, in both directions — otherwise "turn this off"
    /// would silently fail for exactly the people most likely to hit a broken one.
    fn experimental(&self, flag: Option<bool>) -> bool {
        flag.unwrap_or_else(|| self.debug.unwrap_or(false))
    }

    /// Whether the experimental per-tab Plan/Auto agent-mode badge is offered.
    /// Switching a mode restarts the agent, so nobody outside debug mode gets that
    /// behaviour without asking for it.
    pub fn agent_mode_toggle(&self) -> bool {
        self.experimental(self.agent_mode_toggle)
    }

    /// Whether the experimental Python Run/Debug buttons and breakpoint gutter are
    /// offered in the code viewer. Run *executes the file*, so outside debug mode it
    /// is opt-in.
    pub fn python_run_debug(&self) -> bool {
        self.experimental(self.python_run_debug)
    }

    /// Whether LOCAL shell/script tabs are wrapped in a persistent tmux session
    /// (TODO #85). Default ON when unset; only an explicit `Some(false)` opts out.
    /// The caller still gates on `tmux_local::tmux_available()` (no tmux / Windows →
    /// no wrap regardless), so this is a preference, not a guarantee.
    pub fn persist_local_sessions(&self) -> bool {
        self.persist_local_sessions.unwrap_or(true)
    }

    /// Whether remote SSH/OpenVPN connections are made headlessly (Eldrun handles
    /// the password) rather than as interactive root-terminal tabs. Defaults ON
    /// (headless) when unset so existing behaviour is preserved.
    pub fn connections_headless(&self) -> bool {
        self.connections_headless.unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    use super::Settings;

    /// The experimental rule, backend side (the frontend twin lives in
    /// `src/__tests__/Experimental.test.ts`): unset defers to debug mode, and an
    /// explicit value wins in BOTH directions.
    #[test]
    fn experimental_flags_default_to_debug_mode() {
        let off = Settings::default();
        assert!(!off.python_run_debug());
        assert!(!off.agent_mode_toggle());

        let debug = Settings {
            debug: Some(true),
            ..Default::default()
        };
        assert!(debug.python_run_debug());
        assert!(debug.agent_mode_toggle());

        let debug_but_off = Settings {
            debug: Some(true),
            python_run_debug: Some(false),
            ..Default::default()
        };
        assert!(!debug_but_off.python_run_debug());

        let opted_in = Settings {
            python_run_debug: Some(true),
            ..Default::default()
        };
        assert!(opted_in.python_run_debug());
    }
}
