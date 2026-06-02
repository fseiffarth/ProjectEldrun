/// Tests for the Phase 1 service layer.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use eldrun_lib::commands::apps::{
    TrackedWindow, WindowRegistry, ORIGIN_GLOBAL_APP, ORIGIN_MANUAL_LAUNCH,
    ORIGIN_MIDDLE_FILE_BROWSER, ORIGIN_RESTORED, ORIGIN_RIGHT_FILE_TREE,
};
use eldrun_lib::schema::project::{OpenApp, Project, TabEntry};
use eldrun_lib::services::terminal_service;
use eldrun_lib::services::window_service;
use tempfile::TempDir;

// ── Helpers ───────────────────────────────────────────────────────────────

fn tracked(
    id: &str,
    project_id: Option<&str>,
    origin: &str,
    window_id: Option<u64>,
) -> TrackedWindow {
    TrackedWindow {
        id: id.to_string(),
        exec: "editor".to_string(),
        file: None,
        pid: 42,
        project_id: project_id.map(String::from),
        role: None,
        opened_at: 1.0,
        window_id,
        origin: origin.to_string(),
    }
}

fn make_registry(windows: Vec<TrackedWindow>) -> Arc<Mutex<WindowRegistry>> {
    let mut reg = WindowRegistry::default();
    for w in windows {
        reg.windows.insert(w.id.clone(), w);
    }
    Arc::new(Mutex::new(reg))
}

// ── window_service ────────────────────────────────────────────────────────

#[test]
fn project_window_ids_returns_only_project_owned() {
    let windows: HashMap<String, TrackedWindow> = [
        tracked("a", Some("p1"), ORIGIN_RIGHT_FILE_TREE, Some(10)),
        tracked("b", Some("p1"), ORIGIN_MIDDLE_FILE_BROWSER, Some(11)),
        tracked("c", Some("p1"), ORIGIN_RESTORED, Some(12)),
        tracked("d", Some("p1"), ORIGIN_GLOBAL_APP, Some(13)),
        tracked("e", Some("p1"), ORIGIN_MANUAL_LAUNCH, Some(14)),
        tracked("f", Some("p2"), ORIGIN_RIGHT_FILE_TREE, Some(20)),
        tracked("g", None, ORIGIN_RIGHT_FILE_TREE, Some(30)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let mut ids = window_service::project_window_ids(&windows, Some("p1"));
    ids.sort();
    assert_eq!(ids, vec![10, 11, 12]);
}

#[test]
fn project_tracked_ids_returns_registry_keys() {
    let windows: HashMap<String, TrackedWindow> = [
        tracked("a", Some("p1"), ORIGIN_RIGHT_FILE_TREE, Some(10)),
        tracked("b", Some("p1"), ORIGIN_RESTORED, Some(11)),
        tracked("c", Some("p1"), ORIGIN_MANUAL_LAUNCH, Some(12)),
        tracked("d", Some("p2"), ORIGIN_RIGHT_FILE_TREE, Some(20)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let mut ids = window_service::project_tracked_ids(&windows, Some("p1"));
    ids.sort();
    assert_eq!(ids, vec!["a", "b"]);
}

#[test]
fn root_scope_windows_are_none_project_id() {
    let windows: HashMap<String, TrackedWindow> = [
        tracked("root-w", None, ORIGIN_RIGHT_FILE_TREE, Some(99)),
        tracked("p1-w", Some("p1"), ORIGIN_RIGHT_FILE_TREE, Some(10)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let ids = window_service::project_window_ids(&windows, None);
    assert_eq!(ids, vec![99]);
}

#[test]
fn global_and_manual_windows_are_never_project_owned() {
    let windows: HashMap<String, TrackedWindow> = [
        tracked("g", None, ORIGIN_GLOBAL_APP, Some(1)),
        tracked("m", None, ORIGIN_MANUAL_LAUNCH, Some(2)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    assert!(window_service::project_window_ids(&windows, None).is_empty());
    assert!(window_service::project_tracked_ids(&windows, None).is_empty());
}

// ── terminal_service ──────────────────────────────────────────────────────

fn write_project_json(dir: &std::path::Path, project: &Project) -> PathBuf {
    let path = dir.join("project.json");
    let json = serde_json::to_string_pretty(project).unwrap();
    std::fs::write(&path, json).unwrap();
    path
}

#[test]
fn save_and_load_tab_layout_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "test-id".to_string(),
        name: "Test".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let local_file_str = local_file.to_string_lossy().to_string();

    let tabs = vec![
        TabEntry {
            key: "shell-1".to_string(),
            label: "Terminal".to_string(),
            cmd: "bash".to_string(),
            cwd: "/home/user".to_string(),
            extra: Default::default(),
        },
        TabEntry {
            key: "agent-2".to_string(),
            label: "Claude".to_string(),
            cmd: "claude".to_string(),
            cwd: "/home/user/project".to_string(),
            extra: Default::default(),
        },
    ];

    terminal_service::save_tab_layout(&local_file_str, &tabs).unwrap();
    let loaded = terminal_service::load_tab_layout(&local_file_str);

    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].key, "shell-1");
    assert_eq!(loaded[1].cmd, "claude");
}

#[test]
fn save_tab_layout_preserves_other_project_fields() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "preserve-me".to_string(),
        name: "MyProject".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        status: Some("active".to_string()),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let local_file_str = local_file.to_string_lossy().to_string();

    let tabs = vec![TabEntry {
        key: "s-1".to_string(),
        label: "Shell".to_string(),
        cmd: "bash".to_string(),
        cwd: "/tmp".to_string(),
        extra: Default::default(),
    }];
    terminal_service::save_tab_layout(&local_file_str, &tabs).unwrap();

    let reloaded: Project = eldrun_lib::storage::read_json(&local_file).unwrap();
    assert_eq!(reloaded.id, "preserve-me");
    assert_eq!(reloaded.name, "MyProject");
    assert_eq!(reloaded.status.as_deref(), Some("active"));
}

#[test]
fn load_tab_layout_returns_empty_for_missing_file() {
    let loaded = terminal_service::load_tab_layout("/nonexistent/project.json");
    assert!(loaded.is_empty());
}

#[test]
fn load_open_apps_returns_empty_when_none_saved() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "no-apps".to_string(),
        name: "NoApps".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let loaded = terminal_service::load_open_apps(&local_file.to_string_lossy());
    assert!(loaded.is_empty());
}

#[test]
fn save_empty_tabs_clears_layout_field() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "p".to_string(),
        name: "P".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        tab_layout: Some(vec![TabEntry {
            key: "old".to_string(),
            label: "Old".to_string(),
            cmd: "bash".to_string(),
            cwd: "/tmp".to_string(),
            extra: Default::default(),
        }]),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let path_str = local_file.to_string_lossy().to_string();

    terminal_service::save_tab_layout(&path_str, &[]).unwrap();

    let loaded = terminal_service::load_tab_layout(&path_str);
    assert!(loaded.is_empty());
}
