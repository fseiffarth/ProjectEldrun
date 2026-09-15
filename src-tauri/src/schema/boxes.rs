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
    /// Eldrun Mobile reach (#31aa): whether this box's `box:<id>` scope is
    /// listed on a paired phone. Off by default and absent from disk while off,
    /// exactly like a project's `eldrun_mobile_access` — the sidecar reads this
    /// file directly, so the bit lives here and nowhere else.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub eldrun_mobile_access: bool,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Full `boxes.json` — an unordered list of project boxes (ordering is by each
/// box's `position`).
pub type BoxesList = Vec<ProjectBox>;

#[cfg(test)]
mod tests {
    use super::*;

    fn json<T: Serialize>(value: &T) -> Value {
        serde_json::to_value(value).expect("serialize")
    }

    /// Only `id` and `name` are required: a hand-edited or pre-#41 record
    /// loads with everything else defaulted.
    #[test]
    fn a_minimal_box_record_defaults_everything_else() {
        let b: ProjectBox = serde_json::from_str(r#"{"id":"b1","name":"Thesis"}"#).unwrap();
        assert!(b.member_ids.is_empty());
        assert_eq!(b.position, 0);
        assert!(b.folder.is_none());
        assert!(b.relations.is_empty());
        assert!(!b.eldrun_mobile_access);
        assert!(b.extra.is_empty());
    }

    /// The phone-reach bit is absent from disk while off and present only
    /// when on — the sidecar reads this file directly and keys on presence.
    #[test]
    fn mobile_access_is_written_only_while_on() {
        let off = ProjectBox {
            id: "b".into(),
            name: "n".into(),
            ..Default::default()
        };
        let out = json(&off);
        assert!(out.get("eldrun_mobile_access").is_none(), "{out}");
        assert!(out.get("relations").is_none(), "empty relations are omitted");
        assert!(out.get("folder").is_none());
        assert_eq!(out["member_ids"], serde_json::json!([]));
        assert_eq!(out["position"], 0);

        let on = ProjectBox {
            eldrun_mobile_access: true,
            ..off
        };
        assert_eq!(json(&on)["eldrun_mobile_access"], true);
        let back: ProjectBox = serde_json::from_value(json(&on)).unwrap();
        assert!(back.eldrun_mobile_access);
    }

    /// Relations keep their optional labels only when set, and unknown keys on
    /// both the box and a relation ride through `extra`.
    #[test]
    fn relations_and_unknown_keys_round_trip() {
        let raw = r##"{"id":"b","name":"n","member_ids":["p1","p2"],"position":150,
            "relations":[{"source":"p1","target":"p2","kind":"python-lib","weight":2}],
            "color":"#fff"}"##;
        let b: ProjectBox = serde_json::from_str(raw).unwrap();
        let rel = &b.relations[0];
        assert_eq!(rel.kind.as_deref(), Some("python-lib"));
        assert!(rel.hint.is_none());
        assert_eq!(rel.extra["weight"], 2);
        assert_eq!(b.extra["color"], "#fff");
        let out = json(&b);
        assert!(out["relations"][0].get("hint").is_none());
        assert_eq!(out["relations"][0]["weight"], 2);
        let back: ProjectBox = serde_json::from_value(out).unwrap();
        assert_eq!(back, b);
        let list: BoxesList = serde_json::from_str(&format!("[{raw}]")).unwrap();
        assert_eq!(list[0].member_ids, vec!["p1", "p2"]);
    }
}
