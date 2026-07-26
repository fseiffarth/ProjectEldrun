//! Tauri surface for the embedded mail client.
//!
//! # Two rules govern every line of this file
//!
//! **1. Every `mail_*` command is `pub async fn`, with all blocking work inside
//! `spawn_blocking` or genuinely async I/O.** A synchronous `#[tauri::command]`
//! body runs on the main thread and freezes the whole WebView. That has bitten
//! this project twice and both fixes are in-tree: `commands::tex::compile_tex`
//! ("a sync command runs on the main thread, so every Recompile used to freeze
//! the whole webview for up to the 600 s run timeout") and the remote side,
//! where SFTP/git probes on a dead SSH session froze the window so hard that
//! the frontend carries a permanent gate for it
//! (`src/components/files/ProjectFilesPane.tsx`'s `useRemoteBlocked`). Mail
//! network I/O is worse than either — an unreachable IMAP server hangs for the
//! whole TCP timeout. `mail_accounts_list` is async too, not because it needs
//! to be today but because a sync command is a landmine the day it grows a
//! keyring read.
//!
//! **2. No `mail_*` command takes a filesystem path, glob or directory.** That
//! is the whole statement of the sandbox boundary. Everything the mail
//! subsystem reads or writes resolves under [`mail_dir`], internally, never
//! from the frontend. Files cross only through [`mail_attach_pick`] and
//! [`mail_attachment_save`], both of which raise the **OS dialog inside Rust**
//! (via `tauri_plugin_dialog`'s `DialogExt`, bridged to a `oneshot` — never
//! `blocking_pick_*`, which would be rule 1 all over again). Consequence worth
//! stating: an attacker who fully controls a message's bytes, its HTML, and any
//! script that somehow escaped the render iframe still has no reachable IPC verb
//! that names a path — there is nothing to path-traverse, because there is no
//! path argument to traverse. `no_command_takes_a_path` in this file's tests
//! enforces that mechanically.
//!
//! Deliberately absent, each of which would be an ambient hole: no "open
//! attachment with the system app" (arbitrary-file-write plus exec), no
//! attachment drag-out, no "save all attachments" into a directory, no writing
//! anything into the active project's tree.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::projects::uuid_v4;
use crate::schema::mail::{
    MailAccount, MailAccountSaved, MailAccounts, MailBody, MailDraft, MailFlag, MailFolder,
    MailHeaderPage, MailKeyringState, MailLink, MailPasswordState, MailPreviewBlob, MailProbe,
    MailSendResult, MailSyncEvent, MailSyncSummary, StagedAttachment, ACCOUNTS_VERSION,
};
use crate::services::mail_engine::{
    self, InProcessEngine, MailEngine, OutboundAttachment, Password,
};
use crate::services::mail_sanitize::{self, SANITIZER_VERSION};
use crate::services::mail_store::MailStore;
use crate::services::remote_credentials::{self, KeyringState, MailProto};
use crate::storage;

// ── Where everything lives ──────────────────────────────────────────────────

/// The one directory the mail subsystem may touch. Machine-level, beside
/// `calendar.json` and the VPN configs — never inside a project, because mail
/// has no project and a project's tree is a git working copy.
pub fn mail_dir() -> PathBuf {
    storage::state_dir().join("mail")
}

fn accounts_path() -> PathBuf {
    mail_dir().join("accounts.json")
}

/// How many headers one sync pulls per folder. Bounded because "sync" on a
/// 200 000-message archive folder is otherwise an unbounded fetch.
const SYNC_HEADER_LIMIT: u32 = 200;

/// Largest attachment handed to the in-pane previewer over IPC.
const MAX_PREVIEW_BYTES: usize = 4 * 1024 * 1024;

/// Largest single file the user may attach to a draft.
const MAX_STAGED_BYTES: u64 = 20 * 1024 * 1024;

// ── Managed state ───────────────────────────────────────────────────────────

/// Session state: the lazily-opened store, the **in-memory only** passwords for
/// accounts the user chose not to persist, and the per-account cancel flags.
///
/// The password map is the analogue of the remote side's session password
/// stash: nothing here is ever serialized, and it dies with the process. That
/// is what "not persisted by default" means operationally.
#[derive(Default)]
pub struct MailRuntime {
    store: Option<Arc<MailStore>>,
    passwords: HashMap<String, Password>,
    cancel: HashMap<String, Arc<AtomicBool>>,
}

pub type MailState = Arc<Mutex<MailRuntime>>;

pub fn new_state() -> MailState {
    Arc::new(Mutex::new(MailRuntime::default()))
}

/// Get (opening on first use) the store handle. Runs on the caller's thread, so
/// every command reaches it from inside `spawn_blocking` or after one.
fn store_of(state: &MailState) -> Result<Arc<MailStore>, String> {
    let mut rt = state.lock().map_err(|_| "mail state is poisoned")?;
    if let Some(store) = &rt.store {
        return Ok(store.clone());
    }
    let store = Arc::new(MailStore::open(&mail_dir())?);
    rt.store = Some(store.clone());
    Ok(store)
}

// ── accounts.json ───────────────────────────────────────────────────────────

/// Read the account list. A missing file is an empty list, not an error.
fn read_accounts(path: &Path) -> Result<MailAccounts, String> {
    if !path.exists() {
        return Ok(MailAccounts {
            version: ACCOUNTS_VERSION,
            ..Default::default()
        });
    }
    storage::read_json(path).map_err(|e| e.to_string())
}

fn write_accounts(path: &Path, data: &MailAccounts) -> Result<(), String> {
    storage::write_json_atomic(path, data).map_err(|e| e.to_string())
}

/// Insert or replace one account, minting an id when the caller has none.
/// The store owns identity, exactly as `commands::calendar` does.
fn upsert_account_at(path: &Path, mut account: MailAccount) -> Result<MailAccount, String> {
    let mut data = read_accounts(path)?;
    data.version = ACCOUNTS_VERSION;
    if account.id.trim().is_empty() {
        account.id = uuid_v4();
    }
    match data.accounts.iter_mut().find(|a| a.id == account.id) {
        Some(slot) => *slot = account.clone(),
        None => data.accounts.push(account.clone()),
    }
    write_accounts(path, &data)?;
    Ok(account)
}

fn delete_account_at(path: &Path, id: &str) -> Result<(), String> {
    let mut data = read_accounts(path)?;
    let before = data.accounts.len();
    data.accounts.retain(|a| a.id != id);
    if data.accounts.len() == before {
        return Err(format!("mail account '{id}' not found"));
    }
    write_accounts(path, &data)
}

fn account_by_id(path: &Path, id: &str) -> Result<MailAccount, String> {
    read_accounts(path)?
        .accounts
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("mail account '{id}' not found"))
}

// ── Identity ────────────────────────────────────────────────────────────────

/// A stable, opaque folder id. Derived rather than stored so a re-listed folder
/// keeps the id its messages already reference.
fn folder_id_for(account_id: &str, folder_path: &str) -> String {
    format!("{account_id}-{}", short_hash(folder_path))
}

fn message_id_for(folder_id: &str, uid: u32) -> String {
    format!("{folder_id}-{uid}")
}

fn short_hash(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let out = h.finalize();
    out.iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

// ── Credentials ─────────────────────────────────────────────────────────────

fn imap_key(account: &MailAccount) -> String {
    remote_credentials::mail_account(
        MailProto::Imap,
        &account.imap.user,
        &account.imap.host,
        account.imap.port,
    )
}

fn smtp_key(account: &MailAccount) -> String {
    remote_credentials::mail_account(
        MailProto::Smtp,
        &account.smtp.user,
        &account.smtp.host,
        account.smtp.port,
    )
}

/// The password to authenticate `account` with, session map first, keychain
/// second.
///
/// The keychain read goes through `remote_credentials::get`, which is bounded
/// at 4 s by `read_timed` **and** asks `cached_keyring_state()` before
/// dispatching — so a locked collection is never dispatched to. That is the
/// whole locked-keyring lesson: a locked collection reads identically to an
/// empty one, and the reads used to *hang*. Mail inherits that rather than
/// reinventing it.
fn resolve_password(state: &MailState, account: &MailAccount, proto: MailProto) -> Option<Password> {
    if let Ok(rt) = state.lock() {
        if let Some(pw) = rt.passwords.get(&account.id) {
            if !pw.is_empty() {
                return Some(pw.clone());
            }
        }
    }
    let key = match proto {
        MailProto::Imap => imap_key(account),
        MailProto::Smtp => smtp_key(account),
    };
    remote_credentials::get(&key).map(Password::new)
}

fn keyring_state_for_ui() -> MailKeyringState {
    match remote_credentials::keyring_state() {
        KeyringState::Unlocked => MailKeyringState::Available,
        KeyringState::Locked => MailKeyringState::Locked,
        KeyringState::Unavailable => MailKeyringState::Unavailable,
    }
}

/// `Some(false)` is coerced to `None`.
///
/// This closes exactly the bug documented in
/// `docs/context/remote_credentials.md` §"A connect must never be able to
/// forget": a checkbox seeded by an async keyring read, clicked before the read
/// lands, sends `false` and deletes the password it just authenticated with.
/// Clearing a saved mail password is only ever [`mail_forget_password`], which
/// is an explicit user action with its own verb.
fn remember_arg(remember: Option<bool>) -> Option<bool> {
    remember.filter(|v| *v)
}

// ── Commands: accounts ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn mail_accounts_list() -> Result<Vec<MailAccount>, String> {
    tokio::task::spawn_blocking(|| Ok(read_accounts(&accounts_path())?.accounts))
        .await
        .map_err(|e| e.to_string())?
}

/// Create or update an account, and apply the opt-in keychain write.
///
/// Returns what the keychain *actually did* rather than a bare account: a write
/// that silently failed is how a user loses a password they think is saved, so
/// `remember_secret`'s `{ saved, error }` is passed straight through.
#[tauri::command]
pub async fn mail_account_upsert(
    account: MailAccount,
    password: Option<String>,
    remember: Option<bool>,
    state: State<'_, MailState>,
) -> Result<MailAccountSaved, String> {
    let rt = state.inner().clone();
    let remember = remember_arg(remember);
    tokio::task::spawn_blocking(move || {
        let mut account = upsert_account_at(&accounts_path(), account)?;

        // An empty password field means "use whatever is already there", never
        // "authenticate with nothing".
        let secret = password.filter(|p| !p.is_empty());
        if let Some(secret) = &secret {
            if let Ok(mut guard) = rt.lock() {
                guard
                    .passwords
                    .insert(account.id.clone(), Password::new(secret.clone()));
            }
        }

        let mut saved = false;
        let mut error: Option<String> = None;
        if remember == Some(true) {
            for key in [imap_key(&account), smtp_key(&account)] {
                let outcome =
                    remote_credentials::remember_secret(&key, remember, secret.as_deref());
                saved |= outcome.saved;
                if error.is_none() {
                    error = outcome.error;
                }
            }
        }

        // `save_password` records what the user asked for and what landed —
        // never a hopeful `true` over a refused write.
        if account.save_password != saved && remember == Some(true) {
            account.save_password = saved;
            account = upsert_account_at(&accounts_path(), account)?;
        }

        Ok(MailAccountSaved {
            account,
            saved,
            save_error: error,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mail_account_delete(
    account_id: String,
    state: State<'_, MailState>,
) -> Result<(), String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        // The local mail goes with the account; the keychain entry does not.
        // It is keyed by *server target*, so another account (or another app's
        // saved login for the same mailbox) may still be using it — deleting a
        // shared secret on a local cleanup is the destructive-by-surprise move
        // `remember_secret` exists to prevent. "Forget saved password" is the
        // verb for that, and it is a click of its own.
        if let Ok(store) = store_of(&rt) {
            let _ = store.delete_account_mail(&account_id);
        }
        if let Ok(mut guard) = rt.lock() {
            guard.passwords.remove(&account_id);
            guard.cancel.remove(&account_id);
        }
        delete_account_at(&accounts_path(), &account_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Try both endpoints once and report each. Never retries: one attempt per user
/// action, because a retry loop against a provider's lockout policy is how
/// accounts get locked.
#[tauri::command]
pub async fn mail_account_test(
    account: MailAccount,
    password: Option<String>,
    state: State<'_, MailState>,
) -> Result<MailProbe, String> {
    let rt = state.inner().clone();
    let secret = match password.filter(|p| !p.is_empty()) {
        Some(p) => Some(Password::new(p)),
        None => resolve_password(&rt, &account, MailProto::Imap),
    };
    let Some(secret) = secret else {
        return Ok(MailProbe {
            imap_ok: false,
            smtp_ok: false,
            error: Some(
                "no password available for this account — type one, or unlock the OS keyring"
                    .into(),
            ),
        });
    };
    Ok(InProcessEngine.probe(&account, &secret).await)
}

#[tauri::command]
pub async fn mail_password_state(account_id: String) -> Result<MailPasswordState, String> {
    tokio::task::spawn_blocking(move || {
        let account = account_by_id(&accounts_path(), &account_id)?;
        let keyring = keyring_state_for_ui();
        // A locked keyring must read as "locked", never as "nothing saved" —
        // the UI shows an Unlock button rather than a silently empty checkbox.
        let has_saved = match keyring {
            MailKeyringState::Available => remote_credentials::has(&imap_key(&account)),
            _ => false,
        };
        Ok(MailPasswordState { has_saved, keyring })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The **only** path that deletes a saved mail password.
#[tauri::command]
pub async fn mail_forget_password(
    account_id: String,
    state: State<'_, MailState>,
) -> Result<(), String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let account = account_by_id(&accounts_path(), &account_id)?;
        // `remember_secret(Some(false), …)` refuses to clear an entry it could
        // not first read, so a locked keyring cannot destroy a password the
        // user still wants.
        let mut error = None;
        for key in [imap_key(&account), smtp_key(&account)] {
            let outcome = remote_credentials::remember_secret(&key, Some(false), None);
            if error.is_none() {
                error = outcome.error;
            }
        }
        if let Ok(mut guard) = rt.lock() {
            guard.passwords.remove(&account_id);
        }
        let mut account = account;
        account.save_password = false;
        upsert_account_at(&accounts_path(), account)?;
        match error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Commands: folders, sync, headers ────────────────────────────────────────

#[tauri::command]
pub async fn mail_folders(
    account_id: String,
    refresh: bool,
    state: State<'_, MailState>,
) -> Result<Vec<MailFolder>, String> {
    let rt = state.inner().clone();
    let (account, store) = {
        let rt2 = rt.clone();
        let id = account_id.clone();
        tokio::task::spawn_blocking(move || {
            let account = account_by_id(&accounts_path(), &id)?;
            let store = store_of(&rt2)?;
            Ok::<_, String>((account, store))
        })
        .await
        .map_err(|e| e.to_string())??
    };

    if !refresh {
        let store2 = store.clone();
        let id = account_id.clone();
        return tokio::task::spawn_blocking(move || store2.folders(&id))
            .await
            .map_err(|e| e.to_string())?;
    }

    let Some(pw) = resolve_password(&rt, &account, MailProto::Imap) else {
        return Err(no_password_message());
    };
    let fetched = InProcessEngine
        .folders(&account, &pw)
        .await
        .map_err(String::from)?;

    let id = account_id.clone();
    tokio::task::spawn_blocking(move || {
        for f in fetched {
            let folder = MailFolder {
                id: folder_id_for(&id, &f.path),
                account_id: id.clone(),
                path: f.path,
                name: f.name,
                kind: f.kind,
                unread: f.unread,
                total: f.total,
            };
            store.upsert_folder(&folder)?;
            store.refresh_counts(&folder.id)?;
        }
        store.folders(&id)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn no_password_message() -> String {
    "no password available for this account — open the account settings to enter one, \
     or unlock the OS keyring if you saved it"
        .to_string()
}

fn emit_sync(app: &AppHandle, event: MailSyncEvent) {
    let _ = app.emit("mail:sync", event);
}

/// Pull folders and the newest headers, emitting progress rather than returning
/// once at the end.
///
/// Cancellable via [`mail_sync_cancel`] — the `commands::disk_usage` pattern.
/// Never dispatched from a launch or restore path: a restored mail tab renders
/// from the local store and shows a **Check mail** button.
#[tauri::command]
pub async fn mail_sync(
    app: AppHandle,
    account_id: String,
    folder_id: Option<String>,
    state: State<'_, MailState>,
) -> Result<MailSyncSummary, String> {
    let rt = state.inner().clone();
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut guard) = rt.lock() {
        guard.cancel.insert(account_id.clone(), cancel.clone());
    }

    let out = sync_inner(&app, &rt, &account_id, folder_id, &cancel).await;

    if let Ok(mut guard) = rt.lock() {
        guard.cancel.remove(&account_id);
    }
    let summary = match out {
        Ok(s) => s,
        Err(e) => MailSyncSummary {
            account_id: account_id.clone(),
            error: Some(e),
            ..Default::default()
        },
    };
    emit_sync(
        &app,
        MailSyncEvent {
            account_id: account_id.clone(),
            folder_id: None,
            phase: if summary.error.is_some() {
                "error".into()
            } else {
                "done".into()
            },
            new_messages: Some(summary.new_messages),
            error: summary.error.clone(),
        },
    );
    Ok(summary)
}

async fn sync_inner(
    app: &AppHandle,
    rt: &MailState,
    account_id: &str,
    only_folder: Option<String>,
    cancel: &Arc<AtomicBool>,
) -> Result<MailSyncSummary, String> {
    emit_sync(
        app,
        MailSyncEvent {
            account_id: account_id.to_string(),
            folder_id: None,
            phase: "start".into(),
            new_messages: None,
            error: None,
        },
    );

    let (account, store) = {
        let rt2 = rt.clone();
        let id = account_id.to_string();
        tokio::task::spawn_blocking(move || {
            Ok::<_, String>((account_by_id(&accounts_path(), &id)?, store_of(&rt2)?))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    let Some(pw) = resolve_password(rt, &account, MailProto::Imap) else {
        return Err(no_password_message());
    };

    // Folders first, so a brand-new account has somewhere to put headers.
    let fetched = InProcessEngine
        .folders(&account, &pw)
        .await
        .map_err(String::from)?;
    let id = account_id.to_string();
    let store2 = store.clone();
    let folders: Vec<MailFolder> = tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        for f in fetched {
            let folder = MailFolder {
                id: folder_id_for(&id, &f.path),
                account_id: id.clone(),
                path: f.path,
                name: f.name,
                kind: f.kind,
                unread: f.unread,
                total: f.total,
            };
            store2.upsert_folder(&folder)?;
            out.push(folder);
        }
        Ok::<_, String>(out)
    })
    .await
    .map_err(|e| e.to_string())??;

    let targets: Vec<MailFolder> = match &only_folder {
        Some(want) => folders.into_iter().filter(|f| &f.id == want).collect(),
        None => folders
            .into_iter()
            .filter(|f| {
                matches!(
                    f.kind,
                    crate::schema::mail::MailFolderKind::Inbox
                        | crate::schema::mail::MailFolderKind::Sent
                        | crate::schema::mail::MailFolderKind::Drafts
                )
            })
            .collect(),
    };

    let mut new_messages = 0u32;
    let folder_count = targets.len() as u32;
    for folder in targets {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        emit_sync(
            app,
            MailSyncEvent {
                account_id: account_id.to_string(),
                folder_id: Some(folder.id.clone()),
                phase: "folder".into(),
                new_messages: None,
                error: None,
            },
        );
        let headers = InProcessEngine
            .headers(&account, &pw, &folder.path, SYNC_HEADER_LIMIT)
            .await
            .map_err(String::from)?;

        let store3 = store.clone();
        let folder2 = folder.clone();
        let added: u32 = tokio::task::spawn_blocking(move || {
            let mut added = 0u32;
            for h in headers {
                let row = crate::schema::mail::MailHeader {
                    id: message_id_for(&folder2.id, h.uid),
                    account_id: folder2.account_id.clone(),
                    folder_id: folder2.id.clone(),
                    uid: h.uid,
                    rfc_message_id: h.headers.message_id.clone(),
                    subject: h.headers.subject,
                    from: h.headers.from,
                    to: h.headers.to,
                    cc: h.headers.cc,
                    date: h.headers.date,
                    seen: h.seen,
                    flagged: h.flagged,
                    answered: h.answered,
                    has_attachments: h.headers.has_attachments,
                    size: h.headers.size,
                    preview: h.headers.preview,
                    malformed_headers: if h.headers.malformed_headers.is_empty() {
                        None
                    } else {
                        Some(h.headers.malformed_headers)
                    },
                };
                if store3.upsert_header(&row)? {
                    added += 1;
                }
            }
            store3.refresh_counts(&folder2.id)?;
            Ok::<_, String>(added)
        })
        .await
        .map_err(|e| e.to_string())??;

        new_messages += added;
        emit_sync(
            app,
            MailSyncEvent {
                account_id: account_id.to_string(),
                folder_id: Some(folder.id.clone()),
                phase: "headers".into(),
                new_messages: Some(added),
                error: None,
            },
        );
        if added > 0 && folder.kind == crate::schema::mail::MailFolderKind::Inbox {
            let _ = app.emit(
                "mail:new",
                crate::schema::mail::MailNewEvent {
                    account_id: account_id.to_string(),
                    folder_id: folder.id.clone(),
                    count: added,
                },
            );
        }
    }

    Ok(MailSyncSummary {
        account_id: account_id.to_string(),
        folders: folder_count,
        new_messages,
        error: None,
    })
}

#[tauri::command]
pub async fn mail_sync_cancel(
    account_id: String,
    state: State<'_, MailState>,
) -> Result<(), String> {
    if let Ok(guard) = state.lock() {
        if let Some(flag) = guard.cancel.get(&account_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

/// One page of a folder's header index. Reads the local store only — listing
/// mail must never open a socket.
#[tauri::command]
pub async fn mail_headers(
    folder_id: String,
    offset: u32,
    limit: u32,
    query: Option<String>,
    state: State<'_, MailState>,
) -> Result<MailHeaderPage, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let store = store_of(&rt)?;
        store.headers_page(&folder_id, offset, limit, query.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Commands: bodies ────────────────────────────────────────────────────────

/// Fetch (or serve from cache) one message body, sanitized.
///
/// `allow_remote` is accepted and recorded for the frontend's banner, but it
/// does **not** load anything today: the remote-image proxy is plan B §2.6 and
/// is not part of this phase. Remote references are counted and stripped either
/// way, so a tracker never sees the user's IP.
#[tauri::command]
pub async fn mail_body(
    message_id: String,
    allow_remote: bool,
    state: State<'_, MailState>,
) -> Result<MailBody, String> {
    let _ = allow_remote;
    let rt = state.inner().clone();

    // Cache first — sanitization is the expensive step, and the cache is keyed
    // by SANITIZER_VERSION so a sanitizer fix re-protects already-synced mail.
    let rt2 = rt.clone();
    let id = message_id.clone();
    let cached = tokio::task::spawn_blocking(move || {
        let store = store_of(&rt2)?;
        let Some((html, text, links_json, remote_refs, truncated)) =
            store.cached_body(&id, SANITIZER_VERSION)?
        else {
            return Ok::<_, String>(None);
        };
        let links: Vec<MailLink> = serde_json::from_str(&links_json).unwrap_or_default();
        Ok(Some(MailBody {
            id: id.clone(),
            html,
            text,
            remote_refs,
            links,
            attachments: store.attachments(&id)?,
            truncated: truncated.then_some(true),
        }))
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(body) = cached {
        return Ok(body);
    }

    // Not cached: resolve the message, fetch it, parse it, sanitize it, store it.
    let rt3 = rt.clone();
    let id = message_id.clone();
    let (account, folder, header, store) = tokio::task::spawn_blocking(move || {
        let store = store_of(&rt3)?;
        let header = store
            .header(&id)?
            .ok_or_else(|| format!("message '{id}' is not in the local index"))?;
        let folder = store
            .folder(&header.folder_id)?
            .ok_or_else(|| "the message's folder is not in the local index".to_string())?;
        let account = account_by_id(&accounts_path(), &header.account_id)?;
        Ok::<_, String>((account, folder, header, store))
    })
    .await
    .map_err(|e| e.to_string())??;

    let Some(pw) = resolve_password(&rt, &account, MailProto::Imap) else {
        return Err(no_password_message());
    };
    let raw = InProcessEngine
        .body(&account, &pw, &folder.path, header.uid)
        .await
        .map_err(String::from)?;

    let id = message_id.clone();
    tokio::task::spawn_blocking(move || {
        // Parsing and sanitizing are CPU-bound work over attacker-controlled
        // bytes, so they run here rather than on the runtime's async threads.
        let parsed = mail_engine::parse_message(&raw).map_err(String::from)?;

        let (html, links, remote_refs, truncated) = match &parsed.html {
            Some(raw_html) => {
                let clean = mail_sanitize::sanitize_message_html(raw_html)
                    .map_err(|e| e.to_string())?;
                (
                    Some(clean.html),
                    clean.links,
                    clean.remote_refs,
                    clean.truncated,
                )
            }
            None => (None, Vec::new(), 0, false),
        };

        let mut attachments = Vec::new();
        for att in &parsed.attachments {
            let blob = store.put_blob(&att.bytes)?;
            store.put_attachment(&id, &att.meta, &blob)?;
            attachments.push(att.meta.clone());
        }

        let raw_blob = if raw.len() > crate::services::mail_store::INLINE_BODY_LIMIT {
            Some(store.put_blob(&raw)?)
        } else {
            None
        };
        store.cache_body(
            &id,
            SANITIZER_VERSION,
            html.as_deref(),
            parsed.text.as_deref(),
            &serde_json::to_string(&links).unwrap_or_else(|_| "[]".into()),
            remote_refs,
            truncated,
            raw_blob.as_deref(),
        )?;

        Ok(MailBody {
            id,
            html,
            text: parsed.text,
            remote_refs,
            links,
            attachments,
            truncated: truncated.then_some(true),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Commands: flags and moves ───────────────────────────────────────────────

#[tauri::command]
pub async fn mail_flag(
    message_id: String,
    flag: MailFlag,
    value: bool,
    state: State<'_, MailState>,
) -> Result<(), String> {
    let rt = state.inner().clone();
    let id = message_id.clone();
    let rt2 = rt.clone();
    let (account, folder, header, store) = tokio::task::spawn_blocking(move || {
        let store = store_of(&rt2)?;
        let header = store
            .header(&id)?
            .ok_or_else(|| format!("message '{id}' is not in the local index"))?;
        let folder = store
            .folder(&header.folder_id)?
            .ok_or_else(|| "the message's folder is not in the local index".to_string())?;
        let account = account_by_id(&accounts_path(), &header.account_id)?;
        Ok::<_, String>((account, folder, header, store))
    })
    .await
    .map_err(|e| e.to_string())??;

    // The local index is updated first so the UI stays responsive, then the
    // server. A server refusal is *reported* rather than swallowed — the two
    // sides having quietly diverged is worse than a visible error.
    let id = message_id.clone();
    let store2 = store.clone();
    let folder_id = folder.id.clone();
    tokio::task::spawn_blocking(move || {
        store2.set_flag(&id, flag, value)?;
        store2.refresh_counts(&folder_id)
    })
    .await
    .map_err(|e| e.to_string())??;

    let Some(pw) = resolve_password(&rt, &account, MailProto::Imap) else {
        return Err(no_password_message());
    };
    InProcessEngine
        .set_flag(
            &account,
            &pw,
            &folder.path,
            header.uid,
            flag.imap_flag(),
            value,
        )
        .await
        .map_err(String::from)
}

#[tauri::command]
pub async fn mail_move(
    message_ids: Vec<String>,
    dest_folder_id: String,
    state: State<'_, MailState>,
) -> Result<(), String> {
    if message_ids.is_empty() {
        return Ok(());
    }
    let rt = state.inner().clone();
    let rt2 = rt.clone();
    let ids = message_ids.clone();
    let dest = dest_folder_id.clone();
    let (account, source_path, dest_path, uids, store) = tokio::task::spawn_blocking(move || {
        let store = store_of(&rt2)?;
        let first = store
            .header(&ids[0])?
            .ok_or_else(|| "message is not in the local index".to_string())?;
        let source = store
            .folder(&first.folder_id)?
            .ok_or_else(|| "the source folder is not in the local index".to_string())?;
        let target = store
            .folder(&dest)?
            .ok_or_else(|| "the destination folder is not in the local index".to_string())?;
        let account = account_by_id(&accounts_path(), &first.account_id)?;
        let mut uids = Vec::new();
        for id in &ids {
            if let Some(h) = store.header(id)? {
                uids.push(h.uid);
            }
        }
        Ok::<_, String>((account, source.path, target.path, uids, store))
    })
    .await
    .map_err(|e| e.to_string())??;

    let Some(pw) = resolve_password(&rt, &account, MailProto::Imap) else {
        return Err(no_password_message());
    };
    InProcessEngine
        .move_messages(&account, &pw, &source_path, &uids, &dest_path)
        .await
        .map_err(String::from)?;

    tokio::task::spawn_blocking(move || store.move_messages(&message_ids, &dest_folder_id))
        .await
        .map_err(|e| e.to_string())?
}

// ── Commands: drafts and sending ────────────────────────────────────────────

#[tauri::command]
pub async fn mail_draft_save(
    draft: MailDraft,
    state: State<'_, MailState>,
) -> Result<MailDraft, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let store = store_of(&rt)?;
        let mut draft = draft;
        if draft.id.trim().is_empty() {
            draft.id = uuid_v4();
        }
        // The staged list is the store's, not the caller's: a draft cannot
        // invent an attachment it did not pick through `mail_attach_pick`.
        draft.staged = store.staged(&draft.id)?;
        store.save_draft(&draft)?;
        Ok(draft)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Send one draft. Nothing is ever sent without this explicit call — no read
/// receipts, no one-click unsubscribe, no auto-RSVP.
#[tauri::command]
pub async fn mail_draft_send(
    draft_id: String,
    state: State<'_, MailState>,
) -> Result<MailSendResult, String> {
    let rt = state.inner().clone();
    let rt2 = rt.clone();
    let id = draft_id.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        let store = store_of(&rt2)?;
        let draft = store
            .draft(&id)?
            .ok_or_else(|| format!("draft '{id}' not found"))?;
        let account = account_by_id(&accounts_path(), &draft.account_id)?;

        let mut attachments = Vec::new();
        for staged in store.staged(&id)? {
            attachments.push(OutboundAttachment {
                filename: staged.filename,
                mime: staged.mime,
                bytes: store.staged_bytes(&id, &staged.staged_id)?,
            });
        }
        let raw = mail_engine::build_outgoing(
            account.display_name.as_deref(),
            &account.address,
            &draft.to,
            &draft.cc,
            &draft.bcc,
            &draft.subject,
            &draft.body_text,
            draft.in_reply_to.as_deref(),
            draft.references.as_deref().unwrap_or(&[]),
            &attachments,
        )
        .map_err(String::from)?;

        let mut recipients = draft.to.clone();
        recipients.extend(draft.cc.clone());
        recipients.extend(draft.bcc.clone());
        Ok::<_, String>((account, raw, recipients, store))
    })
    .await
    .map_err(|e| e.to_string())?;

    let (account, raw, recipients, store) = match prepared {
        Ok(v) => v,
        Err(e) => {
            return Ok(MailSendResult {
                sent_id: None,
                error: Some(e),
            })
        }
    };

    let Some(pw) = resolve_password(&rt, &account, MailProto::Smtp) else {
        return Ok(MailSendResult {
            sent_id: None,
            error: Some(no_password_message()),
        });
    };

    match InProcessEngine
        .send(&account, &pw, &account.address, &recipients, &raw)
        .await
    {
        Ok(()) => {
            let id = draft_id.clone();
            let _ = tokio::task::spawn_blocking(move || store.delete_draft(&id)).await;
            Ok(MailSendResult {
                sent_id: Some(draft_id),
                error: None,
            })
        }
        Err(e) => Ok(MailSendResult {
            sent_id: None,
            error: Some(e.to_string()),
        }),
    }
}

// ── Commands: the file boundary ─────────────────────────────────────────────

/// Raise the OS **open** dialog inside Rust, copy the chosen files into the
/// draft's staging directory, and return opaque ids.
///
/// The *copy* is the boundary. After this call the mail subsystem has no reason
/// and no verb to read anything outside its own directory, and a compose window
/// cannot re-read the original file later. The frontend never supplies or
/// receives a path.
///
/// The dialog is raised through the callback API bridged to a `oneshot` — never
/// through the plugin's blocking variants, which would hold the main thread for
/// as long as the user takes to choose.
#[tauri::command]
pub async fn mail_attach_pick(
    app: AppHandle,
    draft_id: String,
    state: State<'_, MailState>,
) -> Result<Vec<StagedAttachment>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Attach files")
        .pick_files(move |chosen| {
            let _ = tx.send(chosen);
        });
    let chosen = rx.await.map_err(|_| "the file dialog was dismissed")?;
    let Some(chosen) = chosen else {
        return Ok(Vec::new());
    };

    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let store = store_of(&rt)?;
        let mut out = Vec::new();
        for file in chosen {
            let Ok(path) = file.into_path() else { continue };
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if !meta.is_file() || meta.len() > MAX_STAGED_BYTES {
                continue;
            }
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            // Only the basename leaves: a full local path in a
            // `Content-Disposition` is a directory-structure and username leak.
            let raw_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "attachment".to_string());
            let safe = mail_sanitize::sanitize_attachment_name(&raw_name);
            let mime = mime_guess::from_path(&safe.value)
                .first_or_octet_stream()
                .to_string();
            out.push(store.stage_attachment(
                &draft_id,
                &uuid_v4(),
                &safe.value,
                &mime,
                &bytes,
            )?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mail_attach_remove(
    draft_id: String,
    staged_id: String,
    state: State<'_, MailState>,
) -> Result<(), String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let store = store_of(&rt)?;
        store.remove_staged(&draft_id, &staged_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Raise the OS **save** dialog inside Rust with the sanitized filename
/// pre-filled, and write the decoded bytes to whatever single path the user
/// chose. Returns that path for a toast, or `None` on cancel.
///
/// One dialog, one file — there is deliberately no "save all attachments" and
/// no directory target. That friction sits exactly at the point where the
/// boundary is crossed, and it is the difference between "the user exported
/// three files" and "a message wrote eight files somewhere".
#[tauri::command]
pub async fn mail_attachment_save(
    app: AppHandle,
    message_id: String,
    part_id: String,
    state: State<'_, MailState>,
) -> Result<Option<String>, String> {
    let rt = state.inner().clone();
    let rt2 = rt.clone();
    let (mid, pid) = (message_id.clone(), part_id.clone());
    let (meta, bytes) = tokio::task::spawn_blocking(move || {
        let store = store_of(&rt2)?;
        let (meta, blob) = store
            .attachment(&mid, &pid)?
            .ok_or_else(|| "attachment not found".to_string())?;
        let bytes = store.get_blob(&blob)?;
        Ok::<_, String>((meta, bytes))
    })
    .await
    .map_err(|e| e.to_string())??;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save attachment")
        .set_file_name(meta.filename.clone())
        .save_file(move |chosen| {
            let _ = tx.send(chosen);
        });
    let chosen = rx.await.map_err(|_| "the file dialog was dismissed")?;
    let Some(chosen) = chosen else {
        // A cancelled dialog writes nothing. Not a partial file, not a temp
        // file, nothing.
        return Ok(None);
    };
    let target = chosen.into_path().map_err(|e| e.to_string())?;

    tokio::task::spawn_blocking(move || {
        // A plain write of the already-decoded blob to the path the dialog
        // returned. We do not create directories, do not follow the name, do
        // not append.
        std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
        Ok(Some(target.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bounded bytes for in-pane preview. Nothing is written to disk; the pane
/// renders them with the existing viewers, inside the capability boundary.
#[tauri::command]
pub async fn mail_attachment_preview(
    message_id: String,
    part_id: String,
    state: State<'_, MailState>,
) -> Result<MailPreviewBlob, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let store = store_of(&rt)?;
        let (meta, blob) = store
            .attachment(&message_id, &part_id)?
            .ok_or_else(|| "attachment not found".to_string())?;
        let bytes = store.get_blob(&blob)?;
        let truncated = bytes.len() > MAX_PREVIEW_BYTES;
        let slice = &bytes[..bytes.len().min(MAX_PREVIEW_BYTES)];
        Ok(MailPreviewBlob {
            mime: meta.mime,
            bytes_b64: base64::engine::general_purpose::STANDARD.encode(slice),
            truncated,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::mail::{MailSecurity, MailServer};

    fn tmp() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        (dir, path)
    }

    fn account(label: &str) -> MailAccount {
        MailAccount {
            id: String::new(),
            label: label.into(),
            address: "user@example.com".into(),
            imap: MailServer {
                host: "imap.example.com".into(),
                port: 993,
                user: "user@example.com".into(),
                security: MailSecurity::Tls,
            },
            smtp: MailServer {
                host: "smtp.example.com".into(),
                port: 465,
                user: "user@example.com".into(),
                security: MailSecurity::Tls,
            },
            ..Default::default()
        }
    }

    // ── The boundary ────────────────────────────────────────────────────────

    /// **The mechanically-checkable statement of the whole sandbox boundary.**
    ///
    /// It reads this file's own source, finds every `#[tauri::command]`
    /// signature, and asserts that no parameter is path-shaped. It fails loudly
    /// the first time someone "just adds a path here" — which is the only kind
    /// of regression gate available given `cargo test` is the only gate at all.
    ///
    /// The rule is deliberately name-based and precise: a parameter is
    /// path-shaped when its name **is** one of the reserved words, or **ends**
    /// with `_path`/`_dir`/`_file`/`_filename`/`_glob`, or **starts** with
    /// `path_`. Note what that permits and why: `dest_folder_id` and
    /// `folder_id` are opaque store ids, not locations — an id names a row, and
    /// a row cannot be traversed.
    #[test]
    fn no_command_takes_a_path() {
        const RESERVED: &[&str] = &[
            "path",
            "paths",
            "dest",
            "destination",
            "dir",
            "directory",
            "folder",
            "file",
            "filename",
            "filepath",
            "glob",
            "cwd",
            "root",
            "target",
            "location",
            "url",
        ];
        const SUFFIXES: &[&str] = &["_path", "_dir", "_file", "_filename", "_glob", "_paths"];

        // Path-shaped *types*, checked alongside the names: `save_to: PathBuf`
        // is exactly the parameter this rule exists to reject, and no name-based
        // list would ever have caught it.
        const RESERVED_TYPES: &[&str] =
            &["path", "pathbuf", "osstr", "osstring", "direntry"];

        let src = include_str!("mail.rs");
        // Located line-by-line, matching the whole line, for the same reason
        // `every_command_is_async` does: the module doc quotes the marker and so
        // does this test, and a substring search counts both. That inflated the
        // scanned count past the floor below, which meant the floor would have
        // survived deleting two real commands — a coverage assertion that cannot
        // fail is worse than none, because it reads as proof.
        let mut starts: Vec<usize> = Vec::new();
        let mut offset = 0usize;
        for line in src.lines() {
            if line.trim() == concat!("#[tauri", "::command]") {
                starts.push(offset + line.len());
            }
            offset += line.len() + 1;
        }

        let mut checked = 0usize;
        for start in starts {
            let Some(open) = src[start..].find('(') else { break };
            let sig_start = start + open + 1;
            // The signature ends at the matching close paren.
            let mut depth = 1usize;
            let mut i = sig_start;
            let bytes = src.as_bytes();
            while i < bytes.len() && depth > 0 {
                match bytes[i] {
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    _ => {}
                }
                i += 1;
            }
            let params = &src[sig_start..i.saturating_sub(1)];
            let name = src[start..sig_start].trim();
            checked += 1;

            let mut depth = 0usize;
            for part in params.split(|c| {
                // Split on top-level commas only: `State<'_, MailState>`
                // contains one that is not a parameter separator.
                match c {
                    '<' | '(' | '[' => {
                        depth += 1;
                        false
                    }
                    '>' | ')' | ']' => {
                        depth = depth.saturating_sub(1);
                        false
                    }
                    ',' => depth == 0,
                    _ => false,
                }
            }) {
                let part = part.trim();
                if part.is_empty() {
                    continue;
                }
                let Some((pname, ty)) = part.split_once(':') else {
                    continue;
                };
                let pname = pname.trim().trim_start_matches("mut ").to_ascii_lowercase();
                // Split the type into identifiers so `PathBuf` is caught but
                // `MailPathologyReport` would not be — a substring test on the
                // whole type string would flag any name containing "path".
                let ty_lower = ty.to_ascii_lowercase();
                for ident in ty_lower.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
                    assert!(
                        !RESERVED_TYPES.contains(&ident),
                        "`{pname}: {}` in `{name}` is a path-shaped parameter — the mail \
                         command surface must name no location the frontend controls",
                        ty.trim()
                    );
                }
                assert!(
                    !RESERVED.contains(&pname.as_str()),
                    "`{pname}` in `{name}` is a path-shaped parameter — the mail command \
                     surface must name no location the frontend controls"
                );
                assert!(
                    !SUFFIXES.iter().any(|s| pname.ends_with(s))
                        && !pname.starts_with("path_"),
                    "`{pname}` in `{name}` is a path-shaped parameter — the mail command \
                     surface must name no location the frontend controls"
                );
            }
        }
        assert!(
            checked >= 19,
            "expected the whole frozen command surface to be scanned, saw {checked}"
        );
    }

    /// Rule 1, also enforced mechanically: a synchronous mail command would run
    /// on the main thread and freeze the window.
    #[test]
    fn every_command_is_async() {
        let src = include_str!("mail.rs");
        let lines: Vec<&str> = src.lines().collect();
        let mut seen = 0usize;
        for (i, line) in lines.iter().enumerate() {
            // Only a real attribute line counts — the module doc quotes the
            // marker, and a doc comment is not a command.
            if line.trim() != concat!("#[tauri", "::command]") {
                continue;
            }
            seen += 1;
            let next = lines.get(i + 1).copied().unwrap_or("").trim_start();
            assert!(
                next.starts_with("pub async fn"),
                "the command at line {} is not `pub async fn` — a sync command runs on \
                 the main thread and freezes the whole webview:\n{next}",
                i + 2
            );
        }
        assert!(seen >= 19, "expected the whole command surface, saw {seen}");
    }

    /// The whole frozen surface must exist, or the frontend's typed wrappers
    /// have nothing to call.
    #[test]
    fn the_frozen_command_surface_is_complete() {
        let src = include_str!("mail.rs");
        for name in [
            "mail_accounts_list",
            "mail_account_upsert",
            "mail_account_delete",
            "mail_account_test",
            "mail_password_state",
            "mail_forget_password",
            "mail_folders",
            "mail_sync",
            "mail_sync_cancel",
            "mail_headers",
            "mail_body",
            "mail_flag",
            "mail_move",
            "mail_draft_save",
            "mail_draft_send",
            "mail_attach_pick",
            "mail_attach_remove",
            "mail_attachment_save",
            "mail_attachment_preview",
        ] {
            assert!(
                src.contains(&format!("pub async fn {name}(")),
                "the frozen contract names `{name}`, which is missing"
            );
        }
    }

    /// `blocking_pick_*` on the main thread is the freeze this whole file is
    /// arranged to avoid, and it is the easy thing to reach for.
    #[test]
    fn the_dialogs_are_never_raised_with_the_blocking_api() {
        let src = include_str!("mail.rs");
        for banned in [
            concat!("blocking_pick", "_file"),
            concat!("blocking_pick", "_files"),
            concat!("blocking_save", "_file"),
            concat!("blocking_pick", "_folder"),
        ] {
            assert!(!src.contains(banned), "`{banned}` blocks the main thread");
        }
    }

    /// A directory picker would hand the mail subsystem a whole tree.
    #[test]
    fn no_directory_picker_and_no_external_open() {
        let src = include_str!("mail.rs");
        // Split so the list does not match itself when the scan runs over this
        // very file.
        for banned in [
            concat!("pick", "_folder"),
            concat!("opener", "::"),
            concat!("open", "_file("),
            concat!("tauri_plugin", "_drag"),
        ] {
            assert!(
                !src.contains(banned),
                "`{banned}` would widen the file boundary"
            );
        }
    }

    // ── accounts.json ───────────────────────────────────────────────────────

    #[test]
    fn a_missing_accounts_file_is_an_empty_list() {
        let (_d, path) = tmp();
        assert!(read_accounts(&path).unwrap().accounts.is_empty());
    }

    #[test]
    fn upsert_mints_an_id_and_round_trips() {
        let (_d, path) = tmp();
        let a = upsert_account_at(&path, account("Personal")).unwrap();
        assert!(!a.id.is_empty());
        let b = upsert_account_at(&path, account("Work")).unwrap();
        assert_ne!(a.id, b.id);

        let all = read_accounts(&path).unwrap().accounts;
        assert_eq!(all.len(), 2);
        assert_eq!(account_by_id(&path, &a.id).unwrap().label, "Personal");

        let mut edited = a.clone();
        edited.label = "Renamed".into();
        upsert_account_at(&path, edited).unwrap();
        assert_eq!(read_accounts(&path).unwrap().accounts.len(), 2, "no dupe");
        assert_eq!(account_by_id(&path, &a.id).unwrap().label, "Renamed");
    }

    #[test]
    fn delete_removes_only_the_named_account() {
        let (_d, path) = tmp();
        let a = upsert_account_at(&path, account("A")).unwrap();
        let b = upsert_account_at(&path, account("B")).unwrap();
        delete_account_at(&path, &a.id).unwrap();
        assert!(account_by_id(&path, &a.id).is_err());
        assert!(account_by_id(&path, &b.id).is_ok());
        assert!(delete_account_at(&path, "ghost").is_err());
    }

    /// `accounts.json` must never hold a secret — the keychain does.
    #[test]
    fn the_accounts_file_holds_no_secret() {
        let (_d, path) = tmp();
        upsert_account_at(&path, account("Personal")).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        for banned in ["password\":\"", "secret", "token", "passphrase"] {
            assert!(!raw.contains(banned), "found `{banned}` in {raw}");
        }
    }

    // ── The remember tri-state ──────────────────────────────────────────────

    /// **`false` is unrepresentable.** The bug this closes is documented and
    /// real: a checkbox seeded by an async keyring read, clicked before the
    /// read lands, sends `false` and deletes the password it just
    /// authenticated with.
    #[test]
    fn a_save_can_never_clear_a_credential() {
        assert_eq!(remember_arg(Some(true)), Some(true));
        assert_eq!(remember_arg(None), None);
        assert_eq!(
            remember_arg(Some(false)),
            None,
            "an upsert must never be able to forget a password"
        );
    }

    // ── Identity ────────────────────────────────────────────────────────────

    #[test]
    fn folder_ids_are_stable_and_distinct() {
        let a = folder_id_for("acct", "INBOX");
        assert_eq!(a, folder_id_for("acct", "INBOX"), "stable across calls");
        assert_ne!(a, folder_id_for("acct", "INBOX/Sub"));
        assert_ne!(a, folder_id_for("other", "INBOX"));
        // Opaque: a folder path with separators cannot leak into an id that is
        // later joined onto anything.
        let weird = folder_id_for("acct", "../../etc");
        assert!(!weird.contains('/'), "{weird}");
        assert!(!weird.contains('.'), "{weird}");
    }

    #[test]
    fn message_ids_are_per_folder() {
        let f = folder_id_for("acct", "INBOX");
        assert_eq!(message_id_for(&f, 7), format!("{f}-7"));
        assert_ne!(message_id_for(&f, 7), message_id_for(&f, 8));
    }

    // ── The mail directory ──────────────────────────────────────────────────

    /// Everything resolves under one directory, and that directory is
    /// machine-level state — never a project tree.
    #[test]
    fn the_mail_directory_is_inside_the_global_state_directory() {
        let dir = mail_dir();
        assert!(dir.starts_with(storage::state_dir()));
        assert!(dir.ends_with("mail"));
        assert!(accounts_path().starts_with(&dir));
    }
}
