//! Project boxes — meta-project grouping (TODO Group A: #13 + #41).
//!
//! Boxes live in their own sibling file `~/.local/share/eldrun/boxes.json` so the
//! existing `projects.json` stays byte-compatible for Python rollback. A box owns
//! the authoritative ordered `member_ids`; the per-project `box_id` back-reference
//! (carried in `ProjectEntry.extra`) is a denormalized inverse the frontend
//! derives from `member_ids` on load — see `reconcile_member_ids`. This module
//! never writes `projects.json`; the box store's actions persist both files.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::commands::projects::{sanitize_name, uuid_v4};
use crate::paths;
use crate::schema::boxes::{BoxRelation, BoxesList, ProjectBox};
use crate::storage;

/// Agent md files written into a box folder, paired with the member md file a
/// box file should link to (CLAUDE.md → members' CLAUDE.md, etc.).
const BOX_AGENT_DOCS: &[&str] = &["CLAUDE.md", "GEMINI.md", "AGENTS.md"];

/// Markers delimiting the Eldrun-managed link block inside a box agent doc. Only
/// the text between (and including) these lines is rewritten on regeneration, so
/// anything a user adds outside the block survives.
const BOX_LINKS_START: &str = "<!-- eldrun:box-links:start -->";
const BOX_LINKS_END: &str = "<!-- eldrun:box-links:end -->";

fn boxes_path() -> std::path::PathBuf {
    storage::state_dir().join("boxes.json")
}

fn read_boxes() -> Result<BoxesList, String> {
    let path = boxes_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    storage::read_json(&path).map_err(|e| e.to_string())
}

fn write_boxes(boxes: &BoxesList) -> Result<(), String> {
    storage::write_json(&boxes_path(), boxes).map_err(|e| e.to_string())
}

/// Gap-spaced next position among boxes (mirrors `projects::next_position`).
fn next_box_position(boxes: &BoxesList) -> i64 {
    boxes.iter().map(|b| b.position).max().unwrap_or(0) + 10
}

/// Pure reconcile: drop any `member_ids` that no longer reference a known
/// project id. The set of valid project ids is supplied by the caller (read from
/// `projects.json`); this function never reads or writes either state file, so it
/// is freely unit-testable. It is the *only* reconcile the cargo tests target —
/// the `box_id` inverse recompute is frontend-side (no write-on-load).
pub(crate) fn reconcile_member_ids(boxes: BoxesList, project_ids: &HashSet<String>) -> BoxesList {
    boxes
        .into_iter()
        .map(|mut b| {
            b.member_ids.retain(|id| project_ids.contains(id));
            b
        })
        .collect()
}

/// Read the set of known project ids from `projects.json` (empty if absent).
/// Used only to reconcile boxes in-memory; never mutates `projects.json`.
fn known_project_ids() -> HashSet<String> {
    let path = storage::state_dir().join("projects.json");
    if !path.exists() {
        return HashSet::new();
    }
    let list: crate::schema::projects::ProjectsList = match storage::read_json(&path) {
        Ok(list) => list,
        Err(_) => return HashSet::new(),
    };
    list.into_iter().map(|p| p.id).collect()
}

/// Resolve a box's ordered member ids to `(name, root_directory)` pairs by
/// reading `projects.json`. The root directory mirrors the frontend's
/// `resolveProjectDirectory`: the `directory` field if present, else the parent
/// of a `…/project.json` `local_file`. Members that don't resolve are skipped.
fn member_projects(member_ids: &[String]) -> Vec<(String, PathBuf)> {
    let path = storage::state_dir().join("projects.json");
    let list: crate::schema::projects::ProjectsList = if path.exists() {
        storage::read_json(&path).unwrap_or_default()
    } else {
        Vec::new()
    };
    member_ids
        .iter()
        .filter_map(|id| {
            let p = list.iter().find(|p| &p.id == id)?;
            let dir = project_directory(p)?;
            Some((p.name.clone(), dir))
        })
        .collect()
}

/// Mirror of the frontend `resolveProjectDirectory` for a single project entry.
fn project_directory(p: &crate::schema::projects::ProjectEntry) -> Option<PathBuf> {
    if let Some(Value::String(dir)) = p.extra.get("directory") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    p.local_file
        .strip_suffix("/project.json")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Build the Eldrun-managed link block for one box agent doc. Pure (no IO) so it
/// is unit-testable. `agent_file` is the filename of THIS doc (e.g. "CLAUDE.md");
/// each member is linked to its same-named md file plus its root path.
fn box_links_block(agent_file: &str, box_name: &str, members: &[(String, PathBuf)]) -> String {
    let mut out = String::new();
    out.push_str(BOX_LINKS_START);
    out.push('\n');
    out.push_str("<!-- Managed by Eldrun — do not edit between these markers. -->\n\n");
    out.push_str(&format!(
        "## Box \"{box_name}\" — member projects\n\nThis folder is an Eldrun project box grouping the projects below. Each entry \
links to the project root and its `{agent_file}`:\n\n"
    ));
    if members.is_empty() {
        out.push_str("_No member projects yet._\n");
    } else {
        for (name, dir) in members {
            let root = dir.to_string_lossy();
            // Build the doc link with a literal `/` rather than `Path::join`, so the
            // generated markdown is identical on every host OS (on Windows `join`
            // would splice in a `\`, producing a malformed link URL).
            let doc = format!("{}/{agent_file}", root.trim_end_matches(['/', '\\']));
            out.push_str(&format!(
                "- **{name}** — root: `{root}` · [`{agent_file}`]({doc})\n"
            ));
        }
    }
    out.push('\n');
    out.push_str(BOX_LINKS_END);
    out.push('\n');
    out
}

/// Splice a freshly-built link block into existing file content, replacing any
/// previous managed block (between the markers) and leaving the rest untouched.
/// When no file exists, `existing` is empty and a titled doc is created.
fn merge_box_doc(agent_file: &str, existing: &str, block: &str) -> String {
    if let (Some(start), Some(end)) = (existing.find(BOX_LINKS_START), existing.find(BOX_LINKS_END))
    {
        if end > start {
            let end = end + BOX_LINKS_END.len();
            // Drop a trailing newline right after the old end marker so we don't
            // accumulate blank lines on each regeneration.
            let tail = existing[end..].strip_prefix('\n').unwrap_or(&existing[end..]);
            return format!("{}{}\n{}", &existing[..start], block.trim_end(), tail);
        }
    }
    if existing.trim().is_empty() {
        let title = agent_file.strip_suffix(".md").unwrap_or(agent_file);
        return format!("# {title} — Eldrun box context\n\n{block}");
    }
    // Existing content without a managed block: append the block at the end.
    format!("{}\n\n{block}", existing.trim_end())
}

/// Write/refresh the box agent docs (CLAUDE/GEMINI/AGENTS) in `folder`, each with
/// a managed link block pointing at the member project roots + their md files.
fn write_box_agent_docs(
    folder: &Path,
    box_name: &str,
    members: &[(String, PathBuf)],
) -> std::io::Result<()> {
    for agent_file in BOX_AGENT_DOCS {
        let path = folder.join(agent_file);
        let existing = fs::read_to_string(&path).unwrap_or_default();
        let block = box_links_block(agent_file, box_name, members);
        let merged = merge_box_doc(agent_file, &existing, &block);
        fs::write(&path, merged)?;
    }
    Ok(())
}

// ── Box CRUD (Phase 1) ──────────────────────────────────────────────────────

#[tauri::command]
pub fn get_boxes() -> Result<BoxesList, String> {
    // Reconcile against the current project ids in-memory so a deleted project
    // never leaves a dangling member id in what the frontend sees. No surprise
    // write: the corrected list is persisted on the next mutating box action.
    let boxes = read_boxes()?;
    Ok(reconcile_member_ids(boxes, &known_project_ids()))
}

#[tauri::command]
pub fn save_boxes(boxes: BoxesList) -> Result<(), String> {
    write_boxes(&boxes)
}

#[tauri::command]
pub fn create_box(name: String) -> Result<ProjectBox, String> {
    let mut boxes = read_boxes()?;
    // Guard against time-based `uuid_v4` collisions for back-to-back creation.
    let existing: HashSet<String> = boxes.iter().map(|b| b.id.clone()).collect();
    let mut id = uuid_v4();
    while existing.contains(&id) {
        id = uuid_v4();
    }
    let position = next_box_position(&boxes);
    let new_box = ProjectBox {
        id,
        name,
        member_ids: vec![],
        position,
        folder: None,
        relations: vec![],
        extra: Default::default(),
    };
    boxes.push(new_box.clone());
    write_boxes(&boxes)?;
    Ok(new_box)
}

#[tauri::command]
pub fn rename_box(box_id: String, name: String) -> Result<ProjectBox, String> {
    let mut boxes = read_boxes()?;
    let target = boxes
        .iter_mut()
        .find(|b| b.id == box_id)
        .ok_or_else(|| format!("box '{box_id}' not found"))?;
    // Rename updates only the box record. Once a `folder` is resolved (on first
    // open) it stays authoritative; a later rename does not move it (documented
    // limitation — "rename + move folder" is a Phase 4 nicety).
    target.name = name;
    let updated = target.clone();
    write_boxes(&boxes)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_box(box_id: String) -> Result<(), String> {
    let mut boxes = read_boxes()?;
    let before = boxes.len();
    boxes.retain(|b| b.id != box_id);
    if boxes.len() == before {
        return Err(format!("box '{box_id}' not found"));
    }
    // The box folder (if any) is intentionally NOT deleted — it may hold user
    // data placed there. Clearing each former member's `box_id` is done
    // frontend-side via `save_projects` (a required step of `deleteBox`).
    write_boxes(&boxes)
}

#[tauri::command]
pub fn set_box_members(box_id: String, member_ids: Vec<String>) -> Result<ProjectBox, String> {
    let mut boxes = read_boxes()?;
    let target = boxes
        .iter_mut()
        .find(|b| b.id == box_id)
        .ok_or_else(|| format!("box '{box_id}' not found"))?;
    target.member_ids = member_ids;
    let updated = target.clone();
    write_boxes(&boxes)?;
    Ok(updated)
}

// ── Box folder + relations (Phase 2 groundwork) ─────────────────────────────

/// Resolve a unique on-disk folder name for `box_id` (named after `name`),
/// avoiding both folders already reserved by OTHER boxes in `boxes.json` and
/// directories that already exist on disk for an unrelated box. The chosen
/// absolute path is the return value; callers persist it into the box's `folder`.
fn resolve_box_folder(boxes: &BoxesList, box_id: &str, name: &str) -> std::path::PathBuf {
    let root = paths::boxes_root();
    // Folders already claimed by other boxes (reserved-but-maybe-not-created).
    let reserved: HashSet<String> = boxes
        .iter()
        .filter(|b| b.id != box_id)
        .filter_map(|b| b.folder.clone())
        .collect();

    let base = {
        let s = sanitize_name(name);
        if s.is_empty() {
            "box".to_string()
        } else {
            s
        }
    };

    // Try the bare name first, then suffix with a counter until the candidate is
    // neither reserved by another box nor an existing unrelated directory.
    let mut counter = 0u32;
    loop {
        let candidate_name = if counter == 0 {
            base.clone()
        } else {
            format!("{base}-{counter}")
        };
        let candidate = root.join(&candidate_name);
        let candidate_str = candidate.to_string_lossy().to_string();
        if !reserved.contains(&candidate_str) && !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

#[tauri::command]
pub fn ensure_box_folder(box_id: String) -> Result<String, String> {
    let mut boxes = read_boxes()?;
    let target = boxes
        .iter()
        .find(|b| b.id == box_id)
        .ok_or_else(|| format!("box '{box_id}' not found"))?;
    let name = target.name.clone();
    let member_ids = target.member_ids.clone();

    // If the box already has a resolved folder, that path is authoritative —
    // just (idempotently) ensure the directory exists. Otherwise (first open)
    // resolve a unique folder, create it, and persist the chosen path.
    let folder = if let Some(folder) = target.folder.clone() {
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        folder
    } else {
        let path = resolve_box_folder(&boxes, &box_id, &name);
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        let folder = path.to_string_lossy().to_string();
        if let Some(t) = boxes.iter_mut().find(|b| b.id == box_id) {
            t.folder = Some(folder.clone());
        }
        write_boxes(&boxes)?;
        folder
    };

    // Refresh the box agent docs with links to the current member roots (best
    // effort — a write failure here must not block opening the box).
    let members = member_projects(&member_ids);
    let _ = write_box_agent_docs(Path::new(&folder), &name, &members);
    Ok(folder)
}

/// Regenerate the box agent docs (CLAUDE/GEMINI/AGENTS link blocks) for a box
/// that already has a folder. No-op when the box has never been opened (no
/// `folder` yet) — we never create a folder here, only refresh existing docs.
#[tauri::command]
pub fn refresh_box_agent_docs(box_id: String) -> Result<(), String> {
    let boxes = read_boxes()?;
    let Some(b) = boxes.iter().find(|b| b.id == box_id) else {
        return Ok(());
    };
    let Some(folder) = b.folder.clone() else {
        return Ok(());
    };
    let folder = Path::new(&folder);
    if !folder.is_dir() {
        return Ok(());
    }
    let members = member_projects(&b.member_ids);
    write_box_agent_docs(folder, &b.name, &members).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_box_relations(
    box_id: String,
    relations: Vec<BoxRelation>,
) -> Result<ProjectBox, String> {
    let mut boxes = read_boxes()?;
    let target = boxes
        .iter_mut()
        .find(|b| b.id == box_id)
        .ok_or_else(|| format!("box '{box_id}' not found"))?;
    target.relations = relations;
    let updated = target.clone();
    write_boxes(&boxes)?;
    Ok(updated)
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_box(id: &str, members: &[&str]) -> ProjectBox {
        ProjectBox {
            id: id.to_string(),
            name: id.to_string(),
            member_ids: members.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    fn ids(values: &[&str]) -> HashSet<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reconcile_drops_unknown_member_ids() {
        let boxes = vec![mk_box("box1", &["p1", "ghost", "p2"])];
        let project_ids = ids(&["p1", "p2"]);
        let out = reconcile_member_ids(boxes, &project_ids);
        assert_eq!(out[0].member_ids, vec!["p1".to_string(), "p2".to_string()]);
    }

    #[test]
    fn reconcile_recomputes_box_id_inverse() {
        // The pure id-map derivation that the frontend `load()` mirrors: each
        // member id maps to its box; a project absent from every box has no box.
        let boxes = vec![mk_box("boxA", &["p1", "p2"]), mk_box("boxB", &["p3"])];
        let project_ids = ids(&["p1", "p2", "p3", "p4"]);
        let reconciled = reconcile_member_ids(boxes, &project_ids);

        let mut inverse: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for b in &reconciled {
            for m in &b.member_ids {
                inverse.insert(m.clone(), b.id.clone());
            }
        }
        assert_eq!(inverse.get("p1"), Some(&"boxA".to_string()));
        assert_eq!(inverse.get("p2"), Some(&"boxA".to_string()));
        assert_eq!(inverse.get("p3"), Some(&"boxB".to_string()));
        // p4 is in no box → ungrouped (a stale box_id on p4 would lose here).
        assert_eq!(inverse.get("p4"), None);
    }

    #[test]
    fn reconcile_drops_member_when_project_deleted() {
        // boxB's only member p3 is deleted → boxB ends up empty (renders inline).
        let boxes = vec![mk_box("boxB", &["p3"])];
        let project_ids = ids(&["p1", "p2"]);
        let out = reconcile_member_ids(boxes, &project_ids);
        assert!(out[0].member_ids.is_empty());
    }

    #[test]
    fn create_box_assigns_gap_spaced_position() {
        // Exercise the position helper directly (the command path writes to the
        // real state dir, which tests must not touch).
        let mut boxes: BoxesList = vec![];
        let p1 = next_box_position(&boxes);
        boxes.push(ProjectBox {
            id: "a".into(),
            name: "a".into(),
            position: p1,
            ..Default::default()
        });
        let p2 = next_box_position(&boxes);
        assert_eq!((p1, p2), (10, 20));
    }

    #[test]
    fn box_json_roundtrips_with_defaults() {
        // A {id,name}-only box deserializes (member_ids/relations default) and
        // re-serializes with `member_ids: []` present (no skip) but `folder` and
        // `relations` absent (serde skip on None / empty Vec).
        let json = r#"{"id":"b1","name":"Paper"}"#;
        let parsed: ProjectBox = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.member_ids, Vec::<String>::new());
        assert!(parsed.folder.is_none());
        assert!(parsed.relations.is_empty());

        let back = serde_json::to_string(&parsed).unwrap();
        assert!(back.contains("\"member_ids\":[]"), "got: {back}");
        assert!(!back.contains("folder"), "folder should be skipped: {back}");
        assert!(
            !back.contains("relations"),
            "relations should be skipped: {back}"
        );

        // Full round-trip equality.
        let reparsed: ProjectBox = serde_json::from_str(&back).unwrap();
        assert_eq!(parsed, reparsed);
    }

    #[test]
    fn resolve_box_folder_suffixes_on_collision() {
        // Two boxes named "Paper". The first claims `.../paper`; the second must
        // get a suffixed path even though neither dir exists on disk yet, because
        // the first box's `folder` is reserved in boxes.json.
        let root = paths::boxes_root();
        let first = root.join("paper").to_string_lossy().to_string();
        let boxes = vec![ProjectBox {
            id: "b1".into(),
            name: "Paper".into(),
            folder: Some(first.clone()),
            ..Default::default()
        }];
        let resolved = resolve_box_folder(&boxes, "b2", "Paper");
        assert_ne!(resolved.to_string_lossy().to_string(), first);
        assert_eq!(
            resolved,
            root.join("paper-1"),
            "second same-named box should get a -1 suffix"
        );
    }

    #[test]
    fn box_links_block_lists_members_with_matching_md() {
        let members = vec![
            ("Alpha".to_string(), PathBuf::from("/home/u/eldrun/projects/alpha")),
            ("Beta".to_string(), PathBuf::from("/home/u/eldrun/projects/beta")),
        ];
        let block = box_links_block("CLAUDE.md", "My Box", &members);
        assert!(block.starts_with(BOX_LINKS_START));
        assert!(block.trim_end().ends_with(BOX_LINKS_END));
        assert!(block.contains("My Box"));
        // Each member: root path + a link to its same-named (CLAUDE.md) doc.
        assert!(block.contains("root: `/home/u/eldrun/projects/alpha`"));
        assert!(block.contains("[`CLAUDE.md`](/home/u/eldrun/projects/alpha/CLAUDE.md)"));
        assert!(block.contains("[`CLAUDE.md`](/home/u/eldrun/projects/beta/CLAUDE.md)"));
        // The agent file name flows through, so GEMINI links point at GEMINI.md.
        let gem = box_links_block("GEMINI.md", "My Box", &members);
        assert!(gem.contains("[`GEMINI.md`](/home/u/eldrun/projects/alpha/GEMINI.md)"));
    }

    #[test]
    fn box_links_block_handles_no_members() {
        let block = box_links_block("AGENTS.md", "Empty", &[]);
        assert!(block.contains("_No member projects yet._"));
    }

    #[test]
    fn merge_box_doc_creates_titled_doc_when_empty() {
        let block = box_links_block("CLAUDE.md", "B", &[]);
        let merged = merge_box_doc("CLAUDE.md", "", &block);
        assert!(merged.starts_with("# CLAUDE — Eldrun box context"));
        assert!(merged.contains(BOX_LINKS_START));
    }

    #[test]
    fn merge_box_doc_replaces_only_managed_block() {
        let first = box_links_block(
            "CLAUDE.md",
            "B",
            &[("Old".to_string(), PathBuf::from("/p/old"))],
        );
        let doc = merge_box_doc("CLAUDE.md", "", &first);
        // User edits the file outside the managed block.
        let edited = format!("{doc}\n\n## My notes\nkeep me\n");
        let second = box_links_block(
            "CLAUDE.md",
            "B",
            &[("New".to_string(), PathBuf::from("/p/new"))],
        );
        let merged = merge_box_doc("CLAUDE.md", &edited, &second);
        assert!(merged.contains("## My notes"));
        assert!(merged.contains("keep me"));
        assert!(merged.contains("/p/new"));
        assert!(!merged.contains("/p/old"), "old member should be gone");
        // Exactly one managed block survives.
        assert_eq!(merged.matches(BOX_LINKS_START).count(), 1);
        assert_eq!(merged.matches(BOX_LINKS_END).count(), 1);
    }

    #[test]
    fn resolve_box_folder_uses_bare_name_when_free() {
        let root = paths::boxes_root();
        let boxes: BoxesList = vec![];
        // Use a name unlikely to exist on disk under the real boxes root.
        let resolved = resolve_box_folder(&boxes, "b1", "Zzq-Boxname-Unlikely-To-Exist-9281");
        assert_eq!(
            resolved,
            root.join("zzq-boxname-unlikely-to-exist-9281"),
            "a free, non-existent name resolves to the bare sanitized path"
        );
    }
}
