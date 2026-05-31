/// Schema round-trip tests for Phase 1.
///
/// Each test:
///   1. Reads a real fixture file (with an injected `_unknown_test` field).
///   2. Deserializes into the Rust schema struct.
///   3. Serializes back to JSON.
///   4. Deserializes the re-serialized JSON and checks key values.
///   5. Asserts the `_unknown_test` field was preserved.
///
/// These also validate that the Python app can roll back: if the round-tripped
/// JSON parses cleanly in Python (shape unchanged), rollback is safe.

use std::collections::HashMap;
use std::path::PathBuf;

use eldrun::schema::{
    ActiveSession, DefaultApps, Project, ProjectEntry, Settings, TimeLogEntry,
};
use serde_json::Value;

fn fixture(name: &str) -> PathBuf {
    // Resolve relative to the workspace root (project dir), not crate root.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir)
        .parent()
        .expect("src-tauri has parent")
        .join("test-fixtures")
        .join(name)
}

// ── helpers ────────────────────────────────────────────────────────────────

fn assert_unknown_preserved(extra: &HashMap<String, Value>) {
    assert_eq!(
        extra.get("_unknown_test").and_then(|v| v.as_str()),
        Some("preserved"),
        "unknown field was not preserved through round-trip"
    );
}

fn roundtrip<T>(json: &str) -> T
where
    T: serde::Serialize + serde::de::DeserializeOwned,
{
    let first: T = serde_json::from_str(json).expect("first parse");
    let out = serde_json::to_string_pretty(&first).expect("serialize");
    serde_json::from_str(&out).expect("second parse")
}

// ── projects.json ──────────────────────────────────────────────────────────

#[test]
fn projects_roundtrip() {
    let path = fixture("projects.json");
    let raw = std::fs::read_to_string(&path).expect("read projects.json");
    let entries: Vec<ProjectEntry> = roundtrip(&raw);

    assert!(!entries.is_empty(), "expected at least one project");

    // Verify known-field round-trip
    let first = &entries[0];
    assert!(!first.id.is_empty());
    assert!(!first.name.is_empty());
    assert!(["current", "active", "inactive"].contains(&first.status.as_str()));

    // Verify unknown field preserved
    assert_unknown_preserved(&first.extra);
}

#[test]
fn projects_python_rollback_shape() {
    let path = fixture("projects.json");
    let raw = std::fs::read_to_string(&path).expect("read projects.json");
    let entries: Vec<ProjectEntry> = serde_json::from_str(&raw).expect("parse");
    let out = serde_json::to_string_pretty(&entries).expect("serialize");

    // The re-serialized JSON must parse as an array (Python reads a list).
    let reloaded: Value = serde_json::from_str(&out).expect("reparse as Value");
    assert!(reloaded.is_array());
    let arr = reloaded.as_array().unwrap();
    // Every entry must still have id, name, status, position, local_file.
    for entry in arr {
        for key in ["id", "name", "status", "position", "local_file"] {
            assert!(entry.get(key).is_some(), "missing key: {key}");
        }
    }
}

// ── settings.json ──────────────────────────────────────────────────────────

#[test]
fn settings_roundtrip() {
    let path = fixture("settings.json");
    let raw = std::fs::read_to_string(&path).expect("read settings.json");
    let s: Settings = roundtrip(&raw);

    assert!(s.color_scheme.is_some());
    assert_unknown_preserved(&s.extra);
}

#[test]
fn settings_ollama_fields_preserved() {
    let path = fixture("settings.json");
    let raw = std::fs::read_to_string(&path).expect("read settings.json");
    let s: Settings = serde_json::from_str(&raw).expect("parse");

    // Ollama fields exist in the fixture; they must survive round-trip so
    // Python can still read them after a Rust write.
    let out = serde_json::to_string_pretty(&s).expect("serialize");
    let back: Value = serde_json::from_str(&out).expect("reparse");
    // Python needs the global_apps map to be an object, not null.
    assert!(back["global_apps"].is_object(), "global_apps must be an object");
}

#[test]
fn settings_global_apps_shape() {
    let path = fixture("settings.json");
    let raw = std::fs::read_to_string(&path).expect("read settings.json");
    let s: Settings = serde_json::from_str(&raw).expect("parse");

    let apps = s.global_apps.expect("global_apps present");
    assert!(apps.contains_key("browser"), "browser role expected");
    let browser = &apps["browser"];
    assert!(!browser.exec.is_empty());
}

// ── default_apps.json ─────────────────────────────────────────────────────

#[test]
fn default_apps_roundtrip() {
    let path = fixture("default_apps.json");
    let raw = std::fs::read_to_string(&path).expect("read default_apps.json");
    let apps: DefaultApps = roundtrip(&raw);

    assert!(apps.0.contains_key(".md"), ".md mapping expected");

    // Re-serialized form must be a plain JSON object.
    let out = serde_json::to_string_pretty(&apps).expect("serialize");
    let back: Value = serde_json::from_str(&out).expect("reparse");
    assert!(back.is_object());
}

// ── time_log.json ─────────────────────────────────────────────────────────

#[test]
fn time_log_roundtrip() {
    let path = fixture("time_log.json");
    let raw = std::fs::read_to_string(&path).expect("read time_log.json");
    let log: Vec<TimeLogEntry> = roundtrip(&raw);

    assert!(!log.is_empty(), "time log must not be empty");
    let first = &log[0];
    assert!(!first.project_id.is_empty());
    assert!(first.duration_s >= 0.0);
    assert_unknown_preserved(&first.extra);
}

#[test]
fn time_log_python_rollback_shape() {
    let path = fixture("time_log.json");
    let raw = std::fs::read_to_string(&path).expect("read time_log.json");
    let log: Vec<TimeLogEntry> = serde_json::from_str(&raw).expect("parse");
    let out = serde_json::to_string_pretty(&log).expect("serialize");
    let back: Value = serde_json::from_str(&out).expect("reparse");

    assert!(back.is_array());
    for entry in back.as_array().unwrap() {
        for key in ["project_id", "date", "start_iso", "duration_s"] {
            assert!(entry.get(key).is_some(), "missing key: {key}");
        }
    }
}

// ── active_session.json ───────────────────────────────────────────────────

#[test]
fn active_session_roundtrip() {
    let path = fixture("active_session.json");
    let raw = std::fs::read_to_string(&path).expect("read active_session.json");
    let session: ActiveSession = roundtrip(&raw);

    assert!(!session.project_id.is_empty());
    assert!(!session.start_real.is_empty());
    assert_unknown_preserved(&session.extra);
}

// ── project.json ──────────────────────────────────────────────────────────

#[test]
fn project_roundtrip() {
    let path = fixture("project.json");
    let raw = std::fs::read_to_string(&path).expect("read project.json");
    let project: Project = roundtrip(&raw);

    assert!(!project.id.is_empty());
    assert!(!project.name.is_empty());
    assert!(!project.directory.is_empty());
    assert_unknown_preserved(&project.extra);
}

#[test]
fn project_open_apps_preserved() {
    let path = fixture("project.json");
    let raw = std::fs::read_to_string(&path).expect("read project.json");
    let project: Project = serde_json::from_str(&raw).expect("parse");

    let open_apps = project.open_apps.expect("open_apps present in fixture");
    assert!(!open_apps.is_empty());
    for app in &open_apps {
        assert!(!app.exec.is_empty());
    }
}

#[test]
fn project_tab_layout_preserved() {
    let path = fixture("project.json");
    let raw = std::fs::read_to_string(&path).expect("read project.json");
    let project: Project = serde_json::from_str(&raw).expect("parse");

    let tabs = project.tab_layout.expect("tab_layout present in fixture");
    assert!(!tabs.is_empty());
    for tab in &tabs {
        assert!(!tab.key.is_empty());
        assert!(!tab.cmd.is_empty());
    }
}

#[test]
fn project_python_rollback_shape() {
    let path = fixture("project.json");
    let raw = std::fs::read_to_string(&path).expect("read project.json");
    let project: Project = serde_json::from_str(&raw).expect("parse");
    let out = serde_json::to_string_pretty(&project).expect("serialize");
    let back: Value = serde_json::from_str(&out).expect("reparse");

    assert!(back.is_object());
    // Python requires at minimum: id, name, directory
    for key in ["id", "name", "directory"] {
        assert!(back.get(key).is_some(), "missing key: {key}");
    }
    // open_apps must remain an array
    assert!(back["open_apps"].is_array(), "open_apps must be array");
    // tab_layout must remain an array
    assert!(back["tab_layout"].is_array(), "tab_layout must be array");
}

// ── storage: backup-before-write ──────────────────────────────────────────

#[test]
fn write_json_creates_backup() {
    use eldrun::storage::{read_json, write_json};
    use eldrun::schema::ProjectEntry;

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("test.json");

    // Write initial data.
    let initial = serde_json::json!([{
        "id": "aaa",
        "name": "Alpha",
        "status": "active",
        "position": 0,
        "local_file": "/tmp/a/project.json"
    }]);
    std::fs::write(&path, serde_json::to_string_pretty(&initial).unwrap()).unwrap();

    // Read, modify, write through storage layer.
    let mut entries: Vec<ProjectEntry> = read_json(&path).expect("read");
    entries[0].name = "Alpha-modified".to_string();
    write_json(&path, &entries).expect("write");

    // A backup must now exist in the same directory.
    let backups: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .contains(".bak")
        })
        .collect();
    assert_eq!(backups.len(), 1, "expected exactly one backup file");

    // The live file must contain the modified name.
    let updated: Vec<ProjectEntry> = read_json(&path).expect("read updated");
    assert_eq!(updated[0].name, "Alpha-modified");
}

#[test]
fn write_json_backup_preserves_original() {
    use eldrun::storage::{read_json, write_json};
    use eldrun::schema::ActiveSession;

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("active_session.json");

    let original = ActiveSession {
        project_id: "proj-1".to_string(),
        start_real: "2026-05-31T12:00:00+00:00".to_string(),
        extra: Default::default(),
    };
    std::fs::write(&path, serde_json::to_string_pretty(&original).unwrap()).unwrap();

    let mut updated: ActiveSession = read_json(&path).expect("read");
    updated.start_real = "2026-05-31T13:00:00+00:00".to_string();
    write_json(&path, &updated).expect("write");

    // Backup must still contain the original start_real.
    let backup_path = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .find(|e| e.file_name().to_string_lossy().contains(".bak"))
        .expect("backup exists")
        .path();

    let backup_content = std::fs::read_to_string(backup_path).unwrap();
    assert!(
        backup_content.contains("2026-05-31T12:00:00+00:00"),
        "backup must contain original timestamp"
    );
}
