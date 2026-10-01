//! Moves what an older build wrote under the app's old name to the current
//! name. Design and the row-by-row status: `docs/context/brand_migration.md`.
//!
//! **While the name is unchanged ([`Pair::renamed`] is false) nothing here
//! does anything**: [`run_startup`] and every lazy entry point return before
//! they look at the disk, and no record is written. Not even an "all done"
//! record — a step marked done before there was anything to move would be
//! skipped on the launch that follows the rename.
//!
//! The model:
//! - One **step** per kind of thing (the state dir, the agent homes, …), each
//!   idempotent, each recorded in `<state>/migrations.json`.
//! - A step copies or renames, verifies, switches, and only then removes the
//!   old copy. A crash mid-step leaves the record at `started` and the next
//!   launch runs the step again.
//! - A step that needs something a launch does not have (an unlocked mail
//!   store, root, a live SSH session, an unlocked keyring, an open project)
//!   stays `pending`/`lazy` and runs at the first moment that thing is
//!   present, from the module that owns it.
//! - Steps take their names from a [`Pair`], never from the constants, so the
//!   tests run them under an invented brand.
//!
//! `AppHandle`-free. Everything outside the file system that a step touches
//! (the service manager, the phone host) goes through [`World`].

pub mod agent_homes;
pub mod compat;
pub mod hits;
pub mod host;
pub mod keyring;
pub mod project;
pub mod state_dir;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::brand::{Name, Pair};

/// File name of the record under the state dir.
pub const RECORD_FILE: &str = "migrations.json";

/// Where a step stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepState {
    /// Begun and not finished: the app stopped mid-step. Runs again.
    Started,
    /// Finished; never runs again.
    Done,
    /// Could not run yet (the reason is in `note`). Tried again at the next
    /// launch, or when what it waits for appears.
    Pending,
    /// Runs per item whenever one is met (a project being opened, a keyring
    /// entry being read); has no end of its own.
    Lazy,
}

/// One step's entry in the record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepRecord {
    pub state: StepState,
    /// When the state was last written (ISO-8601 UTC).
    pub at: String,
    /// Why it is pending, or what it did.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

/// `<state>/migrations.json`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Record {
    #[serde(default)]
    pub steps: BTreeMap<String, StepRecord>,
    /// Whatever a later build added; written back untouched.
    #[serde(flatten)]
    pub other: BTreeMap<String, serde_json::Value>,
}

impl Record {
    pub fn state_of(&self, id: &str) -> Option<StepState> {
        self.steps.get(id).map(|step| step.state)
    }
}

/// What a step reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// It moved something, or found everything already moved.
    Done(String),
    /// There was nothing under the old name.
    NothingToDo,
    /// It cannot run now; the reason.
    Pending(String),
}

/// Why a step stopped early.
#[derive(Debug, PartialEq, Eq)]
pub enum Halt {
    /// Something failed; the step stays pending with this as its note.
    Failed(String),
    /// A test pulled the plug at a named checkpoint: the run ends as a crash
    /// would, with nothing more written.
    Crashed,
}

impl From<String> for Halt {
    fn from(message: String) -> Self {
        Halt::Failed(message)
    }
}

pub type StepResult = Result<Outcome, Halt>;

/// The parts of the machine outside the file system that a step reaches.
/// Production is [`Host`]; the tests record the calls instead.
pub trait World {
    /// Stop the phone host an older build installed and remove its login
    /// start (unit file, launch agent, `Run` value). It runs from inside the
    /// state dir — on Windows its executable locks the folder — so it has to
    /// be gone before the folder moves. `legacy_state_dir` is where it runs
    /// from. `Ok(true)` when there was one.
    fn retire_legacy_mobile_host(&self, pair: &Pair, legacy_state_dir: &Path) -> Result<bool, String>;
}

/// Everything a run needs to know about the machine. Production builds it
/// with [`Env::for_this_machine`]; a test points every path into a temp dir.
pub struct Env<'a> {
    pub pair: Pair,
    /// Where the state dir belongs under the current name.
    pub state_dir: PathBuf,
    /// Where an older build kept it. `None` when it is the same place: the
    /// name did not change, or an environment override names the folder.
    pub legacy_state_dir: Option<PathBuf>,
    /// `~/.local/share/<name>` under the current name and where an older
    /// build kept it, when that is not the state dir (Windows, macOS, or an
    /// overridden state dir): the dev build's and the local-model CLIs' files.
    pub share_dir: Option<(PathBuf, PathBuf)>,
    /// The webview's data dir under the old identifier and under the current
    /// one, where this OS's layout is known.
    pub webview_data: Option<(PathBuf, PathBuf)>,
    /// The `~/<name>` tree(s) that hold projects, boxes and the archive.
    pub home_trees: Vec<PathBuf>,
    /// False for a sandboxed instance (its state dir is named by the
    /// environment): the steps that reach outside the state dir are skipped.
    pub machine_wide: bool,
    pub world: &'a dyn World,
    /// Timestamps for the record.
    pub now: fn() -> String,
    /// Test only: the checkpoint at which the run "crashes".
    pub crash_at: Option<&'static str>,
}

impl Env<'_> {
    /// The state dir as it is on disk right now: the old one while it has
    /// not moved (an empty folder under the current name does not count —
    /// the move clears it away), else the current one.
    pub fn live_state_dir(&self) -> PathBuf {
        let current_in_use = std::fs::read_dir(&self.state_dir).is_ok_and(|mut entries| entries.next().is_some());
        match &self.legacy_state_dir {
            Some(old) if !current_in_use && old.exists() => old.clone(),
            _ => self.state_dir.clone(),
        }
    }

    fn record_path(&self) -> PathBuf {
        self.live_state_dir().join(RECORD_FILE)
    }

    /// The record as written. A missing or unreadable one is empty: every
    /// step is idempotent, so running them again is safe.
    pub fn record(&self) -> Record {
        crate::storage::read_json(&self.record_path()).unwrap_or_default()
    }

    fn set(&self, id: &str, state: StepState, note: &str) {
        let mut record = self.record();
        record.steps.insert(
            id.to_string(),
            StepRecord { state, at: (self.now)(), note: note.to_string() },
        );
        if let Err(error) = crate::storage::write_json_atomic(&self.record_path(), &record) {
            eprintln!("brand migration: could not write the record: {error}");
        }
    }

    /// A named point inside a step. A test stops the run here to stand in
    /// for a crash; production never does.
    pub fn checkpoint(&self, name: &'static str) -> Result<(), Halt> {
        if self.crash_at == Some(name) {
            return Err(Halt::Crashed);
        }
        Ok(())
    }

    /// `name` under the current brand.
    pub fn cur(&self, name: Name) -> String {
        self.pair.cur(name)
    }
}

/// A step that runs at launch.
struct Step {
    id: &'static str,
    run: fn(&Env) -> StepResult,
}

/// The launch steps, in order. The phone host goes first: it has to be
/// stopped before the folder it runs from moves.
const STARTUP_STEPS: &[Step] = &[
    Step { id: "mobile-host", run: state_dir::retire_mobile_host },
    Step { id: "state-dir", run: state_dir::move_state_dir },
    Step { id: "share-dir", run: state_dir::move_share_dir },
    Step { id: "state-paths", run: state_dir::rewrite_state_paths },
    Step { id: "webview-data", run: state_dir::copy_webview_data },
    Step { id: "agent-homes", run: agent_homes::migrate_agent_homes },
];

/// Steps that cannot run at launch, with what each waits for. A launch only
/// lists them in the record; the module that owns the thing runs them (see
/// [`lazy_done`] and [`lazy_ran`]).
pub const LAZY_STEPS: &[(&str, StepState, &str)] = &[
    ("keyring", StepState::Lazy, "each saved secret, when it is next read"),
    ("project-folders", StepState::Lazy, "each project, when it is opened"),
    ("remote-projects", StepState::Lazy, "each remote project, when it connects"),
];

/// What a launch did, for the log line and the tests.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// False while the name is unchanged: nothing was looked at.
    pub ran: bool,
    pub done: Vec<&'static str>,
    pub pending: Vec<(&'static str, String)>,
    /// A test stopped the run at a checkpoint.
    pub crashed: bool,
}

/// Run the launch steps. Call before anything opens the state dir.
pub fn run_startup(env: &Env) -> Report {
    let mut report = Report::default();
    if !env.pair.renamed() {
        return report;
    }
    report.ran = true;
    for step in STARTUP_STEPS {
        if env.record().state_of(step.id) == Some(StepState::Done) {
            continue;
        }
        match (step.run)(env) {
            Ok(Outcome::Done(note)) => {
                env.set(step.id, StepState::Done, &note);
                report.done.push(step.id);
            }
            Ok(Outcome::NothingToDo) => {
                env.set(step.id, StepState::Done, "");
                report.done.push(step.id);
            }
            Ok(Outcome::Pending(reason)) | Err(Halt::Failed(reason)) => {
                env.set(step.id, StepState::Pending, &reason);
                report.pending.push((step.id, reason));
            }
            Err(Halt::Crashed) => {
                report.crashed = true;
                return report;
            }
        }
    }
    let record = env.record();
    for (id, state, waits_for) in LAZY_STEPS {
        if record.state_of(id).is_none() {
            env.set(id, *state, waits_for);
        }
    }
    report
}

/// Mark a step that is about to change something, so a crash before it
/// finishes is visible as `started` and the step runs again.
pub fn mark_started(env: &Env, id: &str, note: &str) {
    env.set(id, StepState::Started, note);
}

pub use host::{run_at_launch, Host};

/// The folder `<base>/<name>` under the current brand, or under the old one
/// while only that exists: the current name if it is there, else the old name
/// if that is there (counted as a legacy hit under `hit_id`), else the
/// current name. While the name is unchanged this never looks at the disk.
pub fn resolve_named_dir(pair: &Pair, name: Name, base: &Path, hit_id: &str) -> PathBuf {
    let current = base.join(pair.cur(name));
    let Some(old) = pair.legacy(name) else {
        return current;
    };
    if current.exists() {
        return current;
    }
    let old = base.join(old);
    if old.exists() {
        crate::brand::legacy_hit(hit_id);
        old
    } else {
        current
    }
}

/// The record of the running app, for Settings → About and the lazy steps.
pub fn record_in(state_dir: &Path) -> Record {
    crate::storage::read_json(&state_dir.join(RECORD_FILE)).unwrap_or_default()
}

/// Write one lazy step's state into the running app's record. Does nothing
/// while the name is unchanged.
fn set_lazy(pair: &Pair, state_dir: &Path, id: &str, state: StepState, note: &str) {
    if !pair.renamed() {
        return;
    }
    let path = state_dir.join(RECORD_FILE);
    let entry = StepRecord { state, at: crate::storage::iso_now(), note: note.to_string() };
    let _ = crate::storage::patch_json(&path, Record::default(), |record: &mut Record| {
        if record.state_of(id) != Some(StepState::Done) || state == StepState::Done {
            record.steps.insert(id.to_string(), entry);
        }
        Ok(())
    });
}

/// A lazy step finished for good (the mail store is re-encrypted, the
/// drop-ins are rewritten).
pub fn lazy_done(pair: &Pair, state_dir: &Path, id: &str, note: &str) {
    set_lazy(pair, state_dir, id, StepState::Done, note);
}

/// A per-item lazy step handled one more item (a project folder, a keyring
/// entry): note it, the step stays lazy.
pub fn lazy_ran(pair: &Pair, state_dir: &Path, id: &str, note: &str) {
    set_lazy(pair, state_dir, id, StepState::Lazy, note);
}

/// A lazy step tried and has to wait (the reason).
pub fn lazy_pending(pair: &Pair, state_dir: &Path, id: &str, reason: &str) {
    set_lazy(pair, state_dir, id, StepState::Pending, reason);
}

#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;
