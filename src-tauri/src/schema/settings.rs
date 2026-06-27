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
    pub terminal_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_management: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_profile_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_scheme: Option<String>,
    /// Preserved for Python rollback; not used by the Tauri app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ollama_host: Option<String>,
    /// Preserved for Python rollback; not used by the Tauri app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ollama_model: Option<String>,
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
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
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
    /// (default), `"block"`, or `"scope"`. Cycled live in-editor with
    /// Ctrl+Shift+Space; this is just the starting mode. Absent → `"sentence"`.
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
        self.color_scheme.as_deref().unwrap_or("fancy_dark")
    }

    pub fn workspace_management(&self) -> bool {
        self.workspace_management.unwrap_or(false)
    }

    /// Whether Claude agent tabs should be spawned with `--remote-control`.
    /// Defaults ON when unset so existing settings files opt in automatically.
    pub fn agent_remote_control(&self) -> bool {
        self.agent_remote_control.unwrap_or(true)
    }
}
