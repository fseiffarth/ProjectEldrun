//! Codex's own thread store: `~/.codex/state_<n>.sqlite`.
//!
//! Codex used to keep every conversation as a JSONL transcript under
//! `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`, and Eldrun
//! read the model tag beside an agent tab out of that file's tail. Codex
//! 0.153.4 writes its history into a SQLite database instead: the `threads` row
//! still *names* a `rollout_path`, but no such file is written any more, so the
//! tail read behind [`crate::services::agent_session::agent_session_model`]
//! finds nothing and every Codex tab lost its pill.
//!
//! The row's own `model` column is the same fact by another route — the model
//! that thread is running — so that is what this module reads, as the fallback
//! for when there is no rollout to read.
//!
//! Everything here is read-only and best-effort. The schema is Codex's, not
//! ours, and it moves: a release that renames the file, the table or the column
//! yields `None` and a tab with no tag, never an error and never a guess.

use std::path::{Path, PathBuf};

use crate::paths;
use crate::services::agent_session::clean_model_name;

/// The store Codex is writing now, or `None` when there is none to read.
///
/// Codex bumps the file's suffix when it breaks the schema (`state_5.sqlite`
/// today), leaving the older ones in place, so the highest number is the live
/// one. A plain `state.sqlite` counts as zero, below every numbered store.
pub fn state_db() -> Option<PathBuf> {
    state_db_in(&paths::home_dir().join(".codex"))
}

/// Testable core of [`state_db`] against an explicit `~/.codex`.
pub(crate) fn state_db_in(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(u32, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix("state").and_then(|r| r.strip_suffix(".sqlite")) else {
            continue;
        };
        // "state.sqlite" → 0; "state_5.sqlite" → 5; anything else is not a store.
        let version = match rest.strip_prefix('_') {
            Some(digits) => match digits.parse::<u32>() {
                Ok(n) => n,
                Err(_) => continue,
            },
            None if rest.is_empty() => 0,
            None => continue,
        };
        if best.as_ref().is_none_or(|(seen, _)| version > *seen) {
            best = Some((version, path));
        }
    }
    best.map(|(_, path)| path)
}

/// Whether the store at `db` still holds the thread `thread_id`.
///
/// This is the successor to walking `~/.codex/sessions` for a
/// `rollout-*-<uuid>.jsonl`: since 0.153.4 Codex records the thread here and
/// writes no rollout file, so the walk finds nothing and every Codex tab fell
/// back to a fresh session on relaunch (see
/// [`crate::services::agent_session::codex_session_exists`]).
///
/// An **archived** thread does not count. Archiving is the user saying that
/// conversation is done; resuming it would be the one case where answering
/// "yes, it exists" is worse than starting fresh.
pub fn thread_exists(db: &Path, thread_id: &str) -> bool {
    use rusqlite::{Connection, OpenFlags};

    let Ok(conn) = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    conn.query_row(
        "SELECT 1 FROM threads WHERE id = ?1 AND archived = 0",
        [thread_id],
        |_| Ok(()),
    )
    .is_ok()
}

/// The model the thread `thread_id` is running, per the store at `db`.
///
/// Opened strictly read-only: Codex is writing this database while we read it,
/// and the one thing that must never happen is Eldrun touching another
/// application's state. A locked, missing, or differently-shaped store is not
/// an error here — it is simply no tag.
pub fn thread_model(db: &Path, thread_id: &str) -> Option<String> {
    use rusqlite::{Connection, OpenFlags};

    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let model: Option<String> = conn
        .query_row("SELECT model FROM threads WHERE id = ?1", [thread_id], |row| {
            row.get(0)
        })
        .ok()?;
    clean_model_name(&model?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp(prefix: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()));
        // Pids are reused: a store left by an earlier run must not survive into
        // this one, or the `CREATE TABLE`s below fail on the second run.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Write a store shaped like Codex's, holding `rows` of (id, model).
    fn store_with(path: &Path, rows: &[(&str, Option<&str>)]) {
        let live: Vec<(&str, Option<&str>, bool)> =
            rows.iter().map(|(id, model)| (*id, *model, false)).collect();
        store_with_archived(path, &live);
    }

    /// As [`store_with`], with each row's `archived` flag spelled out.
    fn store_with_archived(path: &Path, rows: &[(&str, Option<&str>, bool)]) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT, archived INTEGER NOT NULL DEFAULT 0)",
            [],
        )
        .unwrap();
        for (id, model, archived) in rows {
            conn.execute(
                "INSERT INTO threads (id, model, archived) VALUES (?1, ?2, ?3)",
                (id, model, i64::from(*archived)),
            )
            .unwrap();
        }
    }

    #[test]
    fn picks_the_highest_numbered_store() {
        let dir = unique_tmp("eldrun-codex-store");
        for name in ["state.sqlite", "state_2.sqlite", "state_10.sqlite", "logs_9.sqlite"] {
            std::fs::write(dir.join(name), b"").unwrap();
        }
        // 10 > 2 numerically; sorted as text "state_10" would lose to "state_2".
        assert_eq!(state_db_in(&dir), Some(dir.join("state_10.sqlite")));
    }

    #[test]
    fn unnumbered_store_is_the_oldest_not_the_newest() {
        let dir = unique_tmp("eldrun-codex-store");
        std::fs::write(dir.join("state.sqlite"), b"").unwrap();
        assert_eq!(state_db_in(&dir), Some(dir.join("state.sqlite")));
        std::fs::write(dir.join("state_1.sqlite"), b"").unwrap();
        assert_eq!(state_db_in(&dir), Some(dir.join("state_1.sqlite")));
    }

    #[test]
    fn no_codex_dir_is_no_store() {
        let dir = unique_tmp("eldrun-codex-store");
        assert_eq!(state_db_in(&dir.join("nope")), None);
    }

    #[test]
    fn reads_a_threads_model() {
        let dir = unique_tmp("eldrun-codex-store");
        let db = dir.join("state_5.sqlite");
        store_with(
            &db,
            &[
                ("01a07c18-3a25-7fa1-9ac4-74fa84d4e12a", Some("gpt-5-codex")),
                ("01a07b6f-8952-7280-8848-c2c7501b3329", None),
                ("01a07b65-415e-7423-a42f-5e229ed5ffac", Some("  not a model  ")),
            ],
        );
        assert_eq!(
            thread_model(&db, "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a").as_deref(),
            Some("gpt-5-codex")
        );
        // A thread with no model yet, a name that is not one, and a thread the
        // store has never heard of: no tag, three times over.
        assert_eq!(thread_model(&db, "01a07b6f-8952-7280-8848-c2c7501b3329"), None);
        assert_eq!(thread_model(&db, "01a07b65-415e-7423-a42f-5e229ed5ffac"), None);
        assert_eq!(thread_model(&db, "no-such-thread"), None);
    }

    #[test]
    fn a_live_thread_exists_an_archived_or_unknown_one_does_not() {
        let dir = unique_tmp("eldrun-codex-store");
        let db = dir.join("state_5.sqlite");
        store_with_archived(
            &db,
            &[
                ("01a07c18-3a25-7fa1-9ac4-74fa84d4e12a", Some("gpt-5-codex"), false),
                // No model recorded yet still counts: the tab has a thread to resume.
                ("01a07b6f-8952-7280-8848-c2c7501b3329", None, false),
                ("01a07b65-415e-7423-a42f-5e229ed5ffac", Some("gpt-5-codex"), true),
            ],
        );
        assert!(thread_exists(&db, "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a"));
        assert!(thread_exists(&db, "01a07b6f-8952-7280-8848-c2c7501b3329"));
        assert!(!thread_exists(&db, "01a07b65-415e-7423-a42f-5e229ed5ffac"));
        assert!(!thread_exists(&db, "no-such-thread"));
    }

    #[test]
    fn a_store_we_cannot_read_holds_no_thread() {
        let dir = unique_tmp("eldrun-codex-store");
        let junk = dir.join("state_6.sqlite");
        std::fs::write(&junk, b"not a database").unwrap();
        assert!(!thread_exists(&junk, "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a"));
        assert!(!thread_exists(&dir.join("nope.sqlite"), "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a"));
        // A store whose schema moved out from under us: no thread, no panic.
        let other = dir.join("state_7.sqlite");
        rusqlite::Connection::open(&other)
            .unwrap()
            .execute("CREATE TABLE logs (id TEXT)", [])
            .unwrap();
        assert!(!thread_exists(&other, "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a"));
    }

    #[test]
    fn a_store_without_the_schema_we_know_is_no_tag() {
        let dir = unique_tmp("eldrun-codex-store");
        let db = dir.join("state_5.sqlite");
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute("CREATE TABLE logs (id TEXT)", [])
            .unwrap();
        assert_eq!(thread_model(&db, "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a"), None);
        // Not a database at all.
        let junk = dir.join("state_6.sqlite");
        std::fs::write(&junk, b"not a database").unwrap();
        assert_eq!(thread_model(&junk, "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a"), None);
    }
}
