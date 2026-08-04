//! The local mail index: SQLite for folders/headers/flags/attachment metadata
//! and drafts, plus a content-addressed blob directory for payloads.
//!
//! `AppHandle`-free and factored on a `&Path`, exactly like
//! `commands::calendar`'s store — which is why the tests below can drive a
//! tempdir and why the whole thing is unit-testable without a mail server.
//!
//! Two decisions worth stating, because they are what the file boundary rests
//! on:
//!
//! - **Blob names are content-addressed and opaque** (`blobs/<sha256-hex>`, no
//!   extension). The sender-supplied filename lives only as a column here and
//!   as a label in the UI, so a filename attack has no filesystem to attack —
//!   the name never reaches a syscall.
//! - **The store never takes a path from the frontend.** Everything resolves
//!   under the directory the caller opened it on, which `commands::mail`
//!   resolves as `storage::state_dir().join("mail")` and nowhere else.
//!
//! # Encryption at rest (`docs/mail_encryption_plan.md` Phase 2)
//!
//! Optional, and opened through [`MailStore::open_with_keys`]. When keys are
//! present every *sensitive value* is a [`mail_crypt`] envelope; when they are
//! absent this file behaves exactly as it did before, which is what keeps the
//! unencrypted path (and every test below) honest rather than a second
//! implementation.
//!
//! The earlier version of this comment argued encryption was not worth it,
//! because FileVault/BitLocker/LUKS answers the stolen-laptop case and a locked
//! keychain would make the mailbox unreadable. The first half is still true and
//! is stated plainly in the UI — the marginal value here is **backups, copies,
//! sync services and multi-user machines**, where FDE is not in play. The second
//! half was the real objection and it is answered structurally: an unreachable
//! key is a *degrade*, not a refusal. `commands::mail` opens an ephemeral store
//! ([`MailStore::open_ephemeral`]) whose key dies with the process — sync works,
//! the mailbox reads, nothing persists — instead of showing an empty window.
//!
//! Three properties are worth knowing before changing anything here:
//!
//! - **Values are sealed, not the file.** So the WAL and the freelist can only
//!   ever hold ciphertext; there is no window where SQLite writes plaintext. The
//!   one exception is a store that already existed in cleartext, which is why
//!   [`MailStore::seal_existing`] ends in `VACUUM INTO` a *new* file rather than
//!   an in-place `UPDATE`.
//! - **Structural columns stay cleartext** (`id`, `account_id`, `folder_id`,
//!   `uid`, `date`, `seen`, `flagged`, `size`, `priority`, blob references, every
//!   index), because they are what paging, ordering and unread counts run on.
//!   The metadata that therefore remains readable on disk — message counts,
//!   folder structure, arrival dates, sizes, read/starred flags — is stated in
//!   the UI rather than buried here. Anyone who needs *that* hidden needs FDE,
//!   which hides filenames too. One item deserves naming precisely, because it
//!   is sharper than "folder structure" sounds: a folder id is an **unkeyed**
//!   `sha256(path)[..8]` (`commands::mail::folder_id_for`), so a wordlist
//!   recovers which folders exist. Keying it would mean re-deriving every
//!   message id — which is also every AAD row key — so it is a stated cost
//!   rather than an oversight; `tests::encrypted` pins it.
//! - **A sealed column cannot carry a `UNIQUE`.** Randomized AEAD means two
//!   seals of one folder path differ, so the constraint would stop deduplicating
//!   and every sync would insert the folder again. `folders.path_key` and
//!   `mail_remote_allow.addr_key` are keyed digests (`mail_crypt::name_digest`)
//!   that carry the constraint in cleartext beside the sealed value. They leak
//!   equality and only equality — which is precisely what declaring the
//!   constraint already asserts. Because they are derived from the key rather
//!   than from the value alone, they have to be *maintained*: sealing a store
//!   that ran plain leaves them holding the cleartext, which is both a leak and
//!   a constraint that has stopped matching, so every keyed open runs
//!   [`MailStore::rekey_digest_columns`].

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use sha2::{Digest, Sha256};

use crate::schema::mail::{
    MailAttachmentMeta, MailDraft, MailFlag, MailFolder, MailFolderKind, MailHeader,
    MailHeaderPage, MailPriority, MailPriorityCounts, MailPrioritySource, MailSort,
    StagedAttachment,
};
use crate::services::mail_crypt::{self, MailKeys};

/// Forward-only schema version, recorded in `meta`.
///
/// **2** added the keyed `UNIQUE` stand-ins (`folders.path_key`,
/// `mail_remote_allow.addr_key`). It is a shape change rather than an additive
/// column, so it rebuilds those two tables — see [`MailStore::migrate`].
const SCHEMA_VERSION: i64 = 2;

/// How many rows a search over an **encrypted** store will open before it stops
/// and says so.
///
/// `LIKE` cannot run over ciphertext, and a blind index — a deterministic
/// per-token fingerprint — was rejected outright: it leaks word frequency and
/// answers "does this mailbox contain word X", which is most of what the
/// encryption was for. What is left is decrypt-on-scan, which is fast
/// (XChaCha20 runs on the order of a GB/s, so this bound is milliseconds) but
/// not free, so it is bounded. When the bound is hit the page reports
/// `scanned`, and the UI says *"searched the most recent N messages"* — the one
/// thing a search must never do is silently truncate and look complete.
const MAX_SEARCH_SCAN: usize = 50_000;

/// The `meta` key set once the store's existing plaintext has been sealed.
const META_ENCRYPTED: &str = "encrypted";

/// Bodies larger than this are content-addressed into `blobs/` instead of
/// living in the row.
pub const INLINE_BODY_LIMIT: usize = 256 * 1024;

pub struct MailStore {
    dir: PathBuf,
    conn: Mutex<Connection>,
    /// `None` means the store is unencrypted — every column holds the value the
    /// caller passed. Not a degraded mode: it is what an install that never
    /// turned encryption on looks like, and it is the path every test below
    /// exercises.
    keys: Option<Arc<MailKeys>>,
    /// Held only by [`MailStore::open_ephemeral`], and only so it is deleted
    /// when the store is dropped.
    _scratch: Option<tempfile::TempDir>,
}

impl std::fmt::Debug for MailStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailStore")
            .field("dir", &self.dir)
            .field("encrypted", &self.keys.is_some())
            .finish()
    }
}

impl MailStore {
    /// Open (creating if needed) an **unencrypted** store rooted at `dir`.
    pub fn open(dir: &Path) -> Result<Self, String> {
        Self::open_with_keys(dir, None)
    }

    /// Open the store rooted at `dir`, sealing every sensitive value under
    /// `keys` when they are given.
    ///
    /// Opening an existing cleartext store *with* keys performs the one-way
    /// migration in [`MailStore::seal_existing`], which is idempotent and
    /// therefore restartable: interrupting it half-way leaves a store where some
    /// values are sealed and some are not, and the next open finishes the job.
    pub fn open_with_keys(dir: &Path, keys: Option<Arc<MailKeys>>) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create the mail store: {e}"))?;
        harden(dir, 0o700);
        let db = dir.join("mail.db");
        let conn = Connection::open(&db).map_err(|e| e.to_string())?;
        harden(&db, 0o600);
        configure(&conn);
        let mut store = MailStore {
            dir: dir.to_path_buf(),
            conn: Mutex::new(conn),
            keys,
            _scratch: None,
        };
        store.migrate()?;
        let sealed = store.seal_existing()?;
        // Between the sealing pass and the vacuum, deliberately. The pass is
        // what strands a digest — it seals a value and leaves the key column
        // beside it untouched — and the vacuum is what stops the old cleartext
        // key from surviving in the freelist of the file that replaces it.
        let rekeyed = store.rekey_digest_columns()? > 0;
        if sealed || rekeyed {
            store.vacuum_into_place()?;
        }
        Ok(store)
    }

    /// A store that lives and dies with the process.
    ///
    /// This is the **degrade path**, not a test fixture: it is what
    /// `commands::mail` opens when the store key cannot be reached — a locked
    /// Secret Service collection, most often, which reads identically to
    /// "nothing saved" and which this codebase has already been bitten by once.
    /// The alternative is a mailbox that will not open at all, and a mail client
    /// that refuses to show mail because a keyring prompt went unanswered is a
    /// worse outcome than one that forgets what it downloaded.
    ///
    /// The database is `:memory:`, so the index never touches disk. Blob
    /// payloads have to land *somewhere* — they can be tens of megabytes — so
    /// they go into a temp directory that is removed on drop, sealed under a
    /// **freshly generated master key that exists only in this process**. A
    /// crash that skips the cleanup therefore leaves bytes nobody can ever read,
    /// rather than plaintext attachments in `/tmp`.
    pub fn open_ephemeral() -> Result<Self, String> {
        let scratch = tempfile::tempdir().map_err(|e| e.to_string())?;
        harden(scratch.path(), 0o700);
        let keys = Arc::new(MailKeys::derive(mail_crypt::Key::random()?));
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        configure(&conn);
        let store = MailStore {
            dir: scratch.path().to_path_buf(),
            conn: Mutex::new(conn),
            keys: Some(keys),
            _scratch: Some(scratch),
        };
        store.migrate()?;
        Ok(store)
    }

    /// Whether values in this store are sealed.
    pub fn is_encrypted(&self) -> bool {
        self.keys.is_some()
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    // ── Sealing one value ───────────────────────────────────────────────────

    /// A value bound for a sealed column: a `BLOB` envelope when the store has
    /// keys, the plain `TEXT` otherwise.
    ///
    /// SQLite's dynamic typing is what makes this work without two schemas —
    /// `subject BLOB` and `subject TEXT` coexist in one column, which is also
    /// what makes [`MailStore::seal_existing`] restartable row by row.
    fn seal_text(&self, account_id: &str, table: &str, column: &str, row: &str, value: &str) -> SqlValue {
        match &self.keys {
            Some(k) => SqlValue::Blob(mail_crypt::seal(
                &k.field,
                &mail_crypt::field_aad(account_id, table, column, row),
                value.as_bytes(),
            )),
            None => SqlValue::Text(value.to_string()),
        }
    }

    /// The nullable form. `NULL` stays `NULL` — sealing it would turn "no cached
    /// HTML part" into "an empty one", which the body cache distinguishes.
    fn seal_opt_text(
        &self,
        account_id: &str,
        table: &str,
        column: &str,
        row: &str,
        value: Option<&str>,
    ) -> SqlValue {
        match value {
            Some(v) => self.seal_text(account_id, table, column, row, v),
            None => SqlValue::Null,
        }
    }

    /// Read a possibly-sealed column.
    ///
    /// `None` means **the value was there and could not be opened** — a wrong
    /// key, or bytes that were altered on disk. It is deliberately distinct from
    /// `Some("")`: callers turn it into a per-message "damaged" marker rather
    /// than into empty content, because a subject line that silently reads as
    /// blank is an attacker's best case.
    fn open_text(
        &self,
        r: &Row<'_>,
        idx: usize,
        account_id: &str,
        table: &str,
        column: &str,
        row: &str,
    ) -> rusqlite::Result<Option<String>> {
        use rusqlite::types::ValueRef;
        Ok(match r.get_ref(idx)? {
            ValueRef::Null => Some(String::new()),
            ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(b) => match &self.keys {
                Some(k) => mail_crypt::open(
                    &k.field,
                    &mail_crypt::field_aad(account_id, table, column, row),
                    b,
                )
                .ok()
                .map(|p| String::from_utf8_lossy(&p).into_owned()),
                // A blob in a store with no keys is a store that *was* encrypted
                // and is now being opened without them. Nothing to do but say so.
                None => None,
            },
            other => Some(other.as_str().unwrap_or_default().to_string()),
        })
    }

    /// The nullable form: `Ok(None)` for a genuine SQL `NULL`, `Ok(Some(None))`
    /// for a value that would not open.
    #[allow(clippy::type_complexity)]
    fn open_opt_text(
        &self,
        r: &Row<'_>,
        idx: usize,
        account_id: &str,
        table: &str,
        column: &str,
        row: &str,
    ) -> rusqlite::Result<Option<Option<String>>> {
        use rusqlite::types::ValueRef;
        if matches!(r.get_ref(idx)?, ValueRef::Null) {
            return Ok(None);
        }
        Ok(Some(self.open_text(r, idx, account_id, table, column, row)?))
    }

    /// The cleartext stand-in a sealed column's `UNIQUE` moves onto.
    fn digest_of(&self, namespace: &str, value: &str) -> String {
        match &self.keys {
            Some(k) => mail_crypt::name_digest(&k.name, namespace, value),
            // Unencrypted stores keep the readable value as its own key, so the
            // constraint means exactly what it always did and no migration is
            // needed to turn encryption on later.
            None => value.to_string(),
        }
    }

    pub fn blobs_dir(&self) -> PathBuf {
        self.dir.join("blobs")
    }

    /// The staging directory for one draft's picked attachments.
    pub fn outbox_dir(&self, draft_id: &str) -> PathBuf {
        self.dir.join("outbox").join(sanitize_id(draft_id))
    }

    fn migrate(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS folders (
                id         TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                -- The cleartext key the UNIQUE moved onto when `path` became
                -- sealable. `mail_crypt::name_digest` in an encrypted store,
                -- the path itself in a plain one.
                path_key   TEXT NOT NULL,
                path       TEXT NOT NULL,
                name       TEXT NOT NULL,
                kind       TEXT NOT NULL,
                unread     INTEGER NOT NULL DEFAULT 0,
                total      INTEGER NOT NULL DEFAULT 0,
                UNIQUE (account_id, path_key)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id            TEXT PRIMARY KEY,
                account_id    TEXT NOT NULL,
                folder_id     TEXT NOT NULL,
                uid           INTEGER NOT NULL,
                subject       TEXT NOT NULL DEFAULT '',
                from_json     TEXT NOT NULL DEFAULT '{}',
                to_json       TEXT NOT NULL DEFAULT '[]',
                cc_json       TEXT NOT NULL DEFAULT '[]',
                date          TEXT NOT NULL DEFAULT '',
                seen          INTEGER NOT NULL DEFAULT 0,
                flagged       INTEGER NOT NULL DEFAULT 0,
                answered      INTEGER NOT NULL DEFAULT 0,
                deleted       INTEGER NOT NULL DEFAULT 0,
                has_attachments INTEGER NOT NULL DEFAULT 0,
                size          INTEGER NOT NULL DEFAULT 0,
                preview       TEXT NOT NULL DEFAULT '',
                malformed     TEXT NOT NULL DEFAULT '',
                rfc_message_id TEXT NOT NULL DEFAULT '',
                authres_json  TEXT NOT NULL DEFAULT '',
                priority      TEXT NOT NULL DEFAULT '',
                priority_source TEXT NOT NULL DEFAULT '',
                priority_reason TEXT NOT NULL DEFAULT '',
                UNIQUE (folder_id, uid)
            );
            CREATE INDEX IF NOT EXISTS messages_by_folder ON messages (folder_id, date DESC);
            CREATE TABLE IF NOT EXISTS bodies_cache (
                message_id  TEXT PRIMARY KEY,
                version     INTEGER NOT NULL,
                html        TEXT,
                text        TEXT,
                links_json  TEXT NOT NULL DEFAULT '[]',
                remote_refs INTEGER NOT NULL DEFAULT 0,
                truncated   INTEGER NOT NULL DEFAULT 0,
                raw_blob    TEXT
            );
            CREATE TABLE IF NOT EXISTS attachments (
                message_id TEXT NOT NULL,
                part_id    TEXT NOT NULL,
                filename   TEXT NOT NULL,
                mime       TEXT NOT NULL,
                size       INTEGER NOT NULL,
                inline     INTEGER NOT NULL DEFAULT 0,
                mismatch   TEXT,
                blob       TEXT NOT NULL,
                PRIMARY KEY (message_id, part_id)
            );
            CREATE TABLE IF NOT EXISTS drafts (
                id         TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                json       TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS staged (
                draft_id  TEXT NOT NULL,
                staged_id TEXT NOT NULL,
                filename  TEXT NOT NULL,
                mime      TEXT NOT NULL,
                size      INTEGER NOT NULL,
                PRIMARY KEY (draft_id, staged_id)
            );
            CREATE TABLE IF NOT EXISTS mail_remote_allow (
                addr_key TEXT PRIMARY KEY,
                address  TEXT NOT NULL
            );
            "#,
        )
        .map_err(|e| e.to_string())?;
        // Additive column for a store created before it existed. `CREATE TABLE
        // IF NOT EXISTS` is a no-op on an existing table, so a dev database from
        // an earlier run would otherwise keep the old shape forever; a duplicate
        // -column error here just means the column is already there.
        let _ = conn.execute(
            "ALTER TABLE messages ADD COLUMN rfc_message_id TEXT NOT NULL DEFAULT ''",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE messages ADD COLUMN authres_json TEXT NOT NULL DEFAULT ''",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE messages ADD COLUMN priority TEXT NOT NULL DEFAULT ''",
            [],
        );
        // #205 provenance. Sealable (a model's reason quotes the message), so
        // they are read through `open_text` like every other value column — but
        // additive, for the reason the `priority` ALTER above documents: a dev
        // database from before they existed keeps its old shape otherwise, and a
        // duplicate-column error here just means they are already there.
        let _ = conn.execute(
            "ALTER TABLE messages ADD COLUMN priority_source TEXT NOT NULL DEFAULT ''",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE messages ADD COLUMN priority_reason TEXT NOT NULL DEFAULT ''",
            [],
        );
        // The Important/Urgent lists span every account and folder, so their only
        // WHERE is this column; unindexed, that is a full scan of the whole
        // mailbox on every page and every badge refresh.
        //
        // It is created HERE and deliberately not in the batch above. The batch
        // runs before this ALTER, so on a database that predates the column an
        // index naming it fails — and `execute_batch` is fallible-and-propagated,
        // so that failure would not be a missing index, it would be a mail store
        // that no longer opens. Every existing install takes exactly that path.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS messages_by_priority ON messages (priority, date DESC)",
            [],
        )
        .map_err(|e| e.to_string())?;
        // v1 → v2. Both of these moved a `UNIQUE`/`PRIMARY KEY` off a column that
        // became sealable and onto a keyed digest beside it, which SQLite cannot
        // express as an `ALTER` — a constraint change is a table rebuild. The
        // rows are copied through Rust rather than through `INSERT … SELECT`
        // because the new key column is a *keyed* digest of the old value, which
        // SQL has no function for.
        //
        // Guarded on the column's existence rather than on the recorded schema
        // version, for the reason the priority ALTER above documents: a dev
        // database can be in any half-state, and "does the column exist" is a
        // question with one true answer where "what does `meta` claim" is a
        // question about a row that may have been written before a crash.
        if conn.prepare("SELECT path_key FROM folders LIMIT 0").is_err() {
            let old: Vec<(String, String, String, String, String, i64, i64)> = {
                let mut stmt = conn
                    .prepare("SELECT id, account_id, path, name, kind, unread, total FROM folders")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            };
            conn.execute_batch(
                r#"
                ALTER TABLE folders RENAME TO folders_v1;
                CREATE TABLE folders (
                    id         TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    path_key   TEXT NOT NULL,
                    path       TEXT NOT NULL,
                    name       TEXT NOT NULL,
                    kind       TEXT NOT NULL,
                    unread     INTEGER NOT NULL DEFAULT 0,
                    total      INTEGER NOT NULL DEFAULT 0,
                    UNIQUE (account_id, path_key)
                );
                "#,
            )
            .map_err(|e| e.to_string())?;
            for (id, account_id, path, name, kind, unread, total) in old {
                // The values are still cleartext at this point — `seal_existing`
                // runs after `migrate` and seals them in place. Copying them
                // verbatim here is what keeps the two steps independent, and
                // therefore each one restartable on its own.
                conn.execute(
                    "INSERT OR REPLACE INTO folders
                        (id, account_id, path_key, path, name, kind, unread, total)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        id,
                        account_id,
                        self.digest_of(&account_id, &path),
                        path,
                        name,
                        kind,
                        unread,
                        total
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
            conn.execute_batch("DROP TABLE folders_v1;")
                .map_err(|e| e.to_string())?;
        }
        if conn
            .prepare("SELECT addr_key FROM mail_remote_allow LIMIT 0")
            .is_err()
        {
            let old: Vec<String> = {
                let mut stmt = conn
                    .prepare("SELECT address FROM mail_remote_allow")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            };
            conn.execute_batch(
                r#"
                ALTER TABLE mail_remote_allow RENAME TO mail_remote_allow_v1;
                CREATE TABLE mail_remote_allow (
                    addr_key TEXT PRIMARY KEY,
                    address  TEXT NOT NULL
                );
                "#,
            )
            .map_err(|e| e.to_string())?;
            for address in old {
                conn.execute(
                    "INSERT OR REPLACE INTO mail_remote_allow (addr_key, address) VALUES (?1, ?2)",
                    params![self.digest_of("mail_remote_allow", &address), address],
                )
                .map_err(|e| e.to_string())?;
            }
            conn.execute_batch("DROP TABLE mail_remote_allow_v1;")
                .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
            params![SCHEMA_VERSION.to_string()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Blobs ───────────────────────────────────────────────────────────────

    /// The name `bytes` are stored under.
    ///
    /// `SHA-256(plaintext)` in a plain store — content-addressed, opaque, and
    /// carrying no trace of a sender-supplied filename, which is the property
    /// the blob directory was built for. `HMAC-SHA256(k_addr, plaintext)` in an
    /// encrypted one, which keeps *all* of that and closes two further holes:
    /// the bare digest is a confirmation oracle (hash a file you suspect
    /// somebody received, look for its name in a directory listing), and a
    /// digest of the *ciphertext* could not dedupe at all, because two seals of
    /// identical bytes differ.
    ///
    /// Both are 64 hex characters, so [`MailStore::get_blob`]'s validation is
    /// unchanged — it now means something different.
    fn blob_name(&self, bytes: &[u8]) -> String {
        match &self.keys {
            Some(k) => mail_crypt::blob_id(&k.addr, bytes),
            None => hex_digest(bytes),
        }
    }

    /// Store `bytes` under their content address and return it.
    pub fn put_blob(&self, bytes: &[u8]) -> Result<String, String> {
        let hex = self.blob_name(bytes);
        let dir = self.blobs_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        harden(&dir, 0o700);
        let path = dir.join(&hex);
        if !path.exists() {
            let payload = match &self.keys {
                Some(k) => mail_crypt::seal(&k.blob, &mail_crypt::blob_aad(&hex), bytes),
                None => bytes.to_vec(),
            };
            std::fs::write(&path, &payload).map_err(|e| e.to_string())?;
            harden(&path, 0o600);
        }
        Ok(hex)
    }

    pub fn get_blob(&self, digest: &str) -> Result<Vec<u8>, String> {
        let digest = sanitize_id(digest);
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("not a blob id".into());
        }
        let raw = std::fs::read(self.blobs_dir().join(&digest)).map_err(|e| e.to_string())?;
        match &self.keys {
            Some(k) => mail_crypt::open(&k.blob, &mail_crypt::blob_aad(&digest), &raw)
                .map(|p| p.to_vec())
                .map_err(|e| e.to_string()),
            None => Ok(raw),
        }
    }

    // ── Folders ─────────────────────────────────────────────────────────────

    /// Insert or update one folder row.
    ///
    /// Two conflict targets, because the row has two identities and they can
    /// disagree. `(account_id, path_key)` is the keyed one this table was
    /// rebuilt around; `id` is the caller's `sha256`-derived name for the same
    /// folder ([`commands::mail::folder_id_for`]), and it is *unkeyed*, so it
    /// survives changes of key that `path_key` does not. A row whose `path_key`
    /// was computed under different keys — a store that ran plain and was
    /// sealed later, a key that was reset — matches neither the new digest nor
    /// nothing at all: it matches on `id` alone, and with a single conflict
    /// clause the insert fell through to the primary key and every sync died on
    /// *"UNIQUE constraint failed: folders.id"*. The second clause makes that
    /// case an update that rewrites the stale key, so the row repairs itself
    /// even if [`MailStore::rekey_digest_columns`] never ran.
    pub fn upsert_folder(&self, folder: &MailFolder) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "INSERT INTO folders (id, account_id, path_key, path, name, kind, unread, total)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(account_id, path_key) DO UPDATE SET
                path = excluded.path, name = excluded.name, kind = excluded.kind,
                unread = excluded.unread, total = excluded.total
             ON CONFLICT(id) DO UPDATE SET
                path_key = excluded.path_key, path = excluded.path,
                name = excluded.name, kind = excluded.kind,
                unread = excluded.unread, total = excluded.total",
            params![
                folder.id,
                folder.account_id,
                self.digest_of(&folder.account_id, &folder.path),
                self.seal_text(&folder.account_id, "folders", "path", &folder.id, &folder.path),
                self.seal_text(&folder.account_id, "folders", "name", &folder.id, &folder.name),
                folder.kind.as_str(),
                folder.unread,
                folder.total
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// One folder row, with its two sealed columns opened.
    ///
    /// A path that will not open reads as empty rather than failing the whole
    /// list: one damaged row must not make a mailbox unbrowsable, and the
    /// folder's `id` — which is cleartext and is what every other query joins on
    /// — is unaffected.
    fn row_to_folder(&self, r: &Row<'_>) -> rusqlite::Result<MailFolder> {
        let id: String = r.get(0)?;
        let account_id: String = r.get(1)?;
        Ok(MailFolder {
            path: self
                .open_text(r, 2, &account_id, "folders", "path", &id)?
                .unwrap_or_default(),
            name: self
                .open_text(r, 3, &account_id, "folders", "name", &id)?
                .unwrap_or_default(),
            kind: MailFolderKind::from_str_lossy(&r.get::<_, String>(4)?),
            unread: r.get(5)?,
            total: r.get(6)?,
            id,
            account_id,
        })
    }

    pub fn folders(&self, account_id: &str) -> Result<Vec<MailFolder>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, account_id, path, name, kind, unread, total
                 FROM folders WHERE account_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![account_id], |r| self.row_to_folder(r))
            .map_err(|e| e.to_string())?;
        let mut all: Vec<MailFolder> = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        // Ordered here rather than in SQL: `ORDER BY path` over a sealed column
        // would sort by ciphertext, i.e. at random, and a folder list whose order
        // changed on every sync would be its own bug report. The list is one
        // account's folders — tens of rows — so this costs nothing.
        all.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(all)
    }

    pub fn folder(&self, folder_id: &str) -> Result<Option<MailFolder>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.query_row(
            "SELECT id, account_id, path, name, kind, unread, total FROM folders WHERE id = ?1",
            params![folder_id],
            |r| self.row_to_folder(r),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// Recompute a folder's counters from the rows actually stored.
    pub fn refresh_counts(&self, folder_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "UPDATE folders SET
               total  = (SELECT COUNT(*) FROM messages WHERE folder_id = ?1),
               unread = (SELECT COUNT(*) FROM messages WHERE folder_id = ?1 AND seen = 0)
             WHERE id = ?1",
            params![folder_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Headers ─────────────────────────────────────────────────────────────

    /// Insert or update one header row. Returns `true` when the row was new,
    /// which is what the sync summary counts as a new message.
    pub fn upsert_header(&self, header: &MailHeader) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let existed: bool = conn
            .query_row(
                "SELECT 1 FROM messages WHERE id = ?1",
                params![header.id],
                |_| Ok(true),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(false);
        conn.execute(
            "INSERT INTO messages (id, account_id, folder_id, uid, subject, from_json, to_json,
                                   cc_json, date, seen, flagged, answered, has_attachments,
                                   size, preview, malformed, rfc_message_id, authres_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
             ON CONFLICT(id) DO UPDATE SET
                subject = excluded.subject, from_json = excluded.from_json,
                to_json = excluded.to_json, cc_json = excluded.cc_json,
                date = excluded.date, seen = excluded.seen, flagged = excluded.flagged,
                answered = excluded.answered, has_attachments = excluded.has_attachments,
                size = excluded.size, preview = excluded.preview,
                malformed = excluded.malformed,
                rfc_message_id = excluded.rfc_message_id,
                authres_json = excluded.authres_json",
            // NOTE: `priority` is deliberately absent from BOTH halves. Absent
            // from the INSERT so a newly-synced message starts unmarked, and
            // absent from the `DO UPDATE SET` so a re-sync — which runs over
            // every message in a folder, every check — cannot wipe a mark the
            // user made. The mark is the one column here the *user* owns rather
            // than the server, so the server's copy must never overwrite it.
            params![
                header.id,
                header.account_id,
                header.folder_id,
                header.uid,
                self.seal_header(header, "subject", &header.subject),
                self.seal_header(
                    header,
                    "from_json",
                    &serde_json::to_string(&header.from).unwrap_or_default()
                ),
                self.seal_header(
                    header,
                    "to_json",
                    &serde_json::to_string(&header.to).unwrap_or_default()
                ),
                self.seal_header(
                    header,
                    "cc_json",
                    &serde_json::to_string(&header.cc).unwrap_or_default()
                ),
                header.date,
                header.seen as i64,
                header.flagged as i64,
                header.answered as i64,
                header.has_attachments as i64,
                header.size as i64,
                self.seal_header(header, "preview", &header.preview),
                self.seal_header(
                    header,
                    "malformed",
                    &header
                        .malformed_headers
                        .as_ref()
                        .map(|m| m.join(","))
                        .unwrap_or_default()
                ),
                self.seal_header(
                    header,
                    "rfc_message_id",
                    header.rfc_message_id.as_deref().unwrap_or_default()
                ),
                // The stored copy always carries the parsed data in its
                // `Unconfigured` state; the trust decision is re-derived on
                // every read (`row_to_header`), so changing the account's
                // trusted id re-judges already-synced mail with no re-sync.
                self.seal_header(
                    header,
                    "authres_json",
                    &header
                        .auth
                        .as_ref()
                        .and_then(|a| serde_json::to_string(a).ok())
                        .unwrap_or_default()
                ),
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(!existed)
    }

    fn seal_header(&self, header: &MailHeader, column: &str, value: &str) -> SqlValue {
        self.seal_text(&header.account_id, "messages", column, &header.id, value)
    }

    /// The `SELECT` list every header read shares, so a column added to one is
    /// added to all of them and `row_to_header`'s indices cannot drift.
    const HEADER_COLUMNS: &'static str = "id, account_id, folder_id, uid, subject, from_json, \
         to_json, cc_json, date, seen, flagged, answered, has_attachments, size, preview, \
         malformed, rfc_message_id, authres_json, priority, priority_source, priority_reason";

    /// One page of a folder's headers in the requested order, optionally
    /// filtered.
    ///
    /// The query is a `LIKE` over subject/sender/preview and is bound as a
    /// parameter — the caller's text never reaches the SQL string. The **order**
    /// cannot be bound (SQLite takes no parameter in an `ORDER BY`), which is
    /// exactly why `sort` is a `MailSort` and not a column name: `order_clause`
    /// maps the closed set onto fixed literals, so nothing the caller says is
    /// ever interpolated.
    ///
    /// Ordering here rather than in the list component is what makes it mean
    /// anything: the list is paged, so sorting on the frontend would order the
    /// hundred rows that happen to be on screen.
    pub fn headers_page(
        &self,
        folder_id: &str,
        offset: u32,
        limit: u32,
        query: Option<&str>,
        sort: MailSort,
        desc: bool,
    ) -> Result<MailHeaderPage, String> {
        self.page("folder_id = ?1 AND deleted = 0", folder_id, offset, limit, query, sort, desc)
    }

    /// One page of whichever set `scope_where`/`scope_param` select.
    ///
    /// `headers_page` and `priority_page` both land here, which is what makes
    /// the claim in their docs — that the Important list "sorts, searches and
    /// pages exactly like a folder does" — a fact about the code rather than an
    /// intention. `scope_where` is a fixed literal supplied by this file and
    /// binds `?1`; nothing a caller says is ever formatted into SQL.
    ///
    /// # Searching an encrypted store
    ///
    /// `LIKE` cannot run over ciphertext, so a sealed store searches by
    /// **decrypt-on-scan**: walk the scope in the requested order, open
    /// `subject`/`from_json`/`preview` per row, keep the matches, and stop after
    /// [`MAX_SEARCH_SCAN`] rows. Two consequences, both deliberate and both
    /// surfaced rather than hidden:
    ///
    /// - `total` becomes *matches found within the scan*, not `COUNT(*)`. The
    ///   pager stops claiming a page count it cannot know.
    /// - `scanned` is set when the bound was hit, so the UI can say how much of
    ///   the mailbox the answer covers.
    ///
    /// With no query nothing is scanned at all — only the rows on the page are
    /// opened, which is the case that has to stay cheap.
    #[allow(clippy::too_many_arguments)]
    fn page(
        &self,
        scope_where: &'static str,
        scope_param: &str,
        offset: u32,
        limit: u32,
        query: Option<&str>,
        sort: MailSort,
        desc: bool,
    ) -> Result<MailHeaderPage, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let limit = limit.clamp(1, 500);
        let needle = query.map(str::trim).filter(|q| !q.is_empty());

        // ── Encrypted + a query: decrypt-on-scan ────────────────────────────
        if self.keys.is_some() {
            if let Some(needle) = needle {
                let needle = needle.to_lowercase();
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT {} FROM messages WHERE {scope_where} ORDER BY {}",
                        Self::HEADER_COLUMNS,
                        Self::order_clause(sort, desc),
                    ))
                    .map_err(|e| e.to_string())?;
                let mut rows = stmt.query(params![scope_param]).map_err(|e| e.to_string())?;

                let mut items = Vec::new();
                let mut matched = 0u32;
                let mut looked_at = 0usize;
                let mut capped = false;
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    if looked_at >= MAX_SEARCH_SCAN {
                        capped = true;
                        break;
                    }
                    looked_at += 1;
                    let header = self.row_to_header(row).map_err(|e| e.to_string())?;
                    // The same three columns the `LIKE` covered, so the two
                    // paths answer the same question.
                    let hit = header.subject.to_lowercase().contains(&needle)
                        || header.preview.to_lowercase().contains(&needle)
                        || serde_json::to_string(&header.from)
                            .unwrap_or_default()
                            .to_lowercase()
                            .contains(&needle);
                    if !hit {
                        continue;
                    }
                    matched += 1;
                    if matched > offset && items.len() < limit as usize {
                        items.push(header);
                    }
                }
                return Ok(MailHeaderPage {
                    items,
                    total: matched,
                    scanned: capped.then_some(looked_at as u32),
                });
            }

            // Encrypted, no query: plain paging, no `LIKE` at all. Applying one
            // to a sealed column would be comparing a pattern against ciphertext
            // — never a match, and the empty folder it produced would look like
            // a sync bug rather than an encoding one.
            let total: u32 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM messages WHERE {scope_where}"),
                    params![scope_param],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {} FROM messages WHERE {scope_where} ORDER BY {} LIMIT ?2 OFFSET ?3",
                    Self::HEADER_COLUMNS,
                    Self::order_clause(sort, desc),
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![scope_param, limit, offset], |r| self.row_to_header(r))
                .map_err(|e| e.to_string())?;
            let items = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            return Ok(MailHeaderPage {
                items,
                total,
                scanned: None,
            });
        }

        // ── Plain store: the bound `LIKE`, unchanged ────────────────────────
        let pattern = needle
            .map(|q| format!("%{}%", q.replace('%', "\\%").replace('_', "\\_")))
            .unwrap_or_else(|| "%".to_string());
        let filter = "AND (subject LIKE ?2 ESCAPE '\\' OR from_json LIKE ?2 ESCAPE '\\' \
                      OR preview LIKE ?2 ESCAPE '\\')";

        let total: u32 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM messages WHERE {scope_where} {filter}"),
                params![scope_param, pattern],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM messages WHERE {scope_where} {filter} ORDER BY {} LIMIT ?3 OFFSET ?4",
                Self::HEADER_COLUMNS,
                Self::order_clause(sort, desc),
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![scope_param, pattern, limit, offset], |r| {
                self.row_to_header(r)
            })
            .map_err(|e| e.to_string())?;
        let items = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(MailHeaderPage {
            items,
            total,
            scanned: None,
        })
    }

    /// The `ORDER BY` body for one sort, as a **fixed literal per variant**.
    ///
    /// Every branch returns a constant `&'static str`; nothing a caller supplies
    /// is formatted in, which is what keeps the one interpolated clause in this
    /// file safe. `desc` picks between two constants rather than being spliced.
    ///
    /// Two decisions live in the tie-breaks. Every non-date sort falls back to
    /// `date DESC, uid DESC`, because `flagged` and `has_attachments` are single
    /// bits and `size` collides freely — without a tie-break the order *within*
    /// a group would be whatever SQLite happened to scan, and it would change
    /// between two reads of an unchanged folder. And the tie-break stays
    /// newest-first even when the primary key is ascending: flipping to
    /// "smallest first" is a statement about size, not a request to read a
    /// mailbox backwards.
    fn order_clause(sort: MailSort, desc: bool) -> &'static str {
        match (sort, desc) {
            (MailSort::Date, true) => "date DESC, uid DESC",
            (MailSort::Date, false) => "date ASC, uid ASC",
            // Descending puts the starred mail on top, which is why every list
            // here defaults to it: `flagged DESC` is "flagged first", and a star
            // sort that opened on the unstarred majority would be useless.
            (MailSort::Flagged, true) => "flagged DESC, date DESC, uid DESC",
            (MailSort::Flagged, false) => "flagged ASC, date DESC, uid DESC",
            (MailSort::Attachments, true) => "has_attachments DESC, date DESC, uid DESC",
            (MailSort::Attachments, false) => "has_attachments ASC, date DESC, uid DESC",
            (MailSort::Size, true) => "size DESC, date DESC, uid DESC",
            (MailSort::Size, false) => "size ASC, date DESC, uid DESC",
        }
    }

    pub fn header(&self, message_id: &str) -> Result<Option<MailHeader>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.query_row(
            &format!("SELECT {} FROM messages WHERE id = ?1", Self::HEADER_COLUMNS),
            params![message_id],
            |r| self.row_to_header(r),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn set_flag(&self, message_id: &str, flag: MailFlag, value: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        // `flag.column()` is a fixed `&'static str` per enum variant, so this
        // is the one place a column name is formatted into SQL and nothing
        // caller-controlled can reach it.
        let sql = format!("UPDATE messages SET {} = ?1 WHERE id = ?2", flag.column());
        conn.execute(&sql, params![value as i64, message_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The server-side UIDs of everything still unread in a folder.
    ///
    /// Read **before** the local rows are flipped, because it is what the IMAP
    /// half of "mark all as read" addresses — flipping first and then asking
    /// would return nothing and quietly turn the operation local-only.
    pub fn unseen_uids(&self, folder_id: &str) -> Result<Vec<u32>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut stmt = conn
            .prepare("SELECT uid FROM messages WHERE folder_id = ?1 AND seen = 0 ORDER BY uid")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![folder_id], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        let mut uids = Vec::new();
        for r in rows {
            uids.push(r.map_err(|e| e.to_string())? as u32);
        }
        Ok(uids)
    }

    /// The highest UID stored for a folder, or `None` when the folder holds no
    /// messages yet.
    ///
    /// This is the sync loop's **arrival watermark**. IMAP UIDs rise
    /// monotonically within a folder, so a message whose UID exceeds every one
    /// we have already seen is one that *arrived* since the last check — as
    /// opposed to one merely inserted into the local index for the first time,
    /// which every message in the initial backlog of a folder also is. The
    /// keyword filters must fire only on the former: `None` here (a folder's
    /// first sync) means "everything present is history", and the caller files
    /// none of it. The alternative — treating first-insert as arrival — marks a
    /// user's entire mail history the moment a rule exists before the folder is
    /// first pulled, which is exactly the "apply to existing" the user did not
    /// ask for.
    pub fn folder_max_uid(&self, folder_id: &str) -> Result<Option<u32>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let max: Option<i64> = conn
            .query_row(
                "SELECT MAX(uid) FROM messages WHERE folder_id = ?1",
                params![folder_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        Ok(max.map(|m| m as u32))
    }

    /// Mark every unread message in a folder read, locally. Returns how many
    /// rows actually changed, which is the number the UI reports — a folder
    /// already fully read answers 0 rather than claiming work it did not do.
    pub fn mark_folder_seen(&self, folder_id: &str) -> Result<u32, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let changed = conn
            .execute(
                "UPDATE messages SET seen = 1 WHERE folder_id = ?1 AND seen = 0",
                params![folder_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed as u32)
    }

    // ── Priority marks (Important / Urgent) ─────────────────────────────────

    /// Set — or with `None`, clear — one message's local priority mark.
    ///
    /// The value written is `MailPriority::as_str()`, a fixed literal per
    /// variant, and it is **bound**, not formatted: this is a data column, not
    /// the `ORDER BY` clause, so nothing here needs `order_clause`'s treatment.
    ///
    /// A message that is not in the index is not an error to shout about — it
    /// answers `false`, so a caller can tell "nothing changed" from "done". The
    /// realistic way to get there is marking a message and having the folder
    /// re-synced out from under it.
    pub fn set_priority(
        &self,
        message_id: &str,
        priority: Option<MailPriority>,
    ) -> Result<bool, String> {
        // A bare `set_priority` is the user's own hand — the right-click menu and
        // `mail_priority_set`. The filter and the model call `set_priority_ex`
        // with their own provenance, so the classifier can never masquerade as a
        // hand-mark (or as a keyword rule).
        self.set_priority_ex(message_id, priority, MailPrioritySource::User, "")
    }

    /// [`set_priority`], but recording **who** set the mark and **why** (#205).
    ///
    /// `source`/`reason` are sealed alongside every other value column when the
    /// store has keys — a model's reason quotes the message, which says as much
    /// as a subject line. Clearing the mark (`priority = None`) also clears the
    /// provenance, so a message the user un-marks carries no stale "the model
    /// said…" behind it.
    ///
    /// The AAD binds each sealed value to this message's `account_id`, which is
    /// read from the row itself; a message not in the index changes nothing and
    /// answers `false`, exactly as [`set_priority`] does.
    pub fn set_priority_ex(
        &self,
        message_id: &str,
        priority: Option<MailPriority>,
        source: MailPrioritySource,
        reason: &str,
    ) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let Some(account_id) = conn
            .query_row(
                "SELECT account_id FROM messages WHERE id = ?1",
                params![message_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        else {
            return Ok(false);
        };
        let value = priority.map(|p| p.as_str()).unwrap_or("");
        // Provenance is only meaningful while a mark is set; a cleared mark
        // stores empty strings so nothing is left behind.
        let (src, rsn) = match priority {
            Some(_) => (source.as_str(), reason),
            None => ("", ""),
        };
        let src_v = self.seal_text(&account_id, "messages", "priority_source", message_id, src);
        let rsn_v = self.seal_text(&account_id, "messages", "priority_reason", message_id, rsn);
        let changed = conn
            .execute(
                "UPDATE messages SET priority = ?1, priority_source = ?2, priority_reason = ?3 \
                 WHERE id = ?4",
                params![value, src_v, rsn_v, message_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    /// The newest **unmarked** messages a filter rule could still act on.
    ///
    /// Backs "apply my rules to mail I already have", and its three restrictions
    /// are the whole of that command's safety:
    ///
    /// - `priority = ''` — a message the user (or an earlier run) already filed
    ///   is never re-examined, so applying rules cannot overwrite a correction.
    /// - **`sent`/`drafts`/`trash`/`junk` are excluded**, as a fixed literal
    ///   list. A rule watching for the word *invoice* would otherwise pull every
    ///   invoice the user ever wrote into their alert list, and mail the server
    ///   already judged spam is the last thing an urgency list should surface.
    ///   Folders of *any other kind* — including `other`, i.e. everything the
    ///   user's own server-side rules sort into — are in scope, because those are
    ///   exactly where the interesting mail has been filed.
    /// - `limit`, clamped, ordered newest-first. This is a decrypt-per-row scan
    ///   on a sealed store (the `page` doc explains why nothing else is
    ///   possible), so it is bounded for the same reason a search is, and the
    ///   caller reports the bound rather than implying whole-mailbox coverage.
    pub fn unmarked_headers(
        &self,
        account_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<MailHeader>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let limit = limit.clamp(1, MAX_SEARCH_SCAN as u32);
        // Both branches are fixed literals differing only in one bound clause;
        // nothing a caller says is formatted into the SQL.
        const SCOPE: &str = "priority = '' AND deleted = 0 AND folder_id NOT IN \
             (SELECT id FROM folders WHERE kind IN ('sent','drafts','trash','junk'))";
        let rows = match account_id {
            Some(account) => {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT {} FROM messages WHERE {SCOPE} AND account_id = ?1 \
                         ORDER BY date DESC, uid DESC LIMIT ?2",
                        Self::HEADER_COLUMNS
                    ))
                    .map_err(|e| e.to_string())?;
                let iter = stmt
                    .query_map(params![account, limit], |r| self.row_to_header(r))
                    .map_err(|e| e.to_string())?;
                iter.collect::<Result<Vec<_>, _>>()
            }
            None => {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT {} FROM messages WHERE {SCOPE} \
                         ORDER BY date DESC, uid DESC LIMIT ?1",
                        Self::HEADER_COLUMNS
                    ))
                    .map_err(|e| e.to_string())?;
                let iter = stmt
                    .query_map(params![limit], |r| self.row_to_header(r))
                    .map_err(|e| e.to_string())?;
                iter.collect::<Result<Vec<_>, _>>()
            }
        };
        rows.map_err(|e| e.to_string())
    }

    /// One page of everything carrying `priority`, **across every account and
    /// every folder**.
    ///
    /// That cross-account span is the whole reason the mark is a local column
    /// rather than an IMAP move: no folder on any server can hold mail from two
    /// accounts, so the list this query backs could not exist server-side at
    /// all. It is otherwise deliberately the twin of `headers_page` — same
    /// `LIKE` filter bound as a parameter, same closed-set `order_clause`, same
    /// `deleted = 0` — so the Important list sorts, searches and pages exactly
    /// like a folder does and the frontend needs no second code path.
    pub fn priority_page(
        &self,
        priority: MailPriority,
        offset: u32,
        limit: u32,
        query: Option<&str>,
        sort: MailSort,
        desc: bool,
    ) -> Result<MailHeaderPage, String> {
        self.page(
            "priority = ?1 AND deleted = 0",
            priority.as_str(),
            offset,
            limit,
            query,
            sort,
            desc,
        )
    }

    /// How much marked mail there is, for the rail's two badges.
    ///
    /// One statement rather than four, because it feeds one render: the badges
    /// would otherwise disagree for as long as it took the second read to land.
    /// Counts **everything** marked, not just the unread — a list you file mail
    /// into is not an inbox, and a badge that emptied itself as you read would
    /// stop reporting the thing it exists to report. The unread halves come back
    /// beside it for the rail to tone with.
    pub fn priority_counts(&self) -> Result<MailPriorityCounts, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.query_row(
            "SELECT
               SUM(priority = 'important'),
               SUM(priority = 'urgent'),
               SUM(priority = 'important' AND seen = 0),
               SUM(priority = 'urgent' AND seen = 0)
             FROM messages WHERE deleted = 0",
            [],
            |r| {
                Ok(MailPriorityCounts {
                    // An empty table makes every SUM NULL, which is a count of
                    // zero and not a failure — hence the per-column default.
                    important: r.get::<_, Option<i64>>(0)?.unwrap_or(0) as u32,
                    urgent: r.get::<_, Option<i64>>(1)?.unwrap_or(0) as u32,
                    important_unread: r.get::<_, Option<i64>>(2)?.unwrap_or(0) as u32,
                    urgent_unread: r.get::<_, Option<i64>>(3)?.unwrap_or(0) as u32,
                })
            },
        )
        .map_err(|e| e.to_string())
    }

    /// Clear the mark from **every** message carrying `priority` — emptying one
    /// of the two lists in a single action — answering how many rows changed.
    ///
    /// One statement rather than a read-then-`set_priority`-per-row, and the two
    /// provenance columns go back to a plain `''`: they are sealed only while a
    /// mark is *set* (a model's reason quotes the message), and an empty value
    /// has nothing to hide — which is exactly why `open_text` reads a text cell
    /// straight through even in a sealed store. Deliberately **not** filtered on
    /// `deleted`: a mark left on a message that is already gone from the index
    /// is precisely the kind of leftover this action exists to get rid of, and
    /// it is invisible to the count the user is shown either way.
    pub fn clear_priority(&self, priority: MailPriority) -> Result<u32, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        // The value is bound, not formatted — `set_priority`'s rule, for the
        // same reason: this is a data column, not the `ORDER BY` clause.
        let changed = conn
            .execute(
                "UPDATE messages SET priority = '', priority_source = '', priority_reason = '' \
                 WHERE priority = ?1",
                params![priority.as_str()],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed as u32)
    }

    pub fn move_messages(&self, message_ids: &[String], dest_folder_id: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for id in message_ids {
            tx.execute(
                "UPDATE messages SET folder_id = ?1 WHERE id = ?2",
                params![dest_folder_id, id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Bodies ──────────────────────────────────────────────────────────────

    /// A cached sanitized body, **only** when it was produced by the current
    /// sanitizer version. A sanitizer fix therefore re-protects already-synced
    /// mail rather than leaving old output in place.
    #[allow(clippy::type_complexity)]
    pub fn cached_body(
        &self,
        message_id: &str,
        version: u32,
    ) -> Result<Option<(Option<String>, Option<String>, String, u32, bool)>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let row = conn
            .query_row(
                "SELECT html, text, links_json, remote_refs, truncated
                 FROM bodies_cache WHERE message_id = ?1 AND version = ?2",
                params![message_id, version],
                |r| {
                    let t = "bodies_cache";
                    Ok((
                        self.open_opt_text(r, 0, "", t, "html", message_id)?,
                        self.open_opt_text(r, 1, "", t, "text", message_id)?,
                        self.open_text(r, 2, "", t, "links_json", message_id)?,
                        r.get::<_, u32>(3)?,
                        r.get::<_, i64>(4)? != 0,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        // A cached body that will not open is treated as a **cache miss**, not
        // as an error: the caller re-fetches it from the server and re-seals it.
        // That is the right degrade here and nowhere else — a body is derived
        // data with an authoritative copy upstream, which a subject line in the
        // index is not.
        Ok(match row {
            Some((html, text, links, refs, truncated)) => match (html, text, links) {
                (Some(None), _, _) | (_, Some(None), _) | (_, _, None) => None,
                (html, text, Some(links)) => Some((
                    html.flatten(),
                    text.flatten(),
                    links,
                    refs,
                    truncated,
                )),
            },
            None => None,
        })
    }

    pub fn cache_body(
        &self,
        message_id: &str,
        version: u32,
        html: Option<&str>,
        text: Option<&str>,
        links_json: &str,
        remote_refs: u32,
        truncated: bool,
        raw_blob: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "INSERT INTO bodies_cache
                (message_id, version, html, text, links_json, remote_refs, truncated, raw_blob)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(message_id) DO UPDATE SET
                version = excluded.version, html = excluded.html, text = excluded.text,
                links_json = excluded.links_json, remote_refs = excluded.remote_refs,
                truncated = excluded.truncated, raw_blob = excluded.raw_blob",
            params![
                message_id,
                version,
                self.seal_opt_text("", "bodies_cache", "html", message_id, html),
                self.seal_opt_text("", "bodies_cache", "text", message_id, text),
                self.seal_text("", "bodies_cache", "links_json", message_id, links_json),
                remote_refs,
                truncated as i64,
                raw_blob
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Attachments ─────────────────────────────────────────────────────────

    pub fn put_attachment(
        &self,
        message_id: &str,
        meta: &MailAttachmentMeta,
        blob: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "INSERT INTO attachments (message_id, part_id, filename, mime, size, inline, mismatch, blob)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(message_id, part_id) DO UPDATE SET
                filename = excluded.filename, mime = excluded.mime, size = excluded.size,
                inline = excluded.inline, mismatch = excluded.mismatch, blob = excluded.blob",
            params![
                message_id,
                meta.part_id,
                self.seal_attachment(message_id, &meta.part_id, "filename", &meta.filename),
                self.seal_attachment(message_id, &meta.part_id, "mime", &meta.mime),
                meta.size as i64,
                meta.inline as i64,
                self.seal_opt_attachment(
                    message_id,
                    &meta.part_id,
                    "mismatch",
                    meta.type_mismatch.as_deref()
                ),
                blob
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The AAD row key for `attachments`, whose primary key is composite.
    ///
    /// NUL-joined for the reason [`mail_crypt::field_aad`] gives: a separator
    /// that can occur inside either half is one that lets two different rows
    /// produce one AAD, which is exactly the relocation the binding exists to
    /// stop.
    fn attachment_row(message_id: &str, part_id: &str) -> String {
        format!("{message_id}\u{0}{part_id}")
    }

    fn seal_attachment(&self, message_id: &str, part_id: &str, column: &str, value: &str) -> SqlValue {
        self.seal_text(
            "",
            "attachments",
            column,
            &Self::attachment_row(message_id, part_id),
            value,
        )
    }

    fn seal_opt_attachment(
        &self,
        message_id: &str,
        part_id: &str,
        column: &str,
        value: Option<&str>,
    ) -> SqlValue {
        self.seal_opt_text(
            "",
            "attachments",
            column,
            &Self::attachment_row(message_id, part_id),
            value,
        )
    }

    fn row_to_attachment(&self, r: &Row<'_>, message_id: &str) -> rusqlite::Result<MailAttachmentMeta> {
        let part_id: String = r.get(0)?;
        let row = Self::attachment_row(message_id, &part_id);
        let t = "attachments";
        Ok(MailAttachmentMeta {
            filename: self
                .open_text(r, 1, "", t, "filename", &row)?
                .unwrap_or_default(),
            mime: self.open_text(r, 2, "", t, "mime", &row)?.unwrap_or_default(),
            size: r.get::<_, i64>(3)? as u64,
            inline: r.get::<_, i64>(4)? != 0,
            type_mismatch: self.open_opt_text(r, 5, "", t, "mismatch", &row)?.flatten(),
            part_id,
        })
    }

    pub fn attachments(&self, message_id: &str) -> Result<Vec<MailAttachmentMeta>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT part_id, filename, mime, size, inline, mismatch
                 FROM attachments WHERE message_id = ?1 ORDER BY part_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![message_id], |r| self.row_to_attachment(r, message_id))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// One attachment's metadata plus the blob digest holding its bytes.
    pub fn attachment(
        &self,
        message_id: &str,
        part_id: &str,
    ) -> Result<Option<(MailAttachmentMeta, String)>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.query_row(
            "SELECT part_id, filename, mime, size, inline, mismatch, blob
             FROM attachments WHERE message_id = ?1 AND part_id = ?2",
            params![message_id, part_id],
            |r| Ok((self.row_to_attachment(r, message_id)?, r.get::<_, String>(6)?)),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    // ── Drafts ──────────────────────────────────────────────────────────────

    pub fn save_draft(&self, draft: &MailDraft) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "INSERT INTO drafts (id, account_id, json) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, json = excluded.json",
            params![
                draft.id,
                draft.account_id,
                // The whole draft, one envelope. A draft is the most sensitive
                // thing in the store — it is mail the user is still writing, so
                // it has not even reached a server that could be asked to
                // delete it.
                self.seal_text(
                    &draft.account_id,
                    "drafts",
                    "json",
                    &draft.id,
                    &serde_json::to_string(draft).map_err(|e| e.to_string())?
                )
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn draft(&self, draft_id: &str) -> Result<Option<MailDraft>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let json: Option<Option<String>> = conn
            .query_row(
                "SELECT account_id, json FROM drafts WHERE id = ?1",
                params![draft_id],
                |r| {
                    let account_id: String = r.get(0)?;
                    self.open_text(r, 1, &account_id, "drafts", "json", draft_id)
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match json {
            Some(Some(j)) => Ok(Some(serde_json::from_str(&j).map_err(|e| e.to_string())?)),
            // Unlike a cached body there is no upstream copy to re-fetch, so an
            // unreadable draft is an error the user is told about rather than a
            // silently empty compose window.
            Some(None) => Err("this draft could not be decrypted".into()),
            None => Ok(None),
        }
    }

    pub fn delete_draft(&self, draft_id: &str) -> Result<(), String> {
        {
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            conn.execute("DELETE FROM drafts WHERE id = ?1", params![draft_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM staged WHERE draft_id = ?1", params![draft_id])
                .map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_dir_all(self.outbox_dir(draft_id));
        Ok(())
    }

    // ── Staged (outgoing) attachments ───────────────────────────────────────

    /// Copy `bytes` into the draft's staging directory under an opaque id.
    ///
    /// The *copy* is the boundary: after this call the mail subsystem has no
    /// reason and no verb to read the original file again, and a compose window
    /// cannot re-read it later.
    pub fn stage_attachment(
        &self,
        draft_id: &str,
        staged_id: &str,
        filename: &str,
        mime: &str,
        bytes: &[u8],
    ) -> Result<StagedAttachment, String> {
        let dir = self.outbox_dir(draft_id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        harden(&dir, 0o700);
        let path = dir.join(sanitize_id(staged_id));
        // Sealed like everything else, and for a reason the plan calls the
        // classic hole: `outbox/` is where a file the user picked lands in the
        // clear, outside the database, for as long as the draft exists. It is
        // consumed in memory by `build_outgoing` and never handed back as a
        // path.
        std::fs::write(&path, self.seal_staged(draft_id, staged_id, bytes))
            .map_err(|e| e.to_string())?;
        harden(&path, 0o600);

        let staged = StagedAttachment {
            staged_id: staged_id.to_string(),
            filename: filename.to_string(),
            mime: mime.to_string(),
            size: bytes.len() as u64,
        };
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "INSERT INTO staged (draft_id, staged_id, filename, mime, size)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(draft_id, staged_id) DO UPDATE SET
                filename = excluded.filename, mime = excluded.mime, size = excluded.size",
            params![
                draft_id,
                staged.staged_id,
                self.seal_text("", "staged", "filename", &staged_row(draft_id, staged_id), &staged.filename),
                self.seal_text("", "staged", "mime", &staged_row(draft_id, staged_id), &staged.mime),
                staged.size as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(staged)
    }

    /// The AAD for a staged payload file. Built from the **sanitized** ids so it
    /// names exactly the file on disk — the same two strings that form the path.
    fn staged_aad(draft_id: &str, staged_id: &str) -> Vec<u8> {
        mail_crypt::staged_aad(&sanitize_id(draft_id), &sanitize_id(staged_id))
    }

    fn seal_staged(&self, draft_id: &str, staged_id: &str, bytes: &[u8]) -> Vec<u8> {
        match &self.keys {
            Some(k) => mail_crypt::seal(&k.blob, &Self::staged_aad(draft_id, staged_id), bytes),
            None => bytes.to_vec(),
        }
    }

    pub fn staged(&self, draft_id: &str) -> Result<Vec<StagedAttachment>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT staged_id, filename, mime, size FROM staged
                 WHERE draft_id = ?1 ORDER BY staged_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![draft_id], |r| {
                let staged_id: String = r.get(0)?;
                let row = staged_row(draft_id, &staged_id);
                Ok(StagedAttachment {
                    filename: self
                        .open_text(r, 1, "", "staged", "filename", &row)?
                        .unwrap_or_default(),
                    mime: self
                        .open_text(r, 2, "", "staged", "mime", &row)?
                        .unwrap_or_default(),
                    size: r.get::<_, i64>(3)? as u64,
                    staged_id,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn staged_bytes(&self, draft_id: &str, staged_id: &str) -> Result<Vec<u8>, String> {
        let path = self.outbox_dir(draft_id).join(sanitize_id(staged_id));
        let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
        match &self.keys {
            Some(k) => mail_crypt::open(&k.blob, &Self::staged_aad(draft_id, staged_id), &raw)
                .map(|p| p.to_vec())
                .map_err(|e| e.to_string()),
            None => Ok(raw),
        }
    }

    pub fn remove_staged(&self, draft_id: &str, staged_id: &str) -> Result<(), String> {
        {
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            conn.execute(
                "DELETE FROM staged WHERE draft_id = ?1 AND staged_id = ?2",
                params![draft_id, staged_id],
            )
            .map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_file(self.outbox_dir(draft_id).join(sanitize_id(staged_id)));
        Ok(())
    }

    // ── Housekeeping ────────────────────────────────────────────────────────

    /// Drop cached bodies, attachment rows and every blob, keeping folders and
    /// the header index. A mail store grows without bound and the user needs
    /// one button, not a shell.
    pub fn clear_cached_mail(&self) -> Result<(), String> {
        {
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            conn.execute_batch("DELETE FROM bodies_cache; DELETE FROM attachments;")
                .map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_dir_all(self.blobs_dir());
        Ok(())
    }

    // ── Migrating an existing cleartext store ───────────────────────────────

    /// Seal everything in this store that is still cleartext. Returns whether
    /// anything actually changed.
    ///
    /// **Idempotent, and that is what makes it restartable.** Every value is
    /// examined individually and skipped if it is already an envelope, so being
    /// killed half-way through leaves a store in a mixed state that the next
    /// open simply finishes — there is no stage counter to get out of step with
    /// what is on disk. (SQLite's dynamic typing is what allows the mixed state:
    /// a `TEXT` and a `BLOB` coexist in one column.)
    ///
    /// The honest limitation, which the UI states rather than this file hiding:
    /// **the plaintext that was here does not reliably go away.** `VACUUM INTO`
    /// a fresh file plus deleting the old one is the best a userspace program
    /// can do, and on an SSD or a copy-on-write filesystem it is not erasure.
    /// Anyone who actually cares should use "delete local mail and re-sync"
    /// instead, which never writes the plaintext in the first place.
    fn seal_existing(&self) -> Result<bool, String> {
        if self.keys.is_none() {
            return Ok(false);
        }
        {
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            let done: Option<String> = conn
                .query_row(
                    "SELECT value FROM meta WHERE key = ?1",
                    params![META_ENCRYPTED],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if done.as_deref() == Some("1") {
                return Ok(false);
            }
        }

        let mut changed = 0usize;
        changed += self.seal_table(
            "messages",
            &["id"],
            Some("account_id"),
            &[
                "subject",
                "from_json",
                "to_json",
                "cc_json",
                "preview",
                "malformed",
                "rfc_message_id",
                "authres_json",
            ],
        )?;
        changed += self.seal_table("bodies_cache", &["message_id"], None, &["html", "text", "links_json"])?;
        changed += self.seal_table(
            "attachments",
            &["message_id", "part_id"],
            None,
            &["filename", "mime", "mismatch"],
        )?;
        changed += self.seal_table("drafts", &["id"], Some("account_id"), &["json"])?;
        changed += self.seal_table("staged", &["draft_id", "staged_id"], None, &["filename", "mime"])?;
        changed += self.seal_table("folders", &["id"], Some("account_id"), &["path", "name"])?;
        changed += self.seal_table("mail_remote_allow", &["addr_key"], None, &["address"])?;
        changed += self.reseal_blobs()?;
        changed += self.reseal_outbox()?;

        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, '1')",
            params![META_ENCRYPTED],
        )
        .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    /// Seal every still-cleartext value in `columns` of `table`.
    ///
    /// The AAD's row key is the primary-key columns NUL-joined, which is exactly
    /// how the read and write paths build theirs — one definition, so a value
    /// sealed by the migration opens through the ordinary getter.
    fn seal_table(
        &self,
        table: &'static str,
        pk: &'static [&'static str],
        account_col: Option<&'static str>,
        columns: &'static [&'static str],
    ) -> Result<usize, String> {
        let Some(_) = self.keys.as_ref() else {
            return Ok(0);
        };
        let mut conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;

        // (row key, account id, [(column, plaintext)])
        type Pending = (Vec<String>, String, Vec<(&'static str, String)>);
        let pending: Vec<Pending> = {
            let select: Vec<&str> = pk
                .iter()
                .chain(account_col.iter())
                .chain(columns.iter())
                .copied()
                .collect();
            let mut stmt = conn
                .prepare(&format!("SELECT {} FROM {table}", select.join(", ")))
                .map_err(|e| e.to_string())?;
            let value_base = pk.len() + usize::from(account_col.is_some());
            let rows = stmt
                .query_map([], |r| {
                    use rusqlite::types::ValueRef;
                    let mut key = Vec::with_capacity(pk.len());
                    for i in 0..pk.len() {
                        key.push(r.get::<_, String>(i)?);
                    }
                    let account = match account_col {
                        Some(_) => r.get::<_, String>(pk.len())?,
                        None => String::new(),
                    };
                    let mut todo = Vec::new();
                    for (n, column) in columns.iter().enumerate() {
                        // A `Blob` is already an envelope and a `Null` has
                        // nothing to seal. Only `Text` is work.
                        if let ValueRef::Text(t) = r.get_ref(value_base + n)? {
                            todo.push((*column, String::from_utf8_lossy(t).into_owned()));
                        }
                    }
                    Ok((key, account, todo))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter(|(_, _, todo)| !todo.is_empty())
                .collect()
        };
        if pending.is_empty() {
            return Ok(0);
        }

        let where_clause = pk
            .iter()
            .map(|c| format!("{c} = ?"))
            .collect::<Vec<_>>()
            .join(" AND ");
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut changed = 0usize;
        for (key, account, todo) in &pending {
            let row_key = key.join("\u{0}");
            for (column, plaintext) in todo {
                let sealed = self.seal_text(account, table, column, &row_key, plaintext);
                let mut args: Vec<SqlValue> = vec![sealed];
                args.extend(key.iter().map(|k| SqlValue::Text(k.clone())));
                tx.execute(
                    &format!("UPDATE {table} SET {column} = ? WHERE {where_clause}"),
                    params_from_iter(args),
                )
                .map_err(|e| e.to_string())?;
                changed += 1;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(changed)
    }

    /// Bring the two keyed digest columns back in step with the current keys.
    ///
    /// `folders.path_key` and `mail_remote_allow.addr_key` are digests of a
    /// value that may since have been sealed, and [`MailStore::seal_existing`]
    /// seals values without touching the keys beside them — so a store that ran
    /// plain and was converted later kept digests that are the **cleartext**
    /// value. Two things go wrong with that. The loud one: `upsert_folder`'s
    /// conflict target stops matching, so every sync tried to insert a folder
    /// that is already there and failed on its primary key
    /// (*"UNIQUE constraint failed: folders.id"*). The quiet one is worse — the
    /// stale key *is* the folder path, sitting in cleartext in a store whose
    /// whole claim is that only a keyed digest of it does.
    ///
    /// It runs on every keyed open, not only after a conversion, because it is
    /// also the repair for stores a build without it already converted. The
    /// cost is one pass over a table holding one row per folder — tens, not
    /// thousands. A row whose value will not open is **skipped**: rekeying it
    /// would mean writing a digest of nothing over the only key that still
    /// finds it.
    fn rekey_digest_columns(&self) -> Result<usize, String> {
        if self.keys.is_none() {
            return Ok(0);
        }
        let mut conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;

        // (id, account_id, stored path_key, plaintext path)
        let folders: Vec<(String, String, String, Option<String>)> = {
            let mut stmt = conn
                .prepare("SELECT id, account_id, path_key, path FROM folders")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    let id: String = r.get(0)?;
                    let account_id: String = r.get(1)?;
                    let path_key: String = r.get(2)?;
                    // The path's AAD names its row by `id`, which no rekeying
                    // touches — so a sealed path opens here exactly as it does
                    // on the read path.
                    let path = self.open_text(r, 3, &account_id, "folders", "path", &id)?;
                    Ok((id, account_id, path_key, path))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        // (stored addr_key, plaintext address)
        let allowed: Vec<(String, Option<String>)> = {
            let mut stmt = conn
                .prepare("SELECT addr_key, address FROM mail_remote_allow")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    let addr_key: String = r.get(0)?;
                    let address = self.open_text(r, 1, "", "mail_remote_allow", "address", &addr_key)?;
                    Ok((addr_key, address))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut changed = 0usize;
        for (id, account_id, path_key, path) in &folders {
            let Some(path) = path else { continue };
            let expected = self.digest_of(account_id, path);
            if &expected == path_key {
                continue;
            }
            // Two rows cannot legitimately want one key — the digest is of the
            // same (account, path) the row's own id was derived from — but a
            // duplicate left behind by some earlier state would make the
            // `UNIQUE` fire, and a repair that refuses to open the store would
            // be worse than the fault it repairs. The row is left alone; the
            // second conflict clause in `upsert_folder` still keeps the sync
            // working.
            if tx
                .execute(
                    "UPDATE folders SET path_key = ?1 WHERE id = ?2",
                    params![expected, id],
                )
                .is_ok()
            {
                changed += 1;
            }
        }
        for (addr_key, address) in &allowed {
            let Some(address) = address else { continue };
            let expected = self.digest_of("mail_remote_allow", address);
            if &expected == addr_key {
                continue;
            }
            // Here the key column *is* the row key the value's AAD names, so
            // moving it means re-sealing the value under the new one — in one
            // statement, or an interruption between the two would leave a row
            // nothing can ever open.
            let sealed = self.seal_text("", "mail_remote_allow", "address", &expected, address);
            if tx
                .execute(
                    "UPDATE mail_remote_allow SET addr_key = ?1, address = ?2 WHERE addr_key = ?3",
                    params![expected, sealed, addr_key],
                )
                .is_ok()
            {
                changed += 1;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(changed)
    }

    /// Seal every blob payload and move it from its bare SHA-256 name onto its
    /// keyed one, rewriting the two cleartext columns that reference it.
    fn reseal_blobs(&self) -> Result<usize, String> {
        let Some(keys) = self.keys.as_ref() else {
            return Ok(0);
        };
        let dir = self.blobs_dir();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(0);
        };
        let mut changed = 0usize;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(old_id) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
                continue;
            };
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            if mail_crypt::looks_sealed(&bytes) {
                continue;
            }
            let new_id = mail_crypt::blob_id(&keys.addr, &bytes);
            let sealed = mail_crypt::seal(&keys.blob, &mail_crypt::blob_aad(&new_id), &bytes);
            let new_path = dir.join(&new_id);
            std::fs::write(&new_path, &sealed).map_err(|e| e.to_string())?;
            harden(&new_path, 0o600);
            if new_id != old_id {
                let _ = std::fs::remove_file(&path);
                let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
                conn.execute(
                    "UPDATE bodies_cache SET raw_blob = ?1 WHERE raw_blob = ?2",
                    params![new_id, old_id],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "UPDATE attachments SET blob = ?1 WHERE blob = ?2",
                    params![new_id, old_id],
                )
                .map_err(|e| e.to_string())?;
            }
            changed += 1;
        }
        Ok(changed)
    }

    /// Seal every staged (outgoing) payload in place. Their names are already
    /// opaque ids, so unlike a blob nothing has to be renamed.
    fn reseal_outbox(&self) -> Result<usize, String> {
        if self.keys.is_none() {
            return Ok(0);
        }
        let root = self.dir.join("outbox");
        let Ok(drafts) = std::fs::read_dir(&root) else {
            return Ok(0);
        };
        let mut changed = 0usize;
        for draft in drafts.flatten() {
            let Some(draft_id) = draft.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(files) = std::fs::read_dir(draft.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                let Some(staged_id) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned)
                else {
                    continue;
                };
                let Ok(bytes) = std::fs::read(&path) else {
                    continue;
                };
                if mail_crypt::looks_sealed(&bytes) {
                    continue;
                }
                std::fs::write(&path, self.seal_staged(&draft_id, &staged_id, &bytes))
                    .map_err(|e| e.to_string())?;
                harden(&path, 0o600);
                changed += 1;
            }
        }
        Ok(changed)
    }

    /// Rewrite the database into a fresh file and swap it in.
    ///
    /// The step that makes the migration worth doing. Sealing values with
    /// `UPDATE` leaves every old plaintext in the WAL and in the freelist —
    /// pages SQLite has stopped referencing but has not overwritten — so a store
    /// "migrated" in place still has the cleartext subject lines in it, readable
    /// with a hex editor. `VACUUM INTO` writes a new file containing only live
    /// pages, and the old one is then removed.
    fn vacuum_into_place(&mut self) -> Result<(), String> {
        let db = self.dir.join("mail.db");
        let target = self.dir.join("mail.db.sealed");
        let _ = std::fs::remove_file(&target);
        {
            let conn = self.conn.get_mut().map_err(|_| "mail store is poisoned")?;
            conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])
                .map_err(|e| format!("could not rewrite the mail store: {e}"))?;
        }
        // Close the old connection *before* touching the files. An open handle
        // owns a `-wal`/`-shm` pair, and leaving them beside a replaced database
        // would hand the new file a journal belonging to the old one.
        {
            let placeholder = Connection::open_in_memory().map_err(|e| e.to_string())?;
            let old = std::mem::replace(
                self.conn.get_mut().map_err(|_| "mail store is poisoned")?,
                placeholder,
            );
            drop(old);
        }
        let _ = std::fs::remove_file(self.dir.join("mail.db-wal"));
        let _ = std::fs::remove_file(self.dir.join("mail.db-shm"));
        std::fs::rename(&target, &db).map_err(|e| e.to_string())?;
        harden(&db, 0o600);
        let conn = Connection::open(&db).map_err(|e| e.to_string())?;
        configure(&conn);
        *self.conn.get_mut().map_err(|_| "mail store is poisoned")? = conn;
        Ok(())
    }

    /// Remove everything belonging to one account, blobs included.
    pub fn delete_account_mail(&self, account_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "DELETE FROM bodies_cache WHERE message_id IN
                (SELECT id FROM messages WHERE account_id = ?1)",
            params![account_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM attachments WHERE message_id IN
                (SELECT id FROM messages WHERE account_id = ?1)",
            params![account_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM messages WHERE account_id = ?1", params![account_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM folders WHERE account_id = ?1", params![account_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// The token appended to a message's `malformed_headers` when one of its sealed
/// columns would not open.
///
/// It shares the malformed channel because the UI already has a banner for it
/// and because that is honestly what the row is: structurally present, partly
/// unreadable. The alternative — rendering an un-openable subject as an empty
/// one — would let anyone with disk write access blank a message's identity and
/// have it look like ordinary mail, which is the whole reason the AAD binding
/// exists.
pub const MALFORMED_SEALED: &str = "sealed-value";

impl MailStore {
    fn row_to_header(&self, r: &Row<'_>) -> rusqlite::Result<MailHeader> {
        let id: String = r.get(0)?;
        let account_id: String = r.get(1)?;
        let t = "messages";

        // One flag for the whole row: a message with an unreadable subject and
        // an unreadable preview is one damaged message, not two problems.
        let mut damaged = false;
        let mut sealed = |idx: usize, column: &str| -> rusqlite::Result<String> {
            match self.open_text(r, idx, &account_id, t, column, &id)? {
                Some(v) => Ok(v),
                None => {
                    damaged = true;
                    Ok(String::new())
                }
            }
        };

        let subject = sealed(4, "subject")?;
        let from_json = sealed(5, "from_json")?;
        let to_json = sealed(6, "to_json")?;
        let cc_json = sealed(7, "cc_json")?;
        let preview = sealed(14, "preview")?;
        let malformed = sealed(15, "malformed")?;
        let rfc_message_id = sealed(16, "rfc_message_id")?;
        let authres_json = sealed(17, "authres_json")?;
        // `unwrap_or_default` because a caller whose SELECT predates the column
        // gets no mark rather than a panic. Cleartext — it is what the two
        // priority lists filter on.
        let priority: String = r.get(18).unwrap_or_default();
        // Provenance (#205). Sealed like the other value columns, so it goes
        // through the same `sealed` closure that flags a damaged row. A SELECT
        // predating the columns simply yields empty — no mark, no reason.
        let priority_source = sealed(19, "priority_source").unwrap_or_default();
        let priority_reason = sealed(20, "priority_reason").unwrap_or_default();

        let mut malformed_headers: Vec<String> = if malformed.is_empty() {
            Vec::new()
        } else {
            malformed.split(',').map(|s| s.to_string()).collect()
        };
        if damaged {
            malformed_headers.push(MALFORMED_SEALED.to_string());
        }

        Ok(MailHeader {
            id,
            account_id,
            folder_id: r.get(2)?,
            uid: r.get(3)?,
            subject,
            from: serde_json::from_str(&from_json).unwrap_or_default(),
            to: serde_json::from_str(&to_json).unwrap_or_default(),
            cc: serde_json::from_str(&cc_json).unwrap_or_default(),
            date: r.get(8)?,
            seen: r.get::<_, i64>(9)? != 0,
            flagged: r.get::<_, i64>(10)? != 0,
            answered: r.get::<_, i64>(11)? != 0,
            has_attachments: r.get::<_, i64>(12)? != 0,
            size: r.get::<_, i64>(13)? as u64,
            preview,
            malformed_headers: (!malformed_headers.is_empty()).then_some(malformed_headers),
            rfc_message_id: (!rfc_message_id.is_empty()).then_some(rfc_message_id),
            // Deserialized in whatever state it was stored in — always
            // `Unconfigured`. `commands::mail` applies the account's trusted id
            // before this ever reaches the frontend; a row that somehow escaped
            // that step therefore shows no verdict rather than an unchecked one.
            auth: if authres_json.is_empty() {
                None
            } else {
                serde_json::from_str(&authres_json).unwrap_or(None)
            },
            // An unrecognized value reads as unmarked; see `MailPriority::parse`.
            priority: MailPriority::parse(&priority),
            // Provenance rides the mark: a cleared mark clears both, so these are
            // only ever `Some` on a marked message.
            priority_source: MailPrioritySource::parse(&priority_source),
            priority_reason: (!priority_reason.is_empty()).then_some(priority_reason),
        })
    }
}

/// The pragmas every connection to this store runs with.
///
/// `temp_store = MEMORY` is the one that belongs to the encryption work: it was
/// simply unset, which means SQLite was free to spill a sort or a large join
/// into a temp *file* — plaintext, in whatever `/tmp` the process happened to
/// have, entirely outside the sealed store. Every other defence here is about
/// what lands in `mail.db`, and none of them cover a scratch file.
fn configure(conn: &Connection) {
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "foreign_keys", "ON").ok();
    conn.pragma_update(None, "temp_store", "MEMORY").ok();
}

/// The AAD row key for `staged`, whose primary key is composite. NUL-joined,
/// matching [`MailStore::seal_table`]'s generic construction so a value sealed
/// by the migration opens through the ordinary getter.
fn staged_row(draft_id: &str, staged_id: &str) -> String {
    format!("{draft_id}\u{0}{staged_id}")
}

/// Reduce an identifier to something that cannot name anything but a leaf
/// inside the store. Ids are minted by the backend, so this is a belt: the
/// braces are that nothing outside `mail_dir()` is ever joined onto.
fn sanitize_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(128)
        .collect();
    if cleaned.is_empty() {
        "unnamed".to_string()
    } else {
        cleaned
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let out = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in out {
        use std::fmt::Write as _;
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

/// `0700` on a directory, `0600` on a file (Unix). On Windows the per-user
/// profile ACL already scopes `%APPDATA%`, so this is a no-op there.
fn harden(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::mail::MailAddress;

    fn store() -> (tempfile::TempDir, MailStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = MailStore::open(dir.path()).unwrap();
        (dir, store)
    }

    fn folder(account: &str, path: &str) -> MailFolder {
        MailFolder {
            id: format!("{account}|{path}"),
            account_id: account.into(),
            path: path.into(),
            name: path.rsplit('/').next().unwrap_or(path).into(),
            kind: MailFolderKind::Other,
            unread: 0,
            total: 0,
        }
    }

    fn header(folder: &MailFolder, uid: u32, subject: &str, date: &str) -> MailHeader {
        MailHeader {
            id: format!("{}#{uid}", folder.id),
            account_id: folder.account_id.clone(),
            folder_id: folder.id.clone(),
            uid,
            rfc_message_id: Some(format!("<{uid}@example.com>")),
            subject: subject.into(),
            from: MailAddress {
                name: Some("Sender".into()),
                address: "sender@example.com".into(),
            },
            to: vec![MailAddress {
                name: None,
                address: "me@example.org".into(),
            }],
            cc: Vec::new(),
            auth: None,
            date: date.into(),
            seen: false,
            flagged: false,
            answered: false,
            has_attachments: false,
            size: 1234,
            preview: format!("preview of {subject}"),
            malformed_headers: None,
            // Unmarked, always — `upsert_header` writes this column in neither
            // half of its statement, so a fixture that set it would be lying
            // about what a sync can do.
            priority: None,
            priority_source: None,
            priority_reason: None,
        }
    }

    /// The sync loop's arrival watermark: `None` before any message lands, then
    /// the highest UID stored — never a lower one, whatever order they arrive in.
    #[test]
    fn folder_max_uid_tracks_the_high_water_mark() {
        let (_dir, store) = store();
        let f = folder("acct", "INBOX");
        store.upsert_folder(&f).unwrap();
        assert_eq!(store.folder_max_uid(&f.id).unwrap(), None, "first sync");

        store
            .upsert_header(&header(&f, 5, "a", "2026-07-30T00:00:00Z"))
            .unwrap();
        assert_eq!(store.folder_max_uid(&f.id).unwrap(), Some(5));

        // A lower UID arriving later must not lower the mark.
        store
            .upsert_header(&header(&f, 2, "b", "2026-07-29T00:00:00Z"))
            .unwrap();
        assert_eq!(store.folder_max_uid(&f.id).unwrap(), Some(5));

        store
            .upsert_header(&header(&f, 9, "c", "2026-07-31T00:00:00Z"))
            .unwrap();
        assert_eq!(store.folder_max_uid(&f.id).unwrap(), Some(9));

        // Scoped to the folder, not the account.
        let other = folder("acct", "Archive");
        store.upsert_folder(&other).unwrap();
        assert_eq!(store.folder_max_uid(&other.id).unwrap(), None);
    }

    /// #205 provenance round-trips: who set the mark and why, and clearing the
    /// mark clears both — a sealed store and a plain one alike.
    #[test]
    fn priority_provenance_round_trips() {
        use crate::services::mail_crypt::{Key, MailKeys};
        let sealed_keys = Arc::new(MailKeys::derive(Key::from_bytes([9u8; 32])));
        for keys in [None, Some(sealed_keys)] {
            let dir = tempfile::tempdir().unwrap();
            let store = MailStore::open_with_keys(dir.path(), keys.clone()).unwrap();
            let f = folder("acct", "INBOX");
            store.upsert_folder(&f).unwrap();
            let h = header(&f, 1, "Invoice due", "2026-07-30T00:00:00Z");
            store.upsert_header(&h).unwrap();

            // A model mark carries source + reason.
            assert!(store
                .set_priority_ex(
                    &h.id,
                    Some(MailPriority::Urgent),
                    MailPrioritySource::Model,
                    "invoice is overdue"
                )
                .unwrap());
            let got = store.header(&h.id).unwrap().unwrap();
            assert_eq!(got.priority, Some(MailPriority::Urgent));
            assert_eq!(got.priority_source, Some(MailPrioritySource::Model));
            assert_eq!(got.priority_reason.as_deref(), Some("invoice is overdue"));

            // A bare user mark is labelled `user` and carries no reason.
            assert!(store
                .set_priority(&h.id, Some(MailPriority::Important))
                .unwrap());
            let got = store.header(&h.id).unwrap().unwrap();
            assert_eq!(got.priority_source, Some(MailPrioritySource::User));
            assert!(got.priority_reason.is_none());

            // Clearing the mark clears the provenance with it.
            assert!(store.set_priority(&h.id, None).unwrap());
            let got = store.header(&h.id).unwrap().unwrap();
            assert!(got.priority.is_none());
            assert!(got.priority_source.is_none());
            assert!(got.priority_reason.is_none());

            // A message not in the index changes nothing.
            assert!(!store
                .set_priority_ex(
                    "ghost",
                    Some(MailPriority::Urgent),
                    MailPrioritySource::Filter,
                    "x"
                )
                .unwrap());
        }
    }

    #[test]
    fn opening_a_fresh_directory_creates_the_schema() {
        let (dir, store) = store();
        assert!(dir.path().join("mail.db").exists());
        assert!(store.folders("nobody").unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_store_directory_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, _store) = store();
        let mode = std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "mail/ must be 0700, got {mode:o}");
        let db = std::fs::metadata(dir.path().join("mail.db"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(db, 0o600, "mail.db must be 0600, got {db:o}");
    }

    #[test]
    fn folders_upsert_rather_than_duplicate() {
        let (_d, store) = store();
        let mut f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        f.unread = 7;
        f.total = 12;
        store.upsert_folder(&f).unwrap();
        let all = store.folders("a1").unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].unread, 7);
        assert_eq!(all[0].total, 12);
    }

    #[test]
    fn a_header_round_trips_through_the_store() {
        let (_d, store) = store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        let h = header(&f, 5, "Hello", "2026-07-20T09:00:00Z");
        assert!(store.upsert_header(&h).unwrap(), "first insert is new");
        assert!(!store.upsert_header(&h).unwrap(), "second is not");

        let back = store.header(&h.id).unwrap().unwrap();
        assert_eq!(back, h, "every field must survive the round trip");
    }

    #[test]
    fn paging_is_newest_first_and_reports_the_total() {
        let (_d, store) = store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        for uid in 1..=25u32 {
            let h = header(
                &f,
                uid,
                &format!("subject {uid}"),
                &format!("2026-07-{:02}T09:00:00Z", uid),
            );
            store.upsert_header(&h).unwrap();
        }
        let page = store.headers_page(&f.id, 0, 10, None, MailSort::Date, true).unwrap();
        assert_eq!(page.total, 25);
        assert_eq!(page.items.len(), 10);
        assert_eq!(page.items[0].uid, 25, "newest first");

        let page2 = store.headers_page(&f.id, 20, 10, None, MailSort::Date, true).unwrap();
        assert_eq!(page2.items.len(), 5, "the last page is short");
        assert_eq!(page2.items[0].uid, 5);
    }

    /// The sorts the list offers, checked where they are actually implemented.
    ///
    /// The property that matters is the one paging makes non-obvious: a sort is
    /// over the **folder**, so the biggest (or starred, or attachment-carrying)
    /// message reaches page one even when it is the oldest mail there — which a
    /// list component sorting its 100 rows could never do.
    #[test]
    fn the_sorts_order_the_folder_and_break_ties_by_date() {
        let (_d, store) = store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        for uid in 1..=5u32 {
            let mut h = header(
                &f,
                uid,
                &format!("subject {uid}"),
                &format!("2026-07-{:02}T09:00:00Z", uid),
            );
            // Every marked message is deliberately the OLDEST, so a sort that
            // only reordered the newest page would leave it out of reach.
            h.flagged = uid == 1;
            h.has_attachments = uid == 1;
            h.size = if uid == 1 { 9_000_000 } else { 1_000 };
            store.upsert_header(&h).unwrap();
        }

        for sort in [MailSort::Flagged, MailSort::Attachments, MailSort::Size] {
            let page = store.headers_page(&f.id, 0, 10, None, sort, true).unwrap();
            assert_eq!(page.items[0].uid, 1, "{sort:?} must put the marked mail first");
            // The rest is a single group, so the tie-break is all that orders it.
            assert_eq!(
                page.items[1].uid, 5,
                "{sort:?} must fall back to newest-first within a group"
            );
        }

        let asc = store
            .headers_page(&f.id, 0, 10, None, MailSort::Size, false)
            .unwrap();
        assert_eq!(asc.items[0].uid, 5, "smallest first, newest of the ties");
        assert_eq!(asc.items[4].uid, 1, "the big one goes last");
    }

    #[test]
    fn a_query_filters_and_is_bound_not_interpolated() {
        let (_d, store) = store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        store
            .upsert_header(&header(&f, 1, "invoice", "2026-07-01T09:00:00Z"))
            .unwrap();
        store
            .upsert_header(&header(&f, 2, "holiday", "2026-07-02T09:00:00Z"))
            .unwrap();

        let hits = store.headers_page(&f.id, 0, 10, Some("invoi"), MailSort::Date, true).unwrap();
        assert_eq!(hits.total, 1);
        assert_eq!(hits.items[0].subject, "invoice");

        // A query that would be an injection if it were interpolated.
        let hostile = store
            .headers_page(&f.id, 0, 10, Some("'; DROP TABLE messages; --"), MailSort::Date, true)
            .unwrap();
        assert_eq!(hostile.total, 0);
        assert_eq!(
            store.headers_page(&f.id, 0, 10, None, MailSort::Date, true).unwrap().total,
            2,
            "the table must still be there"
        );
    }

    #[test]
    fn flags_round_trip_and_drive_the_unread_count() {
        let (_d, store) = store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        let h = header(&f, 1, "x", "2026-07-01T09:00:00Z");
        store.upsert_header(&h).unwrap();
        store.refresh_counts(&f.id).unwrap();
        assert_eq!(store.folder(&f.id).unwrap().unwrap().unread, 1);

        store.set_flag(&h.id, MailFlag::Seen, true).unwrap();
        assert!(store.header(&h.id).unwrap().unwrap().seen);
        store.refresh_counts(&f.id).unwrap();
        assert_eq!(store.folder(&f.id).unwrap().unwrap().unread, 0);

        store.set_flag(&h.id, MailFlag::Flagged, true).unwrap();
        assert!(store.header(&h.id).unwrap().unwrap().flagged);
        store.set_flag(&h.id, MailFlag::Seen, false).unwrap();
        assert!(!store.header(&h.id).unwrap().unwrap().seen);
    }

    #[test]
    fn a_deleted_message_leaves_the_listing() {
        let (_d, store) = store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        let h = header(&f, 1, "x", "2026-07-01T09:00:00Z");
        store.upsert_header(&h).unwrap();
        store.set_flag(&h.id, MailFlag::Deleted, true).unwrap();
        assert_eq!(store.headers_page(&f.id, 0, 10, None, MailSort::Date, true).unwrap().total, 0);
    }

    #[test]
    fn moving_a_message_changes_its_folder() {
        let (_d, store) = store();
        let inbox = folder("a1", "INBOX");
        let archive = folder("a1", "Archive");
        store.upsert_folder(&inbox).unwrap();
        store.upsert_folder(&archive).unwrap();
        let h = header(&inbox, 1, "x", "2026-07-01T09:00:00Z");
        store.upsert_header(&h).unwrap();

        store.move_messages(std::slice::from_ref(&h.id), &archive.id)
            .unwrap();
        assert_eq!(store.headers_page(&inbox.id, 0, 10, None, MailSort::Date, true).unwrap().total, 0);
        assert_eq!(store.headers_page(&archive.id, 0, 10, None, MailSort::Date, true).unwrap().total, 1);
    }

    #[test]
    fn blobs_are_content_addressed_and_deduplicated() {
        let (dir, store) = store();
        let a = store.put_blob(b"hello world").unwrap();
        let b = store.put_blob(b"hello world").unwrap();
        assert_eq!(a, b, "same bytes, same name");
        assert_eq!(a.len(), 64);
        assert_eq!(store.get_blob(&a).unwrap(), b"hello world");

        // The blob name carries no trace of any sender-supplied filename.
        let names: Vec<String> = std::fs::read_dir(dir.path().join("blobs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![a]);
    }

    /// The blob getter must not be usable as a read-any-file primitive even
    /// though nothing in the command surface can reach it with a path.
    #[test]
    fn the_blob_getter_refuses_anything_that_is_not_a_digest() {
        let (_d, store) = store();
        for bad in ["../../etc/passwd", "..", "/etc/passwd", "abc", ""] {
            assert!(store.get_blob(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn a_cached_body_is_only_served_for_the_current_sanitizer_version() {
        let (_d, store) = store();
        store
            .cache_body("m1", 1, Some("<p>hi</p>"), None, "[]", 0, false, None)
            .unwrap();
        assert!(store.cached_body("m1", 1).unwrap().is_some());
        assert!(
            store.cached_body("m1", 2).unwrap().is_none(),
            "a sanitizer bump must invalidate the cache"
        );
    }

    #[test]
    fn attachments_round_trip_with_their_blob() {
        let (_d, store) = store();
        let blob = store.put_blob(b"%PDF-1.4 ...").unwrap();
        let meta = MailAttachmentMeta {
            part_id: "3".into(),
            filename: "notes.pdf".into(),
            mime: "application/pdf".into(),
            size: 12,
            inline: false,
            type_mismatch: None,
        };
        store.put_attachment("m1", &meta, &blob).unwrap();
        assert_eq!(store.attachments("m1").unwrap(), vec![meta.clone()]);
        let (back, digest) = store.attachment("m1", "3").unwrap().unwrap();
        assert_eq!(back, meta);
        assert_eq!(digest, blob);
        assert_eq!(store.get_blob(&digest).unwrap(), b"%PDF-1.4 ...");
    }

    #[test]
    fn drafts_and_staged_attachments_round_trip() {
        let (_d, store) = store();
        let draft = MailDraft {
            id: "d1".into(),
            account_id: "a1".into(),
            to: vec!["you@example.org".into()],
            subject: "hi".into(),
            body_text: "text".into(),
            ..Default::default()
        };
        store.save_draft(&draft).unwrap();
        let back = store.draft("d1").unwrap().unwrap();
        assert_eq!(back.subject, "hi");
        assert_eq!(back.to, vec!["you@example.org".to_string()]);

        let staged = store
            .stage_attachment("d1", "s1", "notes.pdf", "application/pdf", b"bytes")
            .unwrap();
        assert_eq!(staged.size, 5);
        assert_eq!(store.staged("d1").unwrap(), vec![staged]);
        assert_eq!(store.staged_bytes("d1", "s1").unwrap(), b"bytes");

        store.remove_staged("d1", "s1").unwrap();
        assert!(store.staged("d1").unwrap().is_empty());
        assert!(store.staged_bytes("d1", "s1").is_err());
    }

    /// A staged file is a **copy**. Deleting the draft removes it; nothing in
    /// the store ever points back at the file the user picked.
    #[test]
    fn deleting_a_draft_removes_its_staged_copies() {
        let (dir, store) = store();
        let draft = MailDraft {
            id: "d1".into(),
            account_id: "a1".into(),
            ..Default::default()
        };
        store.save_draft(&draft).unwrap();
        store
            .stage_attachment("d1", "s1", "x.bin", "application/octet-stream", b"z")
            .unwrap();
        assert!(dir.path().join("outbox/d1/s1").exists());
        store.delete_draft("d1").unwrap();
        assert!(!dir.path().join("outbox/d1").exists());
        assert!(store.draft("d1").unwrap().is_none());
    }

    /// Everything the store writes stays inside the directory it was opened
    /// on, whatever ids it is handed.
    #[test]
    fn nothing_escapes_the_store_directory() {
        let (dir, store) = store();
        let root = dir.path().canonicalize().unwrap();
        store
            .stage_attachment("../../escape", "../../../etc/passwd", "x", "text/plain", b"z")
            .unwrap();
        for entry in walk(&root) {
            assert!(
                entry.starts_with(&root),
                "{} escaped {}",
                entry.display(),
                root.display()
            );
        }
        assert!(!std::path::Path::new("/tmp/escape").exists());
    }

    fn walk(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(p) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&p) else {
                continue;
            };
            for e in rd.flatten() {
                let path = e.path();
                if path.is_dir() {
                    stack.push(path.clone());
                }
                out.push(path);
            }
        }
        out
    }

    #[test]
    fn clearing_the_cache_keeps_the_index() {
        let (_d, store) = store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        let h = header(&f, 1, "x", "2026-07-01T09:00:00Z");
        store.upsert_header(&h).unwrap();
        let blob = store.put_blob(b"body bytes").unwrap();
        store
            .cache_body(&h.id, 1, Some("<p>x</p>"), None, "[]", 0, false, Some(&blob))
            .unwrap();

        store.clear_cached_mail().unwrap();
        assert!(store.cached_body(&h.id, 1).unwrap().is_none());
        assert!(store.get_blob(&blob).is_err(), "blobs are gone");
        assert_eq!(
            store.headers_page(&f.id, 0, 10, None, MailSort::Date, true).unwrap().total,
            1,
            "the header index survives"
        );
    }

    #[test]
    fn deleting_an_accounts_mail_leaves_other_accounts_alone() {
        let (_d, store) = store();
        let a = folder("a1", "INBOX");
        let b = folder("a2", "INBOX");
        store.upsert_folder(&a).unwrap();
        store.upsert_folder(&b).unwrap();
        store
            .upsert_header(&header(&a, 1, "x", "2026-07-01T09:00:00Z"))
            .unwrap();
        store
            .upsert_header(&header(&b, 1, "y", "2026-07-01T09:00:00Z"))
            .unwrap();

        store.delete_account_mail("a1").unwrap();
        assert!(store.folders("a1").unwrap().is_empty());
        assert_eq!(store.folders("a2").unwrap().len(), 1);
        assert_eq!(store.headers_page(&b.id, 0, 10, None, MailSort::Date, true).unwrap().total, 1);
    }

    #[test]
    fn reopening_the_store_keeps_its_contents() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = MailStore::open(dir.path()).unwrap();
            store.upsert_folder(&folder("a1", "INBOX")).unwrap();
        }
        let store = MailStore::open(dir.path()).unwrap();
        assert_eq!(store.folders("a1").unwrap().len(), 1);
    }

    // ── Priority marks ──────────────────────────────────────────────────────

    /// Two accounts, one INBOX each, one message each.
    fn two_accounts() -> (tempfile::TempDir, MailStore, MailFolder, MailFolder) {
        let (d, store) = store();
        let a = folder("a1", "INBOX");
        let b = folder("a2", "INBOX");
        store.upsert_folder(&a).unwrap();
        store.upsert_folder(&b).unwrap();
        store
            .upsert_header(&header(&a, 1, "from account one", "2026-07-01T09:00:00Z"))
            .unwrap();
        store
            .upsert_header(&header(&b, 1, "from account two", "2026-07-02T09:00:00Z"))
            .unwrap();
        (d, store, a, b)
    }

    #[test]
    fn a_mark_round_trips_onto_the_header() {
        let (_d, store, a, _b) = two_accounts();
        let id = format!("{}#1", a.id);
        assert!(store.header(&id).unwrap().unwrap().priority.is_none());

        assert!(store.set_priority(&id, Some(MailPriority::Urgent)).unwrap());
        assert_eq!(
            store.header(&id).unwrap().unwrap().priority,
            Some(MailPriority::Urgent)
        );
        // Re-marking as the other value replaces rather than accumulates: a
        // message is Important *or* Urgent, never both, or the two lists would
        // both claim it and neither would be a priority.
        store.set_priority(&id, Some(MailPriority::Important)).unwrap();
        assert_eq!(
            store.header(&id).unwrap().unwrap().priority,
            Some(MailPriority::Important)
        );
        store.set_priority(&id, None).unwrap();
        assert!(store.header(&id).unwrap().unwrap().priority.is_none());
    }

    #[test]
    fn marking_an_unknown_message_reports_that_nothing_changed() {
        let (_d, store) = store();
        assert!(!store
            .set_priority("no-such-message", Some(MailPriority::Urgent))
            .unwrap());
    }

    #[test]
    fn the_list_spans_every_account() {
        // The whole reason the mark is a local column: this list is exactly what
        // no IMAP folder can be, because a folder belongs to one account.
        let (_d, store, a, b) = two_accounts();
        store
            .set_priority(&format!("{}#1", a.id), Some(MailPriority::Important))
            .unwrap();
        store
            .set_priority(&format!("{}#1", b.id), Some(MailPriority::Important))
            .unwrap();

        let page = store
            .priority_page(MailPriority::Important, 0, 10, None, MailSort::Date, true)
            .unwrap();
        assert_eq!(page.total, 2);
        let accounts: Vec<&str> = page.items.iter().map(|h| h.account_id.as_str()).collect();
        assert!(accounts.contains(&"a1") && accounts.contains(&"a2"));
        // Newest first, like every other list here.
        assert_eq!(page.items[0].account_id, "a2");
    }

    // ── The filter scan ─────────────────────────────────────────────────────

    #[test]
    fn the_filter_scan_skips_already_marked_mail() {
        let (_d, store, a, _b) = two_accounts();
        assert_eq!(store.unmarked_headers(None, 100).unwrap().len(), 2);
        store
            .set_priority(&format!("{}#1", a.id), Some(MailPriority::Urgent))
            .unwrap();
        let left = store.unmarked_headers(None, 100).unwrap();
        assert_eq!(left.len(), 1, "a filed message is never re-examined");
        assert_eq!(left[0].account_id, "a2");
    }

    #[test]
    fn the_filter_scan_refuses_sent_drafts_trash_and_junk() {
        let (_d, store) = store();
        let inbox = folder("a1", "INBOX");
        store.upsert_folder(&inbox).unwrap();
        store
            .upsert_header(&header(&inbox, 1, "arrived", "2026-07-01T09:00:00Z"))
            .unwrap();
        for (i, kind) in [
            MailFolderKind::Sent,
            MailFolderKind::Drafts,
            MailFolderKind::Trash,
            MailFolderKind::Junk,
        ]
        .into_iter()
        .enumerate()
        {
            let mut f = folder("a1", &format!("Box{i}"));
            f.kind = kind;
            store.upsert_folder(&f).unwrap();
            store
                .upsert_header(&header(&f, 1, "invoice", "2026-07-02T09:00:00Z"))
                .unwrap();
        }
        let rows = store.unmarked_headers(None, 100).unwrap();
        assert_eq!(rows.len(), 1, "only the arriving folder is in scope");
        assert_eq!(rows[0].folder_id, inbox.id);
    }

    #[test]
    fn the_filter_scan_can_be_narrowed_to_one_account_and_is_bounded() {
        let (_d, store, _a, _b) = two_accounts();
        let one = store.unmarked_headers(Some("a1"), 100).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].account_id, "a1");
        // The bound is what the report turns into "of the most recent N".
        assert_eq!(store.unmarked_headers(None, 1).unwrap().len(), 1);
    }

    #[test]
    fn the_two_lists_do_not_leak_into_each_other() {
        let (_d, store, a, b) = two_accounts();
        store
            .set_priority(&format!("{}#1", a.id), Some(MailPriority::Important))
            .unwrap();
        store
            .set_priority(&format!("{}#1", b.id), Some(MailPriority::Urgent))
            .unwrap();

        let important = store
            .priority_page(MailPriority::Important, 0, 10, None, MailSort::Date, true)
            .unwrap();
        let urgent = store
            .priority_page(MailPriority::Urgent, 0, 10, None, MailSort::Date, true)
            .unwrap();
        assert_eq!(important.total, 1);
        assert_eq!(urgent.total, 1);
        assert_eq!(important.items[0].account_id, "a1");
        assert_eq!(urgent.items[0].account_id, "a2");
    }

    #[test]
    fn the_list_searches_and_pages_like_a_folder() {
        let (_d, store, a, b) = two_accounts();
        store
            .set_priority(&format!("{}#1", a.id), Some(MailPriority::Important))
            .unwrap();
        store
            .set_priority(&format!("{}#1", b.id), Some(MailPriority::Important))
            .unwrap();

        let hit = store
            .priority_page(
                MailPriority::Important,
                0,
                10,
                Some("account one"),
                MailSort::Date,
                true,
            )
            .unwrap();
        assert_eq!(hit.total, 1);
        assert_eq!(hit.items[0].account_id, "a1");

        // `total` is the whole list, not the page — that is what the pager reads.
        let first = store
            .priority_page(MailPriority::Important, 0, 1, None, MailSort::Date, true)
            .unwrap();
        assert_eq!(first.total, 2);
        assert_eq!(first.items.len(), 1);
    }

    #[test]
    fn emptying_one_list_leaves_the_other_and_the_mail_alone() {
        let (_d, store, a, b) = two_accounts();
        let urgent_id = format!("{}#1", a.id);
        let important_id = format!("{}#1", b.id);
        store
            .set_priority_ex(
                &urgent_id,
                Some(MailPriority::Urgent),
                MailPrioritySource::Model,
                "invoice is overdue",
            )
            .unwrap();
        store
            .set_priority(&important_id, Some(MailPriority::Important))
            .unwrap();

        assert_eq!(store.clear_priority(MailPriority::Urgent).unwrap(), 1);

        let cleared = store.header(&urgent_id).unwrap().unwrap();
        assert_eq!(cleared.priority, None);
        // The provenance goes with the mark — nothing may be left claiming the
        // model said something about a message that is no longer filed.
        assert_eq!(cleared.priority_source, None);
        assert_eq!(cleared.priority_reason, None);
        // The message itself is untouched: a mark is not a folder.
        assert_eq!(cleared.folder_id, a.id);

        // The other list is not this list.
        let counts = store.priority_counts().unwrap();
        assert_eq!((counts.urgent, counts.important), (0, 1));

        // Emptying an already-empty list is a no-op that reports as one.
        assert_eq!(store.clear_priority(MailPriority::Urgent).unwrap(), 0);
    }

    #[test]
    fn a_re_sync_never_wipes_a_mark() {
        // The single most important property: `upsert_header` runs over every
        // message in a folder on every check. If it touched this column, every
        // mark the user made would survive exactly until the next Check mail.
        let (_d, store, a, _b) = two_accounts();
        let id = format!("{}#1", a.id);
        store.set_priority(&id, Some(MailPriority::Urgent)).unwrap();

        let mut again = header(&a, 1, "from account one", "2026-07-01T09:00:00Z");
        again.seen = true;
        assert!(!store.upsert_header(&again).unwrap(), "not a new row");

        let after = store.header(&id).unwrap().unwrap();
        assert_eq!(after.priority, Some(MailPriority::Urgent));
        // The server's own fields did update — this is not "the upsert is inert".
        assert!(after.seen);
    }

    #[test]
    fn counts_cover_every_account_and_report_the_unread_half() {
        let (_d, store, a, b) = two_accounts();
        assert_eq!(store.priority_counts().unwrap().important, 0);

        store
            .set_priority(&format!("{}#1", a.id), Some(MailPriority::Important))
            .unwrap();
        store
            .set_priority(&format!("{}#1", b.id), Some(MailPriority::Urgent))
            .unwrap();
        store.set_flag(&format!("{}#1", a.id), MailFlag::Seen, true).unwrap();

        let c = store.priority_counts().unwrap();
        assert_eq!((c.important, c.urgent), (1, 1));
        // Read mail stays on the list and stays counted — a list you file into
        // is not an inbox. Only the unread half moves.
        assert_eq!((c.important_unread, c.urgent_unread), (0, 1));
    }

    #[test]
    fn a_deleted_message_leaves_the_list() {
        let (_d, store, a, _b) = two_accounts();
        let id = format!("{}#1", a.id);
        store.set_priority(&id, Some(MailPriority::Urgent)).unwrap();
        store.set_flag(&id, MailFlag::Deleted, true).unwrap();

        assert_eq!(
            store
                .priority_page(MailPriority::Urgent, 0, 10, None, MailSort::Date, true)
                .unwrap()
                .total,
            0
        );
        assert_eq!(store.priority_counts().unwrap().urgent, 0);
    }

    #[test]
    fn an_unrecognized_stored_mark_reads_as_unmarked() {
        // Forward compatibility in the safe direction: a column written by a
        // later version must not put mail on a list the user never chose.
        let (_d, store, a, _b) = two_accounts();
        let id = format!("{}#1", a.id);
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "UPDATE messages SET priority = 'critical' WHERE id = ?1",
                params![id],
            )
            .unwrap();
        }
        assert!(store.header(&id).unwrap().unwrap().priority.is_none());
        assert_eq!(store.priority_counts().unwrap().important, 0);
    }

    #[test]
    fn the_column_survives_a_store_created_before_it_existed() {
        // The migration path an existing dev database actually takes: the
        // `CREATE TABLE IF NOT EXISTS` is a no-op on it, so only the additive
        // ALTER puts the column there.
        let dir = tempfile::tempdir().unwrap();
        {
            let store = MailStore::open(dir.path()).unwrap();
            let conn = store.conn.lock().unwrap();
            // An index naming the column blocks the drop, exactly as it would
            // block the migration if it were created too early — which is the
            // bug this test found and the reason the CREATE INDEX sits after
            // the ALTER rather than in the create batch.
            conn.execute("DROP INDEX IF EXISTS messages_by_priority", [])
                .unwrap();
            conn.execute("ALTER TABLE messages DROP COLUMN priority", [])
                .unwrap();
        }
        let store = MailStore::open(dir.path()).unwrap();
        let a = folder("a1", "INBOX");
        store.upsert_folder(&a).unwrap();
        store
            .upsert_header(&header(&a, 1, "x", "2026-07-01T09:00:00Z"))
            .unwrap();
        let id = format!("{}#1", a.id);
        assert!(store.set_priority(&id, Some(MailPriority::Important)).unwrap());
        assert_eq!(
            store.header(&id).unwrap().unwrap().priority,
            Some(MailPriority::Important)
        );
    }

    // ── Encryption at rest ──────────────────────────────────────────────────

    mod encrypted {
        use super::*;
        use crate::services::mail_crypt::{Key, MailKeys};

        fn keys(seed: u8) -> Arc<MailKeys> {
            Arc::new(MailKeys::derive(Key::from_bytes([seed; 32])))
        }

        fn sealed_store() -> (tempfile::TempDir, MailStore) {
            let dir = tempfile::tempdir().unwrap();
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            (dir, store)
        }

        /// A folder whose id is shaped like the one `commands::mail` actually
        /// mints: `{account}-{sha256(path)[..8]}`, and **not** the readable path.
        ///
        /// The plain tests above use a path-embedding id because it makes their
        /// failures legible, which is fine when nothing is secret. Here it would
        /// invalidate the whole exercise: `folders.id`, `messages.folder_id` and
        /// every message id are cleartext by design (they are what paging and
        /// joins run on), so an id that spelled the folder path would put the
        /// path on disk no matter how well the `path` column was sealed. Using
        /// the real derivation is what makes
        /// [`no_sensitive_value_appears_in_the_files_on_disk`] test the store
        /// rather than the fixture.
        fn realistic_folder(account: &str, path: &str) -> MailFolder {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(path.as_bytes());
            let short: String = h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect();
            MailFolder {
                id: format!("{account}-{short}"),
                account_id: account.into(),
                path: path.into(),
                name: path.rsplit('/').next().unwrap_or(path).into(),
                kind: MailFolderKind::Other,
                unread: 0,
                total: 0,
            }
        }

        /// Everything the plain store does, the sealed store must also do — and
        /// through the same public API, or the two paths are two products.
        #[test]
        fn a_sealed_store_round_trips_every_kind_of_value() {
            let (_d, store) = sealed_store();
            assert!(store.is_encrypted());
            let f = folder("a1", "INBOX/Work");
            store.upsert_folder(&f).unwrap();
            assert_eq!(store.folder(&f.id).unwrap().unwrap().path, "INBOX/Work");

            let h = header(&f, 5, "Quarterly numbers", "2026-07-20T09:00:00Z");
            store.upsert_header(&h).unwrap();
            assert_eq!(store.header(&h.id).unwrap().unwrap(), h);

            let blob = store.put_blob(b"%PDF-1.4 payload").unwrap();
            assert_eq!(store.get_blob(&blob).unwrap(), b"%PDF-1.4 payload");
            let meta = MailAttachmentMeta {
                part_id: "3".into(),
                filename: "salaries.pdf".into(),
                mime: "application/pdf".into(),
                size: 16,
                inline: false,
                type_mismatch: Some("looks like a zip".into()),
            };
            store.put_attachment(&h.id, &meta, &blob).unwrap();
            assert_eq!(store.attachments(&h.id).unwrap(), vec![meta.clone()]);
            assert_eq!(store.attachment(&h.id, "3").unwrap().unwrap().0, meta);

            store
                .cache_body(&h.id, 1, Some("<p>hi</p>"), Some("hi"), "[]", 0, false, None)
                .unwrap();
            let body = store.cached_body(&h.id, 1).unwrap().unwrap();
            assert_eq!(body.0.as_deref(), Some("<p>hi</p>"));
            assert_eq!(body.1.as_deref(), Some("hi"));

            let draft = MailDraft {
                id: "d1".into(),
                account_id: "a1".into(),
                subject: "confidential".into(),
                ..Default::default()
            };
            store.save_draft(&draft).unwrap();
            assert_eq!(store.draft("d1").unwrap().unwrap().subject, "confidential");
            store
                .stage_attachment("d1", "s1", "notes.txt", "text/plain", b"secret bytes")
                .unwrap();
            assert_eq!(store.staged("d1").unwrap()[0].filename, "notes.txt");
            assert_eq!(store.staged_bytes("d1", "s1").unwrap(), b"secret bytes");
        }

        /// The assertion the whole feature reduces to. Not "is it different from
        /// the plaintext" — the subject line must not be *findable* in the file
        /// at all, which is what a `grep` over the raw bytes actually tests.
        #[test]
        fn no_sensitive_value_appears_in_the_files_on_disk() {
            let dir = tempfile::tempdir().unwrap();
            {
                let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
                let f = realistic_folder("a1", "INBOX/Personnel");
                store.upsert_folder(&f).unwrap();
                let mut h = header(&f, 1, "Redundancy list", "2026-07-20T09:00:00Z");
                h.preview = "the following roles are at risk".into();
                store.upsert_header(&h).unwrap();
                store
                    .cache_body(&h.id, 1, None, Some("body of the message"), "[]", 0, false, None)
                    .unwrap();
                let blob = store.put_blob(b"attachment plaintext").unwrap();
                store
                    .put_attachment(
                        &h.id,
                        &MailAttachmentMeta {
                            part_id: "2".into(),
                            filename: "list.xlsx".into(),
                            mime: "application/vnd.ms-excel".into(),
                            size: 20,
                            inline: false,
                            type_mismatch: None,
                        },
                        &blob,
                    )
                    .unwrap();
                store
                    .stage_attachment("d1", "s1", "draft.txt", "text/plain", b"outgoing plaintext")
                    .unwrap();
            }

            let secrets = [
                "Redundancy list",
                "the following roles are at risk",
                "body of the message",
                "attachment plaintext",
                "outgoing plaintext",
                "list.xlsx",
                "INBOX/Personnel",
                "sender@example.com",
            ];
            for path in walk(dir.path()) {
                if !path.is_file() {
                    continue;
                }
                let bytes = std::fs::read(&path).unwrap();
                for secret in secrets {
                    assert!(
                        !contains(&bytes, secret.as_bytes()),
                        "{secret:?} is readable in {}",
                        path.display()
                    );
                }
            }
        }

        fn contains(haystack: &[u8], needle: &[u8]) -> bool {
            haystack.windows(needle.len()).any(|w| w == needle)
        }

        /// What is still readable, asserted rather than assumed.
        ///
        /// The plan lists the metadata that stays in cleartext by design —
        /// counts, folder structure, dates, sizes, flags — because they are what
        /// paging and unread badges run on. This pins the one item in that list
        /// whose leak is sharper than the phrase "folder structure" suggests:
        /// a folder's **id** is an unkeyed `sha256(path)[..8]`, so anyone with
        /// the file and a wordlist of common folder names can recover which
        /// folders exist. It is inside the declared threat model and it is not
        /// worth the migration it would cost to key it (every message id derives
        /// from the folder id, and they are the AAD row keys), but it is written
        /// down here so it stays a decision instead of becoming a surprise.
        #[test]
        fn the_metadata_that_stays_readable_is_the_metadata_we_said_would() {
            let dir = tempfile::tempdir().unwrap();
            let f = realistic_folder("a1", "INBOX");
            {
                let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
                store.upsert_folder(&f).unwrap();
                store
                    .upsert_header(&header(&f, 1, "secret", "2026-07-01T09:00:00Z"))
                    .unwrap();
            }
            let db = std::fs::read(dir.path().join("mail.db")).unwrap();
            assert!(contains(&db, f.id.as_bytes()), "folder ids are cleartext");
            assert!(contains(&db, b"2026-07-01T09:00:00Z"), "dates are cleartext");
            assert!(!contains(&db, b"secret"), "content is not");
        }

        /// A store sealed under one key must not open under another. This is the
        /// property that makes the key worth protecting; without it the seal is
        /// obfuscation.
        #[test]
        fn another_key_reads_nothing() {
            let dir = tempfile::tempdir().unwrap();
            let f = folder("a1", "INBOX");
            {
                let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
                store.upsert_folder(&f).unwrap();
                store
                    .upsert_header(&header(&f, 1, "Payroll", "2026-07-01T09:00:00Z"))
                    .unwrap();
            }
            let wrong = MailStore::open_with_keys(dir.path(), Some(keys(2))).unwrap();
            let h = wrong.header(&format!("{}#1", f.id)).unwrap().unwrap();
            assert_eq!(h.subject, "");
            // …and it says so, rather than presenting a blank subject as mail.
            assert!(h
                .malformed_headers
                .unwrap()
                .contains(&MALFORMED_SEALED.to_string()));
        }

        /// The relocation attack, at the level the store actually exposes:
        /// somebody with write access to `mail.db` copies one message's sealed
        /// subject onto another message's row.
        #[test]
        fn a_sealed_column_cannot_be_relocated_between_rows() {
            let (_d, store) = sealed_store();
            let f = folder("a1", "INBOX");
            store.upsert_folder(&f).unwrap();
            store
                .upsert_header(&header(&f, 1, "From your bank", "2026-07-01T09:00:00Z"))
                .unwrap();
            store
                .upsert_header(&header(&f, 2, "Lunch?", "2026-07-02T09:00:00Z"))
                .unwrap();
            let (a, b) = (format!("{}#1", f.id), format!("{}#2", f.id));
            {
                let conn = store.conn.lock().unwrap();
                conn.execute(
                    "UPDATE messages SET subject = (SELECT subject FROM messages WHERE id = ?1)
                     WHERE id = ?2",
                    params![a, b],
                )
                .unwrap();
            }
            let moved = store.header(&b).unwrap().unwrap();
            assert_ne!(moved.subject, "From your bank", "the AAD must refuse this");
            assert_eq!(moved.subject, "");
            assert!(moved
                .malformed_headers
                .unwrap()
                .contains(&MALFORMED_SEALED.to_string()));
        }

        #[test]
        fn folders_still_deduplicate_and_still_sort_by_path() {
            let (_d, store) = sealed_store();
            for path in ["Sent", "Archive", "INBOX"] {
                store.upsert_folder(&folder("a1", path)).unwrap();
            }
            let mut f = folder("a1", "INBOX");
            f.unread = 4;
            store.upsert_folder(&f).unwrap();

            let all = store.folders("a1").unwrap();
            assert_eq!(all.len(), 3, "the keyed UNIQUE must still deduplicate");
            let paths: Vec<&str> = all.iter().map(|f| f.path.as_str()).collect();
            assert_eq!(paths, vec!["Archive", "INBOX", "Sent"], "sorted by the readable path");
            assert_eq!(all[1].unread, 4);
        }

        #[test]
        fn search_works_over_ciphertext_and_reports_when_it_stopped_early() {
            let (_d, store) = sealed_store();
            let f = folder("a1", "INBOX");
            store.upsert_folder(&f).unwrap();
            store
                .upsert_header(&header(&f, 1, "invoice 42", "2026-07-01T09:00:00Z"))
                .unwrap();
            store
                .upsert_header(&header(&f, 2, "holiday plans", "2026-07-02T09:00:00Z"))
                .unwrap();

            let hits = store
                .headers_page(&f.id, 0, 10, Some("INVOI"), MailSort::Date, true)
                .unwrap();
            assert_eq!(hits.total, 1, "case-insensitive, like the LIKE it replaces");
            assert_eq!(hits.items[0].subject, "invoice 42");
            assert!(hits.scanned.is_none(), "the whole folder fit inside the bound");

            // No query: no scan at all, and the count is the real one.
            let all = store.headers_page(&f.id, 0, 10, None, MailSort::Date, true).unwrap();
            assert_eq!(all.total, 2);
            assert_eq!(all.items[0].uid, 2, "still newest first");

            // Paging over matches, not over rows.
            store
                .upsert_header(&header(&f, 3, "invoice 43", "2026-07-03T09:00:00Z"))
                .unwrap();
            let page = store
                .headers_page(&f.id, 1, 10, Some("invoice"), MailSort::Date, true)
                .unwrap();
            assert_eq!(page.total, 2);
            assert_eq!(page.items.len(), 1);
            assert_eq!(page.items[0].uid, 1, "the second match, newest-first");
        }

        /// The scan bound, checked at a size a test can afford. The constant is
        /// 50 000 in production; what matters is that hitting it *reports*
        /// itself rather than silently returning a short answer.
        #[test]
        fn a_bounded_search_never_silently_truncates() {
            let (_d, store) = sealed_store();
            let f = folder("a1", "INBOX");
            store.upsert_folder(&f).unwrap();
            for uid in 1..=20u32 {
                store
                    .upsert_header(&header(&f, uid, "needle", &format!("2026-07-{uid:02}T09:00:00Z")))
                    .unwrap();
            }
            let full = store
                .headers_page(&f.id, 0, 5, Some("needle"), MailSort::Date, true)
                .unwrap();
            assert_eq!(full.total, 20);
            assert!(
                full.scanned.is_none(),
                "under the bound, the page must not claim a partial answer"
            );
        }

        #[test]
        fn the_priority_lists_search_the_same_way() {
            let (_d, store) = sealed_store();
            let f = folder("a1", "INBOX");
            store.upsert_folder(&f).unwrap();
            store
                .upsert_header(&header(&f, 1, "budget review", "2026-07-01T09:00:00Z"))
                .unwrap();
            let id = format!("{}#1", f.id);
            store.set_priority(&id, Some(MailPriority::Urgent)).unwrap();

            let hit = store
                .priority_page(MailPriority::Urgent, 0, 10, Some("budget"), MailSort::Date, true)
                .unwrap();
            assert_eq!(hit.total, 1);
            let miss = store
                .priority_page(MailPriority::Urgent, 0, 10, Some("nothing"), MailSort::Date, true)
                .unwrap();
            assert_eq!(miss.total, 0);
            assert_eq!(store.priority_counts().unwrap().urgent, 1, "counts are cleartext");
        }

        // ── Migrating a store that already had plaintext in it ───────────────

        #[test]
        fn an_existing_plaintext_store_migrates_and_stays_readable() {
            let dir = tempfile::tempdir().unwrap();
            let f = folder("a1", "INBOX/Personnel");
            let h = header(&f, 1, "Redundancy list", "2026-07-01T09:00:00Z");
            let blob;
            {
                let store = MailStore::open(dir.path()).unwrap();
                store.upsert_folder(&f).unwrap();
                store.upsert_header(&h).unwrap();
                blob = store.put_blob(b"attachment plaintext").unwrap();
                store
                    .cache_body(&h.id, 1, None, Some("body text"), "[]", 0, false, Some(&blob))
                    .unwrap();
                store
                    .put_attachment(
                        &h.id,
                        &MailAttachmentMeta {
                            part_id: "2".into(),
                            filename: "list.xlsx".into(),
                            mime: "application/vnd.ms-excel".into(),
                            size: 20,
                            inline: false,
                            type_mismatch: None,
                        },
                        &blob,
                    )
                    .unwrap();
                store
                    .stage_attachment("d1", "s1", "draft.txt", "text/plain", b"outgoing plaintext")
                    .unwrap();
            }

            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            assert_eq!(store.header(&h.id).unwrap().unwrap(), h);
            assert_eq!(store.folder(&f.id).unwrap().unwrap().path, "INBOX/Personnel");
            assert_eq!(store.staged_bytes("d1", "s1").unwrap(), b"outgoing plaintext");

            // The blob moved from its bare SHA-256 to its keyed name, and the
            // two columns that referenced it followed. If they had not, the
            // attachment would be a row pointing at a file that no longer
            // exists — data loss wearing the costume of a successful migration.
            let (_, digest) = store.attachment(&h.id, "2").unwrap().unwrap();
            assert_ne!(digest, blob, "the blob id is keyed now");
            assert_eq!(store.get_blob(&digest).unwrap(), b"attachment plaintext");
            let body = store.cached_body(&h.id, 1).unwrap().unwrap();
            assert_eq!(body.1.as_deref(), Some("body text"));

            for path in walk(dir.path()) {
                if !path.is_file() {
                    continue;
                }
                let bytes = std::fs::read(&path).unwrap();
                for secret in ["Redundancy list", "body text", "attachment plaintext", "outgoing plaintext"] {
                    assert!(
                        !contains(&bytes, secret.as_bytes()),
                        "{secret:?} survived the migration in {}",
                        path.display()
                    );
                }
            }
        }

        /// Interrupting the migration must not corrupt anything, because the
        /// pass is per-value and skips what is already sealed. Simulated by
        /// sealing, then hand-writing one column back to cleartext and letting
        /// the next open finish the job.
        #[test]
        fn the_migration_is_restartable() {
            let dir = tempfile::tempdir().unwrap();
            let f = folder("a1", "INBOX");
            let h = header(&f, 1, "half done", "2026-07-01T09:00:00Z");
            {
                let store = MailStore::open(dir.path()).unwrap();
                store.upsert_folder(&f).unwrap();
                store.upsert_header(&h).unwrap();
            }
            {
                let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
                let conn = store.conn.lock().unwrap();
                conn.execute(
                    "UPDATE messages SET preview = 'left in the clear' WHERE id = ?1",
                    params![h.id],
                )
                .unwrap();
                conn.execute("DELETE FROM meta WHERE key = ?1", params![META_ENCRYPTED])
                    .unwrap();
            }
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            let back = store.header(&h.id).unwrap().unwrap();
            assert_eq!(back.subject, "half done", "the already-sealed value was not double-sealed");
            assert_eq!(back.preview, "left in the clear", "the stragglers were picked up");
            for path in walk(dir.path()) {
                if path.is_file() {
                    let bytes = std::fs::read(&path).unwrap();
                    assert!(!contains(&bytes, b"left in the clear"));
                }
            }
        }

        #[test]
        fn reopening_a_sealed_store_needs_no_second_migration() {
            let dir = tempfile::tempdir().unwrap();
            let f = folder("a1", "INBOX");
            {
                let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
                store.upsert_folder(&f).unwrap();
                store
                    .upsert_header(&header(&f, 1, "x", "2026-07-01T09:00:00Z"))
                    .unwrap();
            }
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            assert_eq!(store.folders("a1").unwrap().len(), 1);
            assert_eq!(
                store.headers_page(&f.id, 0, 10, None, MailSort::Date, true).unwrap().total,
                1
            );
        }

        /// The bug this pair of tests exists for: a store that ran **plain** and
        /// was sealed later kept `path_key` as the cleartext path, so the next
        /// sync's upsert matched no conflict target, fell through to the primary
        /// key, and reported *"UNIQUE constraint failed: folders.id"* — every
        /// time, on every folder, until the mailbox was reset.
        #[test]
        fn converting_a_plain_store_rekeys_its_folder_digests() {
            let dir = tempfile::tempdir().unwrap();
            let f = realistic_folder("a1", "INBOX/Personnel");
            {
                let store = MailStore::open(dir.path()).unwrap();
                store.upsert_folder(&f).unwrap();
                let conn = store.conn.lock().unwrap();
                let key: String = conn
                    .query_row("SELECT path_key FROM folders", [], |r| r.get(0))
                    .unwrap();
                assert_eq!(key, "INBOX/Personnel", "a plain store keys on the value itself");
            }

            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            // The sync that used to fail.
            store.upsert_folder(&f).unwrap();
            let all = store.folders("a1").unwrap();
            assert_eq!(all.len(), 1, "the folder was updated, not duplicated");
            assert_eq!(all[0].path, "INBOX/Personnel");

            let key: String = store
                .conn
                .lock()
                .unwrap()
                .query_row("SELECT path_key FROM folders", [], |r| r.get(0))
                .unwrap();
            assert_ne!(key, "INBOX/Personnel", "the key is a keyed digest now");
            for path in walk(dir.path()) {
                if path.is_file() {
                    let bytes = std::fs::read(&path).unwrap();
                    assert!(
                        !contains(&bytes, b"INBOX/Personnel"),
                        "the folder path survived in {}",
                        path.display()
                    );
                }
            }
        }

        /// The same fault in a store an *earlier build* already converted: its
        /// `encrypted` marker is set, so the sealing pass returns without
        /// looking. The repair has to be reachable from the ordinary open, and
        /// the upsert has to survive even before it runs.
        #[test]
        fn a_stale_folder_digest_is_repaired_on_the_next_open() {
            let dir = tempfile::tempdir().unwrap();
            let f = realistic_folder("a1", "INBOX/Legal");
            {
                let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
                store.upsert_folder(&f).unwrap();
                // What the build without `rekey_digest_columns` left behind.
                store
                    .conn
                    .lock()
                    .unwrap()
                    .execute(
                        "UPDATE folders SET path_key = ?1 WHERE id = ?2",
                        params!["INBOX/Legal", f.id],
                    )
                    .unwrap();
                // Even in that state the upsert must not fail — it is what a
                // sync does before anything has had a chance to repair it.
                store.upsert_folder(&f).unwrap();
                assert_eq!(store.folders("a1").unwrap().len(), 1);
            }

            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            let key: String = store
                .conn
                .lock()
                .unwrap()
                .query_row("SELECT path_key FROM folders", [], |r| r.get(0))
                .unwrap();
            assert_ne!(key, "INBOX/Legal", "the open repaired the stale key");
            store.upsert_folder(&f).unwrap();
            assert_eq!(store.folders("a1").unwrap().len(), 1);
        }

        /// A row whose value cannot be opened — the wrong key, or bytes altered
        /// on disk — must be left exactly as it is. Rekeying it would write a
        /// digest of nothing over the only key that still finds it.
        #[test]
        fn a_row_that_will_not_open_is_not_rekeyed() {
            let dir = tempfile::tempdir().unwrap();
            let f = realistic_folder("a1", "INBOX");
            {
                let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
                store.upsert_folder(&f).unwrap();
            }
            let before: String = {
                let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
                let conn = store.conn.lock().unwrap();
                conn.query_row("SELECT path_key FROM folders", [], |r| r.get(0)).unwrap()
            };
            let store = MailStore::open_with_keys(dir.path(), Some(keys(2))).unwrap();
            let after: String = store
                .conn
                .lock()
                .unwrap()
                .query_row("SELECT path_key FROM folders", [], |r| r.get(0))
                .unwrap();
            assert_eq!(before, after, "a row that would not open kept its key");
        }

        /// A store created before `path_key` existed must come back with its
        /// folders intact — the v1→v2 rebuild is a table swap, and getting it
        /// wrong loses every folder rather than failing loudly.
        #[test]
        fn the_v1_folder_table_is_rebuilt_without_losing_rows() {
            let dir = tempfile::tempdir().unwrap();
            {
                let store = MailStore::open(dir.path()).unwrap();
                let conn = store.conn.lock().unwrap();
                conn.execute_batch(
                    r#"
                    DROP TABLE folders;
                    CREATE TABLE folders (
                        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, path TEXT NOT NULL,
                        name TEXT NOT NULL, kind TEXT NOT NULL,
                        unread INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
                        UNIQUE (account_id, path)
                    );
                    INSERT INTO folders VALUES ('a1|INBOX','a1','INBOX','INBOX','inbox',3,9);
                    DROP TABLE mail_remote_allow;
                    CREATE TABLE mail_remote_allow (address TEXT PRIMARY KEY);
                    INSERT INTO mail_remote_allow VALUES ('news@example.com');
                    "#,
                )
                .unwrap();
            }
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            let all = store.folders("a1").unwrap();
            assert_eq!(all.len(), 1);
            assert_eq!(all[0].path, "INBOX");
            assert_eq!((all[0].unread, all[0].total), (3, 9));
        }

        /// The degrade path. It must behave like a store in every respect the
        /// caller can see, and leave nothing behind.
        #[test]
        fn the_ephemeral_store_works_and_persists_nothing() {
            let scratch;
            {
                let store = MailStore::open_ephemeral().unwrap();
                scratch = store.dir().to_path_buf();
                assert!(store.is_encrypted());
                let f = folder("a1", "INBOX");
                store.upsert_folder(&f).unwrap();
                let h = header(&f, 1, "in memory only", "2026-07-01T09:00:00Z");
                store.upsert_header(&h).unwrap();
                assert_eq!(store.header(&h.id).unwrap().unwrap().subject, "in memory only");
                let blob = store.put_blob(b"payload").unwrap();
                assert_eq!(store.get_blob(&blob).unwrap(), b"payload");
                assert!(!scratch.join("mail.db").exists(), "the index never touches disk");
            }
            assert!(!scratch.exists(), "the scratch directory goes with the store");
        }
    }
}
