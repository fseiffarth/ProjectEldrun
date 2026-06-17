/// Tests for the Phase 1 service layer.
///
/// Tests that require a real filesystem use `tempfile::TempDir`.
/// Tests that require a workspace backend use `eldrun_lib::platform::null::NullBackend`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use eldrun_lib::commands::apps::{
    TrackedWindow, ORIGIN_GLOBAL_APP, ORIGIN_MANUAL_LAUNCH,
    ORIGIN_MIDDLE_FILE_BROWSER, ORIGIN_RESTORED, ORIGIN_RIGHT_FILE_TREE,
};
use eldrun_lib::platform::{WorkspaceBackend, WorkspaceInfo};
use eldrun_lib::schema::project::{Project, TabEntry};
use eldrun_lib::services::terminal_service;
use eldrun_lib::services::window_service;
use tempfile::TempDir;

// Suppress unused-import warnings: these are used in the workflow tests below.
#[allow(unused_imports)]
use eldrun_lib::schema::TerminalSession;

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

#[derive(Default)]
struct RecordingBackend {
    calls: Mutex<Vec<(String, u64)>>,
}

impl RecordingBackend {
    fn calls(&self) -> Vec<(String, u64)> {
        self.calls.lock().unwrap().clone()
    }
}

impl WorkspaceBackend for RecordingBackend {
    fn name(&self) -> &'static str {
        "recording"
    }

    fn info(&self) -> WorkspaceInfo {
        WorkspaceInfo {
            label: "test".to_string(),
            current_desktop: None,
            desktop_count: None,
        }
    }

    fn show_window(&self, window_id: u64) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .push(("show".to_string(), window_id));
        Ok(())
    }

    fn hide_window(&self, window_id: u64) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .push(("hide".to_string(), window_id));
        Ok(())
    }

    fn make_sticky(&self, _eldrun_pid: u32) -> Result<(), String> {
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        Ok(())
    }
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
fn save_and_load_right_panel_folder_roundtrip() {
    use eldrun_lib::services::project_runtime;
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "test-id".to_string(),
        name: "Test".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let local_file_str = local_file.to_string_lossy().to_string();

    // No session file yet -> nothing saved.
    assert_eq!(project_runtime::load_right_panel_folder(&local_file_str), None);

    project_runtime::save_right_panel_folder(&local_file_str, Some("src/components".to_string()))
        .unwrap();
    assert_eq!(
        project_runtime::load_right_panel_folder(&local_file_str),
        Some("src/components".to_string())
    );

    // Overwrite with a different folder (simulates navigating elsewhere).
    project_runtime::save_right_panel_folder(&local_file_str, Some("docs".to_string())).unwrap();
    assert_eq!(
        project_runtime::load_right_panel_folder(&local_file_str),
        Some("docs".to_string())
    );
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

// ── terminal_service: .eldrun/sessions/ ───────────────────────────────────

#[test]
fn save_terminal_session_writes_eldrun_file() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "p-sess".to_string(),
        name: "Session".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let path_str = local_file.to_string_lossy().to_string();

    let tabs = vec![TabEntry {
        key: "s1".to_string(),
        label: "Shell".to_string(),
        cmd: "bash".to_string(),
        cwd: "/tmp".to_string(),
        extra: Default::default(),
    }];
    terminal_service::save_terminal_session(&path_str, &tabs, 0).unwrap();

    let session_path = tmp.path().join(".eldrun/sessions/terminals.json");
    assert!(session_path.exists(), ".eldrun/sessions/terminals.json must be written");

    let session: eldrun_lib::schema::TerminalSession =
        eldrun_lib::storage::read_json(&session_path).unwrap();
    assert_eq!(session.tab_layout.len(), 1);
    assert_eq!(session.tab_layout[0].key, "s1");
}

#[test]
fn load_terminal_session_prefers_eldrun_over_project_json() {
    let tmp = TempDir::new().unwrap();
    // Write project.json with one tab.
    let project = Project {
        id: "p-pref".to_string(),
        name: "Prefer".to_string(),
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

    // Write .eldrun/sessions/terminals.json with a different tab.
    let sessions_dir = tmp.path().join(".eldrun/sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let session = eldrun_lib::schema::TerminalSession {
        tab_layout: vec![TabEntry {
            key: "new".to_string(),
            label: "New".to_string(),
            cmd: "claude".to_string(),
            cwd: "/home/user".to_string(),
            extra: Default::default(),
        }],
        active_tab_index: 0,
        extra: Default::default(),
    };
    eldrun_lib::storage::write_json(&sessions_dir.join("terminals.json"), &session).unwrap();

    let loaded = terminal_service::load_tab_layout(&path_str);
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].key, "new", "must prefer .eldrun/ over project.json");
}

#[test]
fn load_tab_layout_falls_back_to_project_json_when_no_eldrun() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "p-fall".to_string(),
        name: "Fallback".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        tab_layout: Some(vec![TabEntry {
            key: "fallback".to_string(),
            label: "Fallback".to_string(),
            cmd: "bash".to_string(),
            cwd: "/tmp".to_string(),
            extra: Default::default(),
        }]),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let path_str = local_file.to_string_lossy().to_string();

    // No .eldrun/ directory exists.
    let loaded = terminal_service::load_tab_layout(&path_str);
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].key, "fallback");
}

// ── window_service: session save/load ─────────────────────────────────────

#[test]
fn save_and_load_window_session_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "p-win".to_string(),
        name: "Win".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let path_str = local_file.to_string_lossy().to_string();

    let ids = vec!["win-1".to_string(), "win-2".to_string()];
    eldrun_lib::services::window_service::save_window_session(&path_str, &ids);

    let loaded = eldrun_lib::services::window_service::load_window_session(&path_str);
    let mut loaded_ids = loaded.project_window_ids;
    loaded_ids.sort();
    assert_eq!(loaded_ids, vec!["win-1", "win-2"]);
}

#[test]
fn load_window_session_returns_empty_when_missing() {
    let loaded = eldrun_lib::services::window_service::load_window_session("/nonexistent/project.json");
    assert!(loaded.project_window_ids.is_empty());
}

// ── project switch workflow ────────────────────────────────────────────────
//
// Tests that verify the individual steps of the switch workflow compose
// correctly.  The full `switch()` requires an `AppHandle` (a live Tauri
// context) and cannot be instantiated in unit tests.  These tests therefore
// exercise each step independently and then verify the observable file-system
// side effects match the plan spec.

#[test]
fn switch_saves_tab_layout_to_project_json() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "prev".to_string(),
        name: "Prev".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let path_str = local_file.to_string_lossy().to_string();

    let tabs = vec![TabEntry {
        key: "t1".to_string(),
        label: "T1".to_string(),
        cmd: "bash".to_string(),
        cwd: "/tmp".to_string(),
        extra: Default::default(),
    }];
    terminal_service::save_terminal_session(&path_str, &tabs, 0).unwrap();

    // project.json must have been updated.
    let saved: Project = eldrun_lib::storage::read_json(&local_file).unwrap();
    let saved_tabs = saved.tab_layout.expect("tab_layout must be saved");
    assert_eq!(saved_tabs.len(), 1);
    assert_eq!(saved_tabs[0].key, "t1");
}

#[test]
fn switch_hides_previous_project_windows_using_null_backend() {
    use eldrun_lib::platform::null::NullBackend;

    let windows: HashMap<String, TrackedWindow> = [
        tracked("a", Some("prev"), ORIGIN_RIGHT_FILE_TREE, Some(10)),
        tracked("b", Some("prev"), ORIGIN_RESTORED, Some(11)),
        tracked("c", Some("next"), ORIGIN_RIGHT_FILE_TREE, Some(20)),
        tracked("d", None, ORIGIN_GLOBAL_APP, Some(99)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let prev_ids = window_service::project_window_ids(&windows, Some("prev"));
    assert_eq!(prev_ids.len(), 2, "must collect exactly the two prev-owned windows");

    // NullBackend::hide_window must not error.
    let backend = NullBackend;
    window_service::hide_windows(&backend, &prev_ids);
    // If we get here without panic the test passes.
}

#[test]
fn switch_uses_hide_show_as_workspace_backend_boundary() {
    let windows: HashMap<String, TrackedWindow> = [
        tracked("prev-file", Some("prev"), ORIGIN_RIGHT_FILE_TREE, Some(10)),
        tracked("prev-restored", Some("prev"), ORIGIN_RESTORED, Some(11)),
        tracked("prev-global", Some("prev"), ORIGIN_GLOBAL_APP, Some(12)),
        tracked("prev-manual", Some("prev"), ORIGIN_MANUAL_LAUNCH, Some(13)),
        tracked("next-file", Some("next"), ORIGIN_MIDDLE_FILE_BROWSER, Some(20)),
        tracked("next-restored", Some("next"), ORIGIN_RESTORED, Some(21)),
        tracked("root-file", None, ORIGIN_RIGHT_FILE_TREE, Some(30)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let mut previous_ids = window_service::project_window_ids(&windows, Some("prev"));
    previous_ids.sort();
    let mut current_ids = window_service::project_window_ids(&windows, Some("next"));
    current_ids.sort();

    let backend = RecordingBackend::default();
    window_service::hide_windows(&backend, &previous_ids);
    window_service::show_windows(&backend, &current_ids);

    assert_eq!(
        backend.calls(),
        vec![
            ("hide".to_string(), 10),
            ("hide".to_string(), 11),
            ("show".to_string(), 20),
            ("show".to_string(), 21),
        ],
        "project switching must be wired through hide_window/show_window only"
    );
}

#[test]
fn default_switch_to_project_delegates_to_hide_show() {
    let backend = RecordingBackend::default();

    backend
        .switch_to_project(Some("next"), Some("prev"), &[10, 11], &[20, 21])
        .unwrap();

    assert_eq!(
        backend.calls(),
        vec![
            ("hide".to_string(), 10),
            ("hide".to_string(), 11),
            ("show".to_string(), 20),
            ("show".to_string(), 21),
        ],
        "legacy switch_to_project must remain a thin hide/show helper"
    );
}

#[test]
fn switch_ignores_global_app_and_manual_windows_when_hiding() {
    use eldrun_lib::platform::null::NullBackend;

    let windows: HashMap<String, TrackedWindow> = [
        tracked("g", Some("prev"), ORIGIN_GLOBAL_APP, Some(1)),
        tracked("m", Some("prev"), ORIGIN_MANUAL_LAUNCH, Some(2)),
        tracked("p", Some("prev"), ORIGIN_RIGHT_FILE_TREE, Some(3)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let ids = window_service::project_window_ids(&windows, Some("prev"));
    assert_eq!(ids, vec![3], "only the project-owned window must be selected");

    let backend = NullBackend;
    window_service::hide_windows(&backend, &ids);
}

#[test]
fn switch_restored_apps_are_project_owned() {
    let windows: HashMap<String, TrackedWindow> = [
        tracked("r", Some("p1"), ORIGIN_RESTORED, Some(10)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let owned = window_service::project_tracked_ids(&windows, Some("p1"));
    assert_eq!(owned, vec!["r"], "restored apps must be treated as project-owned");
}

#[test]
fn switch_root_runtime_uses_none_project_id() {
    use eldrun_lib::platform::null::NullBackend;

    let windows: HashMap<String, TrackedWindow> = [
        tracked("root-w", None, ORIGIN_RIGHT_FILE_TREE, Some(99)),
        tracked("proj-w", Some("p1"), ORIGIN_RIGHT_FILE_TREE, Some(10)),
    ]
    .into_iter()
    .map(|w| (w.id.clone(), w))
    .collect();

    let root_ids = window_service::project_window_ids(&windows, None);
    assert_eq!(root_ids, vec![99], "root scope must use None project_id");

    let backend = NullBackend;
    window_service::hide_windows(&backend, &root_ids);
    window_service::show_windows(&backend, &root_ids);
}

#[test]
fn switch_next_project_tab_layout_loaded_after_save() {
    let tmp = TempDir::new().unwrap();
    let project = Project {
        id: "next".to_string(),
        name: "Next".to_string(),
        directory: tmp.path().to_string_lossy().to_string(),
        ..Default::default()
    };
    let local_file = write_project_json(tmp.path(), &project);
    let path_str = local_file.to_string_lossy().to_string();

    let tabs = vec![
        TabEntry {
            key: "n1".to_string(),
            label: "N1".to_string(),
            cmd: "bash".to_string(),
            cwd: "/tmp".to_string(),
            extra: Default::default(),
        },
        TabEntry {
            key: "n2".to_string(),
            label: "Claude".to_string(),
            cmd: "claude".to_string(),
            cwd: "/tmp".to_string(),
            extra: Default::default(),
        },
    ];
    terminal_service::save_terminal_session(&path_str, &tabs, 1).unwrap();

    let session = terminal_service::load_terminal_session(&path_str);
    assert_eq!(session.tab_layout.len(), 2);
    assert_eq!(session.active_tab_index, 1);
    assert_eq!(session.tab_layout[1].cmd, "claude");
}
