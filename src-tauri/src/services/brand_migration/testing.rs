//! Test fixtures for the migrator: an invented brand, a machine made of temp
//! dirs, a world that records instead of acting, and an install seeded the
//! way an older build left one.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::{Env, World};
use crate::brand::{Forms, Name, Pair, LEGACY};

/// An invented current brand over the real old one: the pair a build runs
/// with once the name has changed.
pub const RENAMED: Pair = Pair {
    cur: Forms { display: "Newname", slug: "newname", upper: "NEWNAME" },
    legacy: LEGACY,
};

/// Records what a step asked of the machine.
#[derive(Default)]
pub struct RecordingWorld {
    pub calls: RefCell<Vec<String>>,
    /// Whether an old phone host is installed.
    pub legacy_host: bool,
}

impl World for RecordingWorld {
    fn retire_legacy_mobile_host(&self, _pair: &Pair, legacy_state_dir: &Path) -> Result<bool, String> {
        self.calls
            .borrow_mut()
            .push(format!("retire-mobile-host {}", legacy_state_dir.display()));
        Ok(self.legacy_host)
    }
}

/// A machine in a temp dir: a home with the Linux layout on every OS (the
/// steps only ever see the paths they are given).
pub struct Machine {
    _tmp: tempfile::TempDir,
    pub home: PathBuf,
    pub world: RecordingWorld,
}

fn fixed_now() -> String {
    "2026-10-01T12:00:00+00:00".to_string()
}

impl Machine {
    pub fn new() -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Canonical, so a path read back through a link compares equal (the
        // temp dir is itself behind a link on macOS).
        let home = tmp.path().canonicalize().expect("canonicalize").join("home");
        fs::create_dir_all(&home).expect("home");
        Self { _tmp: tmp, home, world: RecordingWorld { legacy_host: true, ..Default::default() } }
    }

    pub fn share(&self) -> PathBuf {
        self.home.join(".local").join("share")
    }

    /// The state dir as `forms` names it.
    pub fn state_dir(&self, forms: &Forms) -> PathBuf {
        self.share().join(forms.name(Name::STATE_DIR_NAME))
    }

    /// The `~/<name>` tree as `forms` names it.
    pub fn home_tree(&self, forms: &Forms) -> PathBuf {
        self.home.join(forms.name(Name::HOME_DIR_NAME))
    }

    /// The webview's data dir as `forms` names it.
    pub fn webview_data(&self, forms: &Forms) -> PathBuf {
        self.share().join(forms.name(Name::APP_IDENTIFIER))
    }

    /// The environment a launch of a build with `pair` would see here.
    pub fn env(&self, pair: Pair) -> Env<'_> {
        let home_tree = crate::paths::app_home_in(&pair, |_| None, &self.home);
        Env {
            pair,
            state_dir: self.state_dir(&pair.cur),
            legacy_state_dir: pair.legacy(Name::STATE_DIR_NAME).map(|old| self.share().join(old)),
            share_dir: None,
            webview_data: pair
                .legacy(Name::APP_IDENTIFIER)
                .map(|old| (self.share().join(old), self.webview_data(&pair.cur))),
            home_trees: vec![home_tree],
            machine_wide: true,
            world: &self.world,
            now: fixed_now,
            crash_at: None,
        }
    }

    /// Seed the home the way a build named `forms` left it after real use.
    /// Returns the project folder.
    pub fn seed_install(&self, forms: &Forms) -> PathBuf {
        let state = self.state_dir(forms);
        let tree = self.home_tree(forms);
        let project = tree.join("projects").join("alpha");
        write(&project.join("README.md"), "alpha\n");

        let mirror = state.join("remote-projects").join("beta").join("mirror");
        write(&mirror.join("notes.txt"), "remote notes\n");
        write_json(
            &state.join("projects.json"),
            &serde_json::json!([
                { "id": "alpha", "name": "Alpha", "directory": project },
                { "id": "beta", "name": "Beta", "directory": mirror, "remote": { "host": "example.org" } }
            ]),
        );
        write_json(&state.join("settings.json"), &serde_json::json!({ "theme": "dark" }));
        write_json(
            &state.join("sessions").join("beta").join("tabs.json"),
            &serde_json::json!({ "tabs": [{ "id": "t1", "cmd": "bash", "cwd": mirror }] }),
        );
        write_json(
            &state.join("remote-projects").join("beta").join("sync.json"),
            &serde_json::json!({ "files": {}, "mirror": mirror }),
        );
        write_json(
            &tree.join("archive").join("gamma").join("entry.json"),
            &serde_json::json!({ "id": "gamma", "state": state.join("remote-projects").join("gamma") }),
        );
        write(
            &state.join("mobile-control").join("bin").join("1.0.0").join(forms.name(Name::MOBILE_HOST_BIN)),
            "#!host\n",
        );

        let webview = self.webview_data(forms);
        write(&webview.join("localstorage").join("app.localstorage"), "theme=dark");
        write(&webview.join("databases").join("indexeddb").join("db.sqlite"), "idb");
        project
    }
}

pub fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    fs::write(path, content).expect("write");
}

pub fn write_json(path: &Path, value: &serde_json::Value) {
    write(path, &serde_json::to_string_pretty(value).expect("json"));
}

pub fn read_json(path: &Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display())))
        .expect("json")
}

/// Every entry under `root`, by path relative to it: a file's content, a
/// link's target, or `<dir>`. Two equal snapshots mean nothing moved and
/// nothing was written.
pub fn snapshot(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).expect("read_dir").flatten() {
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .expect("under root")
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let kind = entry.file_type().expect("file type");
            if kind.is_symlink() {
                out.insert(rel, format!("<link {}>", fs::read_link(&path).expect("read_link").display()));
            } else if kind.is_dir() {
                out.insert(rel, "<dir>".to_string());
                stack.push(path);
            } else {
                out.insert(rel, String::from_utf8_lossy(&fs::read(&path).expect("read")).into_owned());
            }
        }
    }
    out
}

/// The entries of a snapshot (paths and contents) that spell `word`,
/// ignoring case.
pub fn spellings(snapshot: &BTreeMap<String, String>, word: &str) -> Vec<String> {
    let word = word.to_lowercase();
    snapshot
        .iter()
        .filter(|(path, content)| path.to_lowercase().contains(&word) || content.to_lowercase().contains(&word))
        .map(|(path, _)| path.clone())
        .collect()
}
