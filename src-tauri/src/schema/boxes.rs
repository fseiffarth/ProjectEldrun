use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A directed relation between two members of a box ("a change in `source` may
/// influence `target`"). Manual declaration is the baseline; auto-detection is a
/// deferred stretch goal (Phase 4).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct BoxRelation {
    /// Source project id (the one whose change ripples outward).
    pub source: String,
    /// Dependent project id (affected by a change in `source`).
    pub target: String,
    /// Optional relation kind/label, e.g. "python-lib".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Optional path/package hint, e.g. the local-path dep or package name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One entry in `~/.local/share/eldrun/boxes.json`.
///
/// Named `ProjectBox` (not `Box`) to avoid shadowing `std::boxed::Box`; the file
/// and JSON name stay `boxes`. Back-compat: only `id`/`name` are required, so an
/// older or hand-edited record deserializes with everything else defaulted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ProjectBox {
    pub id: String,
    pub name: String,
    /// Ordered project ids that are members of this box. Authoritative — the
    /// per-project `box_id` back-reference is a denormalized inverse and loses to
    /// this on any disagreement (see `reconcile_member_ids`).
    #[serde(default)]
    pub member_ids: Vec<String>,
    /// Ordering position among boxes/pills in the switcher (gap-spaced like
    /// project positions).
    #[serde(default)]
    pub position: i64,
    // ── #41 workspace metadata (Phase 2: stored; Phase 3/4: surfaced) ──
    /// Absolute path to the box folder under `~/eldrun/boxes/<name>/`. Filled in
    /// lazily on first box open (Phase 2). Absent for grouping-only boxes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Directed inter-project relations among members (Phase 2: stored;
    /// Phase 4: surfaced + auto-detected).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relations: Vec<BoxRelation>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Full `boxes.json` — an unordered list of project boxes (ordering is by each
/// box's `position`).
pub type BoxesList = Vec<ProjectBox>;
