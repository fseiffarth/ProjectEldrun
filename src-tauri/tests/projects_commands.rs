use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use eldrun_lib::commands::projects::{
    archive_project, create_project, delete_archived_project, get_projects, import_project,
    list_archived_projects, load_project, restore_archived_project, set_project_auto_connect,
    set_project_description, CreateProjectRequest, ImportProjectRequest,
};
use eldrun_lib::schema::project::RemoteSpec;
use tempfile::{Builder, TempDir};

const SCAFFOLDS: &[(&str, &str)] = &[
    ("AGENTS.md", "# Agents\n"),
    ("CLAUDE.md", "# Claude Context\n"),
    ("GEMINI.md", "# Gemini Context\n"),
    ("TODO.md", "# TODO\n"),
    ("ROADMAP.md", "# Roadmap\n"),
    ("STATUS.md", "# Status\n"),
    ("README.md", "# Project\n"),
    (".gitignore", "__pycache__/\n*.pyc\n.venv/\nnode_modules/\ntarget/\ndist/\nbuild/\n.env\n.env.local\n.DS_Store\n*.log\n*.swp\n*.swo\n.idea/\n.eldrun/\nproject.json\n"),
    (".claude/settings.json", r#"{"permissions":{"allow":[],"deny":[]}}"#),
];

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has parent")
        .to_path_buf()
}

fn test_projects_root() -> PathBuf {
    repo_root().join("test_projects")
}

fn test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

struct HomeGuard {
    old_home: Option<std::ffi::OsString>,
}

impl HomeGuard {
    fn set(home: &Path) -> Self {
        let old_home = env::var_os("HOME");
        // HOME is mutated only while holding the test lock.
        unsafe {
            env::set_var("HOME", home);
        }
        Self { old_home }
    }
}

impl Drop for HomeGuard {
    fn drop(&mut self) {
        // Restore the caller's HOME as soon as the scoped test ends.
        unsafe {
            match &self.old_home {
                Some(home) => env::set_var("HOME", home),
                None => env::remove_var("HOME"),
            }
        }
    }
}

fn with_isolated_home<T>(prefix: &str, f: impl FnOnce(&Path) -> T) -> T {
    let _guard = test_lock().lock().expect("test lock");
    let base = test_projects_root();
    fs::create_dir_all(&base).expect("create test_projects root");

    let home = Builder::new()
        .prefix(prefix)
        .tempdir_in(&base)
        .expect("tempdir in test_projects");
    let _home_guard = HomeGuard::set(home.path());

    f(home.path())
}

fn tempdir_in_test_projects(prefix: &str) -> TempDir {
    let base = test_projects_root();
    fs::create_dir_all(&base).expect("create test_projects root");
    Builder::new()
        .prefix(prefix)
        .tempdir_in(&base)
        .expect("tempdir in test_projects")
}

fn write_scaffold(dir: &Path, name: &str, content: &str) {
    let path = dir.join(name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create scaffold parent");
    }
    fs::write(path, content).expect("write scaffold");
}

fn seed_project(dir: &Path, tag: &str) {
    fs::create_dir_all(dir).expect("create project dir");
    write_scaffold(dir, "AGENTS.md", &format!("{tag}:agents\n"));
    write_scaffold(dir, "TODO.md", &format!("{tag}:todo\n"));
    write_scaffold(dir, ".gitignore", &format!("{tag}:gitignore\n"));
    write_scaffold(
        dir,
        ".claude/settings.json",
        &format!(r#"{{"marker":"{tag}"}}"#),
    );
    fs::write(dir.join("notes.txt"), format!("{tag}:notes\n")).expect("write notes");
    fs::create_dir_all(dir.join("nested")).expect("create nested dir");
    fs::write(dir.join("nested/info.txt"), format!("{tag}:nested\n")).expect("write nested file");
}

fn assert_scaffold_state(dir: &Path, tag: &str) {
    for (name, default_content) in SCAFFOLDS {
        let path = dir.join(name);
        assert!(path.exists(), "missing scaffold: {name}");
        let actual = fs::read_to_string(&path).expect("read scaffold");
        let expected = match *name {
            "AGENTS.md" => format!("{tag}:agents\n"),
            "TODO.md" => format!("{tag}:todo\n"),
            ".gitignore" => format!("{tag}:gitignore\n"),
            ".claude/settings.json" => format!(r#"{{"marker":"{tag}"}}"#),
            _ => (*default_content).to_string(),
        };
        assert_eq!(actual, expected, "unexpected contents for {name}");
    }
}

fn assert_project_registered(expected_local_file: &Path, expected_name: &str) {
    let projects = get_projects().expect("get projects");
    let entry = projects
        .iter()
        .find(|p| Path::new(&p.local_file) == expected_local_file)
        .unwrap_or_else(|| panic!("project not registered: {}", expected_local_file.display()));
    assert_eq!(entry.name, expected_name);
    assert_eq!(entry.status, "inactive");
}

#[test]
fn create_project_preserves_existing_scaffolds() {
    with_isolated_home("create-home", |_| {
        let target = tempdir_in_test_projects("create-target");
        seed_project(target.path(), "create");

        let req = CreateProjectRequest {
            name: "create-project".to_string(),
            directory: target.path().to_string_lossy().to_string(),
            description: Some("Create description".to_string()),
            git_type: None,
            skip_scaffold: false,
            remote: None,
            mirror_parent: None,
        };

        let entry = create_project(req).expect("create project");
        assert_eq!(entry.name, "create-project");
        assert_eq!(entry.status, "inactive");
        assert_eq!(
            entry.extra.get("description").and_then(|v| v.as_str()),
            Some("Create description")
        );
        assert_eq!(
            entry.local_file,
            target.path().join("project.json").to_string_lossy()
        );

        assert_scaffold_state(target.path(), "create");
        assert!(target.path().join("notes.txt").exists());
        assert!(target.path().join("nested/info.txt").exists());
        assert!(target.path().join("project.json").exists());
        assert_project_registered(&target.path().join("project.json"), "create-project");
    });
}

#[test]
fn create_remote_project_scaffolds_the_local_mirror() {
    with_isolated_home("remote-home", |_| {
        // Where the local mirror twin (working copy) should land. The host is a
        // reserved `.invalid` name so the best-effort remote `mkdir -p` fails fast
        // (NXDOMAIN) without touching the network — scaffolding the mirror must
        // happen regardless, since bytes only reach the host on a manual push.
        let mirror_parent = tempdir_in_test_projects("remote-mirror");

        let req = CreateProjectRequest {
            name: "remote-project".to_string(),
            directory: String::new(),
            description: Some("Remote description".to_string()),
            git_type: Some("none".to_string()),
            skip_scaffold: false,
            remote: Some(RemoteSpec {
                user: Some("alice".to_string()),
                host: "nonexistent.invalid".to_string(),
                port: None,
                remote_path: "/home/alice/work".to_string(),
                openvpn: None,
                auto_connect: None,
                key_auth: None,
                extra: Default::default(),
            }),
            mirror_parent: Some(mirror_parent.path().to_string_lossy().to_string()),
        };

        let entry = create_project(req).expect("create remote project");
        assert!(
            entry.extra.contains_key("remote"),
            "entry should carry a remote spec"
        );

        // The scaffold lives in the local mirror, not the (project.json-only)
        // state directory the entry's local_file points at.
        let mirror = entry
            .extra
            .get("mirror")
            .and_then(|v| v.as_str())
            .expect("remote entry carries a mirror path");
        let mirror_dir = Path::new(mirror);
        for (name, default_content) in SCAFFOLDS {
            // `.gitignore` is a git-axis artifact: a `git_type: "none"` project
            // never gets one written, so it must be absent from the mirror.
            if *name == ".gitignore" {
                assert!(
                    !mirror_dir.join(name).exists(),
                    "git_type none must not scaffold a .gitignore"
                );
                continue;
            }
            let path = mirror_dir.join(name);
            assert!(path.exists(), "missing mirror scaffold: {name}");
            let actual = fs::read_to_string(&path).expect("read mirror scaffold");
            assert_eq!(&actual, default_content, "unexpected contents for {name}");
        }

        // git_type "none" means no repo was initialized in the mirror.
        assert!(
            !mirror_dir.join(".git").exists(),
            "git_type none must not init a mirror repo"
        );

        assert_project_registered(&PathBuf::from(&entry.local_file), "remote-project");
    });
}

#[test]
fn import_project_copy_creates_missing_scaffolds_without_overwriting_existing_ones() {
    with_isolated_home("copy-home", |_| {
        let source = tempdir_in_test_projects("copy-source");
        seed_project(source.path(), "copy");

        let req = ImportProjectRequest {
            source_dir: source.path().to_string_lossy().to_string(),
            name: "copy-project".to_string(),
            description: Some("Copy description".to_string()),
            git_type: None,
            mode: "copy".to_string(),
            scaffold_fill_modes: None,
            manual_validation_confirmed: Some(true),
            skip_scaffold: false,
            remote: None,
            mirror_parent: None,
        };

        let entry = import_project(req).expect("import copy");
        let target = PathBuf::from(&entry.local_file)
            .parent()
            .expect("project file parent")
            .to_path_buf();

        assert_eq!(entry.name, "copy-project");
        assert_eq!(entry.status, "inactive");
        assert_eq!(
            entry.extra.get("description").and_then(|v| v.as_str()),
            Some("Copy description")
        );
        assert_eq!(entry.local_file, target.join("project.json").to_string_lossy());
        assert!(source.path().exists(), "copy must keep the original source");
        assert!(source.path().join("notes.txt").exists(), "copy must keep source files");

        assert_scaffold_state(&target, "copy");
        assert!(target.join("notes.txt").exists());
        assert!(target.join("nested/info.txt").exists());
        assert_project_registered(&target.join("project.json"), "copy-project");
    });
}

#[test]
fn import_project_move_creates_missing_scaffolds_without_overwriting_existing_ones() {
    with_isolated_home("move-home", |_| {
        let source = tempdir_in_test_projects("move-source");
        seed_project(source.path(), "move");

        let req = ImportProjectRequest {
            source_dir: source.path().to_string_lossy().to_string(),
            name: "move-project".to_string(),
            description: None,
            git_type: None,
            mode: "move".to_string(),
            scaffold_fill_modes: None,
            manual_validation_confirmed: Some(true),
            skip_scaffold: false,
            remote: None,
            mirror_parent: None,
        };

        let entry = import_project(req).expect("import move");
        let target = PathBuf::from(&entry.local_file)
            .parent()
            .expect("project file parent")
            .to_path_buf();

        assert_eq!(entry.name, "move-project");
        assert_eq!(entry.status, "inactive");
        assert_eq!(entry.local_file, target.join("project.json").to_string_lossy());
        assert!(!source.path().exists(), "move must remove the original source");

        assert_scaffold_state(&target, "move");
        assert!(target.join("notes.txt").exists());
        assert!(target.join("nested/info.txt").exists());
        assert_project_registered(&target.join("project.json"), "move-project");
    });
}

#[test]
fn import_project_keep_creates_missing_scaffolds_in_place_without_overwriting_existing_ones() {
    with_isolated_home("keep-home", |_| {
        let source = tempdir_in_test_projects("keep-source");
        seed_project(source.path(), "keep");

        let req = ImportProjectRequest {
            source_dir: source.path().to_string_lossy().to_string(),
            name: "keep-project".to_string(),
            description: Some("Keep description".to_string()),
            git_type: None,
            mode: "keep".to_string(),
            scaffold_fill_modes: None,
            manual_validation_confirmed: None,
            skip_scaffold: false,
            remote: None,
            mirror_parent: None,
        };

        let entry = import_project(req).expect("import keep");

        assert_eq!(entry.name, "keep-project");
        assert_eq!(entry.status, "inactive");
        assert_eq!(
            entry.extra.get("description").and_then(|v| v.as_str()),
            Some("Keep description")
        );
        assert_eq!(entry.local_file, source.path().join("project.json").to_string_lossy());
        assert!(source.path().exists(), "keep must keep the source directory");

        assert_scaffold_state(source.path(), "keep");
        assert!(source.path().join("notes.txt").exists());
        assert!(source.path().join("nested/info.txt").exists());
        assert_project_registered(&source.path().join("project.json"), "keep-project");
    });
}

#[test]
fn import_project_skip_scaffold_does_not_add_missing_scaffold_files() {
    with_isolated_home("skip-home", |_| {
        let source = tempdir_in_test_projects("skip-source");
        // A bare project with only its own file — no scaffold, no .git.
        fs::create_dir_all(source.path()).expect("create source dir");
        fs::write(source.path().join("notes.txt"), "own:notes\n").expect("write notes");

        let req = ImportProjectRequest {
            source_dir: source.path().to_string_lossy().to_string(),
            name: "skip-project".to_string(),
            description: None,
            git_type: None,
            mode: "keep".to_string(),
            scaffold_fill_modes: None,
            manual_validation_confirmed: None,
            skip_scaffold: true,
            remote: None,
            mirror_parent: None,
        };

        let entry = import_project(req).expect("import skip-scaffold");

        // Only project.json is written; no scaffold files or git init.
        assert!(source.path().join("project.json").exists());
        assert!(source.path().join("notes.txt").exists());
        for name in &["AGENTS.md", "CLAUDE.md", "TODO.md", "README.md", ".gitignore"] {
            assert!(
                !source.path().join(name).exists(),
                "skip_scaffold must not create {name}"
            );
        }
        assert!(!source.path().join(".git").exists(), "skip_scaffold must not git init");
        assert_project_registered(&source.path().join("project.json"), "skip-project");
        // New projects default to the local push target.
        assert_eq!(
            entry.extra.get("git_type").and_then(|v| v.as_str()),
            Some("local")
        );
    });
}

#[test]
fn set_project_description_writes_both_projects_json_and_project_json() {
    with_isolated_home("desc-home", |_| {
        let target = tempdir_in_test_projects("desc-target");
        seed_project(target.path(), "desc");

        let entry = create_project(CreateProjectRequest {
            name: "desc-project".to_string(),
            directory: target.path().to_string_lossy().to_string(),
            description: Some("original".to_string()),
            git_type: None,
            skip_scaffold: false,
            remote: None,
            mirror_parent: None,
        })
        .expect("create project");

        // Update the description.
        let returned = set_project_description(entry.id.clone(), Some("updated desc".to_string()))
            .expect("set description");
        assert_eq!(returned.as_deref(), Some("updated desc"));

        // projects.json (the pill list) reflects it.
        let listed = get_projects().expect("get projects");
        let found = listed.iter().find(|p| p.id == entry.id).expect("entry present");
        assert_eq!(
            found.extra.get("description").and_then(|v| v.as_str()),
            Some("updated desc")
        );

        // project.json (the per-project file) reflects it too.
        let project = load_project(entry.local_file.clone()).expect("load project");
        assert_eq!(project.description.as_deref(), Some("updated desc"));

        // Clearing the description removes it from both stores.
        let cleared = set_project_description(entry.id.clone(), None).expect("clear description");
        assert!(cleared.is_none());
        let listed = get_projects().expect("get projects");
        let found = listed.iter().find(|p| p.id == entry.id).expect("entry present");
        assert!(found.extra.get("description").is_none());
        let project = load_project(entry.local_file.clone()).expect("load project");
        assert!(project.description.is_none());
    });
}

// ── Archive (delete → restorable) ──────────────────────────────────────────

fn new_local_project(name: &str, target: &Path) -> eldrun_lib::schema::projects::ProjectEntry {
    seed_project(target, name);
    create_project(CreateProjectRequest {
        name: name.to_string(),
        directory: target.to_string_lossy().to_string(),
        description: None,
        git_type: None,
        skip_scaffold: false,
        remote: None,
        mirror_parent: None,
    })
    .expect("create project")
}

#[test]
fn archive_and_restore_local_project_roundtrip() {
    with_isolated_home("archive-home", |_| {
        let target = tempdir_in_test_projects("archive-target");
        let entry = new_local_project("arch-project", target.path());
        let id = entry.id.clone();
        let dir = target.path().to_path_buf();
        assert!(dir.join("project.json").exists());

        // Archive: the on-disk dir moves out and the pill drops from the list.
        archive_project(id.clone(), "2026-07-01T00:00:00+00:00".to_string()).expect("archive");
        assert!(
            !dir.join("project.json").exists(),
            "original project dir should have moved into the archive"
        );
        assert!(
            get_projects().unwrap().iter().all(|p| p.id != id),
            "archived project must be gone from projects.json"
        );
        let archived = list_archived_projects().expect("list archived");
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].id, id);
        assert_eq!(archived[0].name, "arch-project");
        assert!(!archived[0].remote);

        // Restore: comes back inactive, the folder + files return, archive empties.
        let restored = restore_archived_project(id.clone()).expect("restore");
        assert_eq!(restored.status, "inactive");
        assert_eq!(restored.id, id);
        assert!(get_projects().unwrap().iter().any(|p| p.id == id));
        assert!(list_archived_projects().unwrap().is_empty());
        let restored_dir = PathBuf::from(&restored.local_file)
            .parent()
            .expect("restored project file parent")
            .to_path_buf();
        assert!(restored_dir.join("notes.txt").exists());
        assert!(restored_dir.join("nested/info.txt").exists());
    });
}

#[test]
fn permanent_delete_removes_archived_project() {
    with_isolated_home("archive-del-home", |_| {
        let target = tempdir_in_test_projects("archive-del-target");
        let entry = new_local_project("del-project", target.path());
        let id = entry.id.clone();

        archive_project(id.clone(), "2026-07-01T00:00:00+00:00".to_string()).expect("archive");
        assert_eq!(list_archived_projects().unwrap().len(), 1);

        delete_archived_project(id.clone()).expect("delete forever");
        assert!(
            list_archived_projects().unwrap().is_empty(),
            "archive must be empty after permanent delete"
        );
        // Restoring a permanently-deleted project is an error (nothing to read).
        assert!(restore_archived_project(id).is_err());
    });
}

#[test]
fn archive_rejects_traversal_ids_and_missing_projects() {
    with_isolated_home("archive-guard-home", |_| {
        assert!(archive_project("../evil".to_string(), "x".to_string()).is_err());
        assert!(archive_project("no-such-id".to_string(), "x".to_string()).is_err());
    });
}

/// The auto-connect opt-in has to survive a restart, and it is read from
/// `projects.json` (the always-local source of truth for a remote project, whose
/// own `project.json` may live behind the host) — so both copies must carry it, and
/// clearing it must *remove* the field rather than store `false`, so an opted-out
/// project is byte-identical to one that never opted in.
#[test]
fn set_project_auto_connect_writes_both_copies_and_clears() {
    with_isolated_home("auto-connect-home", |_| {
        let mirror_parent = tempdir_in_test_projects("auto-connect-mirror");
        let entry = create_project(CreateProjectRequest {
            name: "auto-connect".to_string(),
            directory: String::new(),
            description: None,
            git_type: Some("none".to_string()),
            skip_scaffold: true,
            remote: Some(RemoteSpec {
                user: Some("alice".to_string()),
                host: "nonexistent.invalid".to_string(),
                port: None,
                remote_path: "/home/alice/work".to_string(),
                openvpn: None,
                auto_connect: None,
                key_auth: None,
                extra: Default::default(),
            }),
            mirror_parent: Some(mirror_parent.path().to_string_lossy().to_string()),
        })
        .expect("create remote project");

        // Reads `auto_connect` off the entry's flattened `remote` in projects.json.
        let registered = |id: &str| -> Option<bool> {
            get_projects()
                .expect("get projects")
                .into_iter()
                .find(|p| p.id == id)?
                .extra
                .get("remote")?
                .get("auto_connect")?
                .as_bool()
        };
        let on_disk = |local_file: &str| -> Option<bool> {
            load_project(local_file.to_string())
                .expect("load project.json")
                .remote?
                .auto_connect
        };

        assert_eq!(registered(&entry.id), None, "starts opted out");

        assert!(set_project_auto_connect(entry.id.clone(), true).expect("opt in"));
        assert_eq!(registered(&entry.id), Some(true));
        assert_eq!(on_disk(&entry.local_file), Some(true));

        assert!(!set_project_auto_connect(entry.id.clone(), false).expect("opt out"));
        assert_eq!(registered(&entry.id), None, "cleared, not stored as false");
        assert_eq!(on_disk(&entry.local_file), None);
    });
}

/// A local project has no SSH connection to automate, so the opt-in must be
/// refused rather than silently written into a spec that doesn't exist.
#[test]
fn set_project_auto_connect_rejects_local_and_unknown_projects() {
    with_isolated_home("auto-connect-local-home", |_| {
        let target = tempdir_in_test_projects("auto-connect-local");
        let entry = create_project(CreateProjectRequest {
            name: "local-project".to_string(),
            directory: target.path().to_string_lossy().to_string(),
            description: None,
            git_type: Some("none".to_string()),
            skip_scaffold: true,
            remote: None,
            mirror_parent: None,
        })
        .expect("create local project");

        assert!(set_project_auto_connect(entry.id, true).is_err());
        assert!(set_project_auto_connect("no-such-id".to_string(), true).is_err());
    });
}
