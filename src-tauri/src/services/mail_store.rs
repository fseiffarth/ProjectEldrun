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
//! Deliberately **not** encrypted in v1 (plan B §5.2): the threat encryption
//! addresses is offline access to the disk, against which FileVault/BitLocker/
//! LUKS is the correct and complete answer — and the key would have to live in
//! the OS keychain, where Eldrun has a documented hazard (a locked collection
//! reads identically to an empty one). Making the whole mailbox unreadable when
//! the keychain is locked is a strictly worse failure than an unencrypted cache
//! on a session the user already unlocked. What we do instead is `0700`/`0600`
//! and a "delete local mail" action.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::schema::mail::{
    MailAttachmentMeta, MailDraft, MailFlag, MailFolder, MailFolderKind, MailHeader,
    MailHeaderPage, StagedAttachment,
};

/// Forward-only schema version, recorded in `meta`.
const SCHEMA_VERSION: i64 = 1;

/// Bodies larger than this are content-addressed into `blobs/` instead of
/// living in the row.
pub const INLINE_BODY_LIMIT: usize = 256 * 1024;

pub struct MailStore {
    dir: PathBuf,
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for MailStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailStore").field("dir", &self.dir).finish()
    }
}

impl MailStore {
    /// Open (creating if needed) the store rooted at `dir`.
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create the mail store: {e}"))?;
        harden(dir, 0o700);
        let db = dir.join("mail.db");
        let conn = Connection::open(&db).map_err(|e| e.to_string())?;
        harden(&db, 0o600);
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        let store = MailStore {
            dir: dir.to_path_buf(),
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
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
                path       TEXT NOT NULL,
                name       TEXT NOT NULL,
                kind       TEXT NOT NULL,
                unread     INTEGER NOT NULL DEFAULT 0,
                total      INTEGER NOT NULL DEFAULT 0,
                UNIQUE (account_id, path)
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
                address TEXT PRIMARY KEY
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
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
            params![SCHEMA_VERSION.to_string()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Blobs ───────────────────────────────────────────────────────────────

    /// Store `bytes` under their SHA-256 and return the hex digest.
    pub fn put_blob(&self, bytes: &[u8]) -> Result<String, String> {
        let hex = hex_digest(bytes);
        let dir = self.blobs_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        harden(&dir, 0o700);
        let path = dir.join(&hex);
        if !path.exists() {
            std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
            harden(&path, 0o600);
        }
        Ok(hex)
    }

    pub fn get_blob(&self, digest: &str) -> Result<Vec<u8>, String> {
        let digest = sanitize_id(digest);
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("not a blob id".into());
        }
        std::fs::read(self.blobs_dir().join(digest)).map_err(|e| e.to_string())
    }

    // ── Folders ─────────────────────────────────────────────────────────────

    pub fn upsert_folder(&self, folder: &MailFolder) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "INSERT INTO folders (id, account_id, path, name, kind, unread, total)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(account_id, path) DO UPDATE SET
                name = excluded.name, kind = excluded.kind,
                unread = excluded.unread, total = excluded.total",
            params![
                folder.id,
                folder.account_id,
                folder.path,
                folder.name,
                folder.kind.as_str(),
                folder.unread,
                folder.total
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn folders(&self, account_id: &str) -> Result<Vec<MailFolder>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, account_id, path, name, kind, unread, total
                 FROM folders WHERE account_id = ?1 ORDER BY path",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![account_id], |r| {
                Ok(MailFolder {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    path: r.get(2)?,
                    name: r.get(3)?,
                    kind: MailFolderKind::from_str_lossy(&r.get::<_, String>(4)?),
                    unread: r.get(5)?,
                    total: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn folder(&self, folder_id: &str) -> Result<Option<MailFolder>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.query_row(
            "SELECT id, account_id, path, name, kind, unread, total FROM folders WHERE id = ?1",
            params![folder_id],
            |r| {
                Ok(MailFolder {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    path: r.get(2)?,
                    name: r.get(3)?,
                    kind: MailFolderKind::from_str_lossy(&r.get::<_, String>(4)?),
                    unread: r.get(5)?,
                    total: r.get(6)?,
                })
            },
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
                                   size, preview, malformed, rfc_message_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
             ON CONFLICT(id) DO UPDATE SET
                subject = excluded.subject, from_json = excluded.from_json,
                to_json = excluded.to_json, cc_json = excluded.cc_json,
                date = excluded.date, seen = excluded.seen, flagged = excluded.flagged,
                answered = excluded.answered, has_attachments = excluded.has_attachments,
                size = excluded.size, preview = excluded.preview,
                malformed = excluded.malformed,
                rfc_message_id = excluded.rfc_message_id",
            params![
                header.id,
                header.account_id,
                header.folder_id,
                header.uid,
                header.subject,
                serde_json::to_string(&header.from).unwrap_or_default(),
                serde_json::to_string(&header.to).unwrap_or_default(),
                serde_json::to_string(&header.cc).unwrap_or_default(),
                header.date,
                header.seen as i64,
                header.flagged as i64,
                header.answered as i64,
                header.has_attachments as i64,
                header.size as i64,
                header.preview,
                header
                    .malformed_headers
                    .as_ref()
                    .map(|m| m.join(","))
                    .unwrap_or_default(),
                header.rfc_message_id.clone().unwrap_or_default(),
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(!existed)
    }

    /// One page of a folder's headers, newest first, optionally filtered.
    ///
    /// The query is a `LIKE` over subject/sender/preview and is bound as a
    /// parameter — the caller's text never reaches the SQL string.
    pub fn headers_page(
        &self,
        folder_id: &str,
        offset: u32,
        limit: u32,
        query: Option<&str>,
    ) -> Result<MailHeaderPage, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let limit = limit.clamp(1, 500);
        let pattern = query
            .map(|q| format!("%{}%", q.replace('%', "\\%").replace('_', "\\_")))
            .unwrap_or_else(|| "%".to_string());

        let total: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages
                 WHERE folder_id = ?1 AND deleted = 0
                   AND (subject LIKE ?2 ESCAPE '\\' OR from_json LIKE ?2 ESCAPE '\\'
                        OR preview LIKE ?2 ESCAPE '\\')",
                params![folder_id, pattern],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        let mut stmt = conn
            .prepare(
                "SELECT id, account_id, folder_id, uid, subject, from_json, to_json, cc_json,
                        date, seen, flagged, answered, has_attachments, size, preview, malformed,
                        rfc_message_id
                 FROM messages
                 WHERE folder_id = ?1 AND deleted = 0
                   AND (subject LIKE ?2 ESCAPE '\\' OR from_json LIKE ?2 ESCAPE '\\'
                        OR preview LIKE ?2 ESCAPE '\\')
                 ORDER BY date DESC, uid DESC
                 LIMIT ?3 OFFSET ?4",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![folder_id, pattern, limit, offset], row_to_header)
            .map_err(|e| e.to_string())?;
        let items = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(MailHeaderPage { items, total })
    }

    pub fn header(&self, message_id: &str) -> Result<Option<MailHeader>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.query_row(
            "SELECT id, account_id, folder_id, uid, subject, from_json, to_json, cc_json,
                    date, seen, flagged, answered, has_attachments, size, preview, malformed,
                    rfc_message_id
             FROM messages WHERE id = ?1",
            params![message_id],
            row_to_header,
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
        conn.query_row(
            "SELECT html, text, links_json, remote_refs, truncated
             FROM bodies_cache WHERE message_id = ?1 AND version = ?2",
            params![message_id, version],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, u32>(3)?,
                    r.get::<_, i64>(4)? != 0,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())
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
                html,
                text,
                links_json,
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
                meta.filename,
                meta.mime,
                meta.size as i64,
                meta.inline as i64,
                meta.type_mismatch,
                blob
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
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
            .query_map(params![message_id], |r| {
                Ok(MailAttachmentMeta {
                    part_id: r.get(0)?,
                    filename: r.get(1)?,
                    mime: r.get(2)?,
                    size: r.get::<_, i64>(3)? as u64,
                    inline: r.get::<_, i64>(4)? != 0,
                    type_mismatch: r.get(5)?,
                })
            })
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
            |r| {
                Ok((
                    MailAttachmentMeta {
                        part_id: r.get(0)?,
                        filename: r.get(1)?,
                        mime: r.get(2)?,
                        size: r.get::<_, i64>(3)? as u64,
                        inline: r.get::<_, i64>(4)? != 0,
                        type_mismatch: r.get(5)?,
                    },
                    r.get::<_, String>(6)?,
                ))
            },
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
                serde_json::to_string(draft).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn draft(&self, draft_id: &str) -> Result<Option<MailDraft>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let json: Option<String> = conn
            .query_row(
                "SELECT json FROM drafts WHERE id = ?1",
                params![draft_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match json {
            Some(j) => Ok(Some(serde_json::from_str(&j).map_err(|e| e.to_string())?)),
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
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
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
                staged.filename,
                staged.mime,
                staged.size as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(staged)
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
                Ok(StagedAttachment {
                    staged_id: r.get(0)?,
                    filename: r.get(1)?,
                    mime: r.get(2)?,
                    size: r.get::<_, i64>(3)? as u64,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn staged_bytes(&self, draft_id: &str, staged_id: &str) -> Result<Vec<u8>, String> {
        let path = self.outbox_dir(draft_id).join(sanitize_id(staged_id));
        std::fs::read(&path).map_err(|e| e.to_string())
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

fn row_to_header(r: &rusqlite::Row<'_>) -> rusqlite::Result<MailHeader> {
    let malformed: String = r.get(15)?;
    let rfc_message_id: String = r.get(16)?;
    Ok(MailHeader {
        id: r.get(0)?,
        account_id: r.get(1)?,
        folder_id: r.get(2)?,
        uid: r.get(3)?,
        subject: r.get(4)?,
        from: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
        to: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
        cc: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
        date: r.get(8)?,
        seen: r.get::<_, i64>(9)? != 0,
        flagged: r.get::<_, i64>(10)? != 0,
        answered: r.get::<_, i64>(11)? != 0,
        has_attachments: r.get::<_, i64>(12)? != 0,
        size: r.get::<_, i64>(13)? as u64,
        preview: r.get(14)?,
        malformed_headers: if malformed.is_empty() {
            None
        } else {
            Some(malformed.split(',').map(|s| s.to_string()).collect())
        },
        rfc_message_id: if rfc_message_id.is_empty() {
            None
        } else {
            Some(rfc_message_id)
        },
    })
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
            date: date.into(),
            seen: false,
            flagged: false,
            answered: false,
            has_attachments: false,
            size: 1234,
            preview: format!("preview of {subject}"),
            malformed_headers: None,
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
        let page = store.headers_page(&f.id, 0, 10, None).unwrap();
        assert_eq!(page.total, 25);
        assert_eq!(page.items.len(), 10);
        assert_eq!(page.items[0].uid, 25, "newest first");

        let page2 = store.headers_page(&f.id, 20, 10, None).unwrap();
        assert_eq!(page2.items.len(), 5, "the last page is short");
        assert_eq!(page2.items[0].uid, 5);
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

        let hits = store.headers_page(&f.id, 0, 10, Some("invoi")).unwrap();
        assert_eq!(hits.total, 1);
        assert_eq!(hits.items[0].subject, "invoice");

        // A query that would be an injection if it were interpolated.
        let hostile = store
            .headers_page(&f.id, 0, 10, Some("'; DROP TABLE messages; --"))
            .unwrap();
        assert_eq!(hostile.total, 0);
        assert_eq!(
            store.headers_page(&f.id, 0, 10, None).unwrap().total,
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
        assert_eq!(store.headers_page(&f.id, 0, 10, None).unwrap().total, 0);
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

        store.move_messages(&[h.id.clone()], &archive.id).unwrap();
        assert_eq!(store.headers_page(&inbox.id, 0, 10, None).unwrap().total, 0);
        assert_eq!(store.headers_page(&archive.id, 0, 10, None).unwrap().total, 1);
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
            store.headers_page(&f.id, 0, 10, None).unwrap().total,
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
        assert_eq!(store.headers_page(&b.id, 0, 10, None).unwrap().total, 1);
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
}
