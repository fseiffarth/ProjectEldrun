use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use eldrun_lib::commands::projects::{
    create_project, get_projects, import_project, load_project, set_project_description,
    CreateProjectRequest, ImportProjectRequest,
};
use tempfile::{Builder, TempDir};

const SCAFFOLDS: &[(&str, &str)] = &[
    ("AGENTS.md", "# Agents\n"),
    ("CLAUDE.md", "# Claude Context\n"),
    ("GEMINI.md", "# Gemini Context\n"),
    ("TODO.md", "# TODO\n"),
    ("ROADMAP.md", "# Roadmap\n"),
    ("STATUS.md", "# Status\n"),
    ("README.md", "# Project\n"),
    (".gitignore", "__pycache__/\n*.pyc\n.venv/\nnode_modules/\ntarget/\ndist/\nbuild/\n.env\n.env.local\n.DS_Store\n*.log\n*.swp\n*.swo\n.idea/\n.eldrun/\n"),
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
