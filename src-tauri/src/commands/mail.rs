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
    MailAccount, MailAccountSaved, MailAccounts, MailBody, MailDraft, MailEncryptionState,
    MailCryptoInfo, MailFilterReport, MailFilterRule, MailFilterSample, MailFilters, MailFlag, MailFolder, MailFolderKind, MailHeader, MailHeaderPage, MailKeyringState, MailLink, MailPasswordState, MailPreviewBlob,
    MailPriority, MailPriorityCounts, MailProbe, MailSendResult, MailSort, MailSyncEvent,
    MailSyncSummary, StagedAttachment, ACCOUNTS_VERSION, FILTERS_VERSION,
};
use crate::services::mail_crypt::{self, MailKeys};
use crate::services::mail_crypto::{self, CryptoKind, DecryptError};
use crate::services::mail_pgp::{self, PgpKeyInfo, PgpKeyring, SealOpts};
use crate::services::mail_engine::{
    self, InProcessEngine, MailEngine, OutboundAttachment, Password,
};
use crate::services::mail_authres;
use crate::services::mail_filters;
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

/// Where the account list lives once the store is encrypted.
///
/// A separate filename rather than a sealed `accounts.json`, so the two are
/// never ambiguous: whichever one is on disk says unambiguously which state the
/// store is in, and a half-finished migration is visible rather than a file
/// whose contents have to be sniffed.
fn accounts_enc_path() -> PathBuf {
    sealed_twin(&accounts_path())
}

/// The sealed twin of a state file: `<name>.json` → `<name>.json.enc`, **beside
/// it**.
///
/// Derived from the path the caller passed rather than from `mail_dir()`, which
/// is what makes `read_accounts(&some_dir)` a self-contained operation on
/// `some_dir`. It used to mix the two — the plaintext file came from the
/// argument and the sealed one from the global state directory — so a call
/// against any other directory silently read the *real* mailbox's account list.
/// In production the two are the same directory and nothing changes.
fn sealed_twin(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".enc");
    PathBuf::from(name)
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
    /// Set when the open store is a memory-only stand-in — see [`UnlockNote`].
    /// The UI reads it through `mail_encryption_state` so "your mail is not
    /// being saved" is a statement the user sees, not one they infer from an
    /// inbox that empties itself every launch.
    unlock_note: Option<UnlockNote>,
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
    let opened = open_store(&mail_dir())?;
    set_session_keys(opened.keys.clone());
    rt.store = Some(opened.store.clone());
    rt.unlock_note = opened.note;
    Ok(opened.store)
}

// ── The store key, for the session ──────────────────────────────────────────

/// The mail store's keys, for as long as this process runs.
///
/// A module-level handle rather than a field on [`MailRuntime`], deliberately,
/// and the reason is that there is exactly **one** of them: `mail_dir()` is a
/// constant, so a process has one mail store and therefore one master key. The
/// per-*account* secrets — the passwords the user chose not to persist — stay in
/// `MailRuntime` where they belong, because there is one per account and they
/// are what "not persisted by default" is about.
///
/// It exists because the account-list helpers below are path-shaped free
/// functions reached from a dozen call sites, several inside `spawn_blocking`
/// closures. Threading an `Option<&MailKeys>` through all of them would be a
/// large mechanical diff for an identical security property, and a large
/// mechanical diff through a crypto path is its own risk.
///
/// Nothing here is ever serialized and it dies with the process, exactly like
/// the password map.
static SESSION_KEYS: std::sync::RwLock<Option<Arc<MailKeys>>> = std::sync::RwLock::new(None);

fn set_session_keys(keys: Option<Arc<MailKeys>>) {
    if let Ok(mut slot) = SESSION_KEYS.write() {
        *slot = keys;
    }
}

fn session_keys() -> Option<Arc<MailKeys>> {
    SESSION_KEYS.read().ok().and_then(|k| k.clone())
}

/// Has the one silent unlock attempt below already been made?
#[cfg(not(test))]
static FILE_KEYS_TRIED: AtomicBool = AtomicBool::new(false);

/// The store key **for the sealed files beside the database** — the account list
/// and the filter rules.
///
/// This exists because of a bug it is worth naming precisely. [`SESSION_KEYS`]
/// is published by `store_of`, i.e. by *opening the database*. But the files are
/// read by commands that never touch the database: `mail_accounts_list` is the
/// first mail command a launch runs (the header badge calls it), and on an
/// encrypted install it would find no keys, skip `accounts.json.enc`, look for
/// the plaintext `accounts.json` that the migration deleted — and answer **an
/// empty list**. The user's account had not vanished; nothing had asked for the
/// key yet. Worse was the write half: re-adding the account in that state sealed
/// nothing and wrote a *plaintext* file beside the sealed one, which every later
/// read (once something had opened the database) then ignored in favour of the
/// sealed twin. Twice-vanished, and the second time with a stray cleartext copy
/// of the account list on disk.
///
/// So the files resolve the key themselves rather than depending on an unrelated
/// command having run first. Two properties keep that cheap and honest:
///
/// - **At most one attempt per process.** A locked keyring costs a bounded (4 s)
///   read in `remote_credentials`, and these commands run on a timer — retrying
///   per call would turn a locked collection into a periodic stall. Once
///   `SESSION_KEYS` is set by anything (this, `store_of`, or the user typing a
///   passphrase into `adopt_keys`) that answer is used from then on.
/// - **It degrades, never fails.** Every non-`Ready` outcome answers `None`, and
///   the caller then behaves exactly as it did before: `read_*` falls back to the
///   plaintext file, `write_*` refuses rather than shadowing a sealed one
///   ([`sealed_write_refusal`]). Reporting *why* stays `mail_encryption_state`'s
///   job, which is the surface built for it.
fn file_keys() -> Option<Arc<MailKeys>> {
    session_keys().or_else(silent_unlock)
}

/// **Not under `cargo test`.** The silent unlock reads the *developer's own*
/// keychain and the real state directory, so a unit test that resolved a key
/// this way would be reading the machine's actual mailbox — passing or failing
/// depending on whose laptop it ran on. The two halves that *can* be reasoned
/// about are tested instead: the refusal rule (`sealed_write_refusal`), and,
/// structurally, that the readers go through [`file_keys`] at all.
#[cfg(test)]
fn silent_unlock() -> Option<Arc<MailKeys>> {
    None
}

#[cfg(not(test))]
fn silent_unlock() -> Option<Arc<MailKeys>> {
    if FILE_KEYS_TRIED.swap(true, Ordering::Relaxed) {
        return None;
    }
    match mail_crypt::unlock(&mail_dir()) {
        mail_crypt::Unlock::Ready(keys) => {
            let keys = Arc::new(keys);
            set_session_keys(Some(keys.clone()));
            Some(keys)
        }
        _ => None,
    }
}

/// Why a plaintext write must not happen: there is a sealed file and no key.
///
/// Returned as a message rather than performed silently, because both other
/// options are worse. Writing plaintext beside a sealed file produces a save
/// that *reports success* and is then permanently ignored — the read prefers the
/// sealed twin — while also dropping unencrypted what the user encrypted.
/// Writing nothing at all and claiming success is the same lie without the file.
///
/// Pure, so the rule is testable without a keyring or a state directory.
fn sealed_write_refusal(sealed_exists: bool, have_keys: bool) -> Option<String> {
    (sealed_exists && !have_keys).then(|| {
        "this mailbox is encrypted and its key is not available right now — unlock the OS \
         keyring (or enter the mail passphrase) and try again. Nothing was changed."
            .to_string()
    })
}

/// The outcome of opening the store: the handle, the keys behind it, and — when
/// the store is *not* the real one — why.
struct OpenedStore {
    store: Arc<MailStore>,
    keys: Option<Arc<MailKeys>>,
    note: Option<UnlockNote>,
}

/// Why the store on screen is not the store on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnlockNote {
    /// Waiting for the user to type their passphrase.
    NeedsPassphrase,
    /// The key could not be reached — a locked keyring, most often — so this is
    /// a memory-only store that forgets everything at exit.
    Unavailable(String),
}

/// Open the mail store, resolving how it unlocks.
///
/// The **degrade** is the load-bearing part. A locked Secret Service collection
/// reads identically to "nothing saved" and can block a read forever; that
/// failure class already cost this codebase a set of permanently-amber
/// connection lamps. Here it must not cost a mailbox: an unreachable key opens
/// an ephemeral store instead, so mail still syncs and still reads, and the next
/// run with an unlocked keyring picks up the persistent one.
fn open_store(dir: &Path) -> Result<OpenedStore, String> {
    use crate::services::mail_crypt::Unlock;
    match mail_crypt::unlock(dir) {
        Unlock::Ready(keys) => {
            let keys = Arc::new(keys);
            let store = Arc::new(MailStore::open_with_keys(dir, Some(keys.clone()))?);
            migrate_accounts_file(Some(&keys))?;
            migrate_filters_file(Some(&keys))?;
            Ok(OpenedStore {
                store,
                keys: Some(keys),
                note: None,
            })
        }
        Unlock::NeedsPassphrase => Ok(OpenedStore {
            store: Arc::new(MailStore::open_ephemeral()?),
            keys: None,
            note: Some(UnlockNote::NeedsPassphrase),
        }),
        Unlock::Unavailable(why) => Ok(OpenedStore {
            store: Arc::new(MailStore::open_ephemeral()?),
            keys: None,
            note: Some(UnlockNote::Unavailable(why)),
        }),
        Unlock::Disabled => open_unencrypted_or_enable(dir),
    }
}

/// The first-run decision, made once and then remembered.
///
/// A **new** install has nothing to migrate, so encryption costs nothing and is
/// turned on silently. An install that already holds mail is *not* converted
/// behind the user's back — the migration rewrites the whole database and is
/// their call — so it opens plain and `mail_encryption_state` tells the UI to
/// ask, once. `Some(false)` means they answered no and are never asked again.
fn open_unencrypted_or_enable(dir: &Path) -> Result<OpenedStore, String> {
    let preference = read_settings().mail_encrypt_store;
    let is_new = !dir.join("mail.db").exists();
    let should_enable = match preference {
        Some(false) => false,
        // Asked for, but the key file is gone (a half-finished reset, a restored
        // backup). Re-enabling is right: the setting is what the user asked for.
        Some(true) => true,
        None => is_new,
    };
    if should_enable {
        // Best effort. A locked keyring at first launch must not stop the mail
        // client from opening at all — the store simply stays plain and the
        // preference stays unset, so the question is asked again later.
        if let Ok(keys) = mail_crypt::enable_with_keychain(dir) {
            let keys = Arc::new(keys);
            let store = Arc::new(MailStore::open_with_keys(dir, Some(keys.clone()))?);
            migrate_accounts_file(Some(&keys))?;
            migrate_filters_file(Some(&keys))?;
            set_encrypt_preference(Some(true));
            return Ok(OpenedStore {
                store,
                keys: Some(keys),
                note: None,
            });
        }
    }
    Ok(OpenedStore {
        store: Arc::new(MailStore::open(dir)?),
        keys: None,
        note: None,
    })
}

fn read_settings() -> crate::schema::Settings {
    let path = storage::state_dir().join("settings.json");
    storage::read_json(&path).unwrap_or_default()
}

/// Read-modify-write of the single field, for the reason
/// `commands::settings::save_window_state` documents: the frontend's
/// `updateSettings` writes the whole cached object back, so writing the whole
/// object from here would clobber anything changed since that cache was filled.
fn set_encrypt_preference(value: Option<bool>) {
    let path = storage::state_dir().join("settings.json");
    let mut settings: crate::schema::Settings = storage::read_json(&path).unwrap_or_default();
    settings.mail_encrypt_store = value;
    let _ = storage::write_json_atomic(&path, &settings);
}

// ── OpenPGP ─────────────────────────────────────────────────────────────────

/// The keyring, which exists only when the store is encrypted.
///
/// Not a limitation to work around: private key material in a plaintext file
/// would make the whole feature theatre, and the phase ordering in the plan is
/// built on exactly this coupling. The error names the fix rather than the rule.
fn keyring_of(rt: &MailState) -> Result<PgpKeyring, String> {
    // Opening the store is what resolves the unlock and publishes the keys.
    store_of(rt)?;
    let keys = session_keys().ok_or(
        "turn on encryption for the local mail store first — an OpenPGP private key \
         cannot be kept in a plaintext file",
    )?;
    PgpKeyring::open(&mail_dir(), &keys)
}

/// Whether this message was signed or encrypted, and what came of it.
///
/// Returns the raw bytes to go on parsing, which for an encrypted message are
/// the **decrypted** ones — so everything downstream (structural caps, the
/// sanitizer, the attachment walk) runs over the plaintext exactly as it does
/// for an ordinary message. That is the plan's non-negotiable ordering,
/// `decrypt → parse → sanitize → render`: decryption confers no trust, and a
/// decrypted body is if anything *more* attacker-controlled than a plain one
/// because it arrived wearing a padlock.
fn apply_crypto(
    rt: &MailState,
    raw: Vec<u8>,
    from_address: &str,
) -> (Vec<u8>, Option<MailCryptoInfo>) {
    let parsed = match mail_parser::MessageParser::default().parse(&raw) {
        Some(m) => m,
        None => return (raw, None),
    };
    let Some(kind) = mail_crypto::detect(&parsed) else {
        return (raw, None);
    };
    if !kind.is_supported() {
        return (raw, Some(mail_crypto::info_for(kind, None, false, from_address)));
    }
    let Ok(ring) = keyring_of(rt) else {
        // No keyring at all. The message is still reported as encrypted/signed —
        // silence here would render an armored blob as if it were the mail.
        return (raw, Some(mail_crypto::info_for(kind, None, false, from_address)));
    };

    match kind {
        CryptoKind::PgpEncrypted | CryptoKind::PgpInlineEncrypted => {
            let payload = match kind {
                CryptoKind::PgpEncrypted => mail_pgp::encrypted_part_bytes(&raw, &parsed),
                _ => parsed
                    .text_body
                    .first()
                    .and_then(|id| parsed.part(*id))
                    .and_then(|p| p.text_contents())
                    .map(|t| t.as_bytes().to_vec()),
            };
            let Some(payload) = payload else {
                return (raw, Some(mail_crypto::info_for(kind, None, false, from_address)));
            };
            match ring.decrypt_message(&payload) {
                Ok(plain) => {
                    // Decrypted mail is often signed *inside*, which is the
                    // ordering that means anything — so the inner message is
                    // re-examined rather than reported as merely "decrypted".
                    let inner = plain.to_vec();
                    let (inner_raw, inner_info) = apply_crypto(rt, inner, from_address);
                    let mut info = inner_info.unwrap_or_else(|| {
                        mail_crypto::info_for(kind, None, true, from_address)
                    });
                    info.encrypted = true;
                    info.decrypted = true;
                    (inner_raw, Some(info))
                }
                Err(e) => {
                    let mut info = mail_crypto::info_for(kind, None, false, from_address);
                    info.notes.push(match e {
                        DecryptError::NoKey => "decrypt-no-key".into(),
                        DecryptError::Locked => "decrypt-locked".into(),
                        DecryptError::Unsupported(_) => "format-not-supported".into(),
                        // One indistinguishable failure, deliberately: see
                        // `mail_crypto::DecryptError`.
                        DecryptError::Failed => "decrypt-failed".into(),
                    });
                    (raw, Some(info))
                }
            }
        }
        CryptoKind::PgpSigned => {
            let outcome = mail_pgp::signed_part_bytes(&raw, &parsed)
                .map(|(signed, sig)| ring.verify_detached(&signed, &sig));
            let info = mail_crypto::info_for(kind, outcome.as_ref(), false, from_address);
            (raw, Some(info))
        }
        // Inline (pre-MIME) signatures are detected and reported, not checked:
        // the cleartext-signature framework has its own dash-escaping and
        // canonicalization rules, and a verifier that got them subtly wrong
        // would report passes over text the sender never signed. Naming it
        // honestly is better than checking it badly.
        CryptoKind::PgpInlineSigned => {
            let mut info = mail_crypto::info_for(kind, None, false, from_address);
            info.notes.push("inline-signature-not-checked".into());
            (raw, Some(info))
        }
        _ => (raw, Some(mail_crypto::info_for(kind, None, false, from_address))),
    }
}

/// The account's Sent folder, from the **local index only**.
///
/// Read locally rather than listed over IMAP because this runs immediately after
/// a successful send: a second round trip to discover a folder would put a
/// network call between "the message is delivered" and "the user is told so",
/// and its failure would be indistinguishable from a failed send. No Sent folder
/// in the index means no Sent copy, which is exactly the behaviour that existed
/// before phase 8 and is a safe place to land.
async fn sent_folder_for(rt: &MailState, account: &MailAccount) -> Option<String> {
    let rt = rt.clone();
    let account_id = account.id.clone();
    tokio::task::spawn_blocking(move || {
        let store = store_of(&rt).ok()?;
        store
            .folders(&account_id)
            .ok()?
            .into_iter()
            .find(|f| f.kind == MailFolderKind::Sent)
            .map(|f| f.path)
    })
    .await
    .ok()
    .flatten()
}

// ── accounts.json ───────────────────────────────────────────────────────────

/// Read the account list. A missing file is an empty list, not an error.
///
/// `path` is `accounts.json` and is passed by every caller; the sealed twin
/// beside it is resolved here rather than at the call sites, so "is the store
/// encrypted" is one question asked in one place. When keys are present the
/// sealed file wins — and if only the plaintext one is there, it is read and
/// then converted by [`migrate_accounts_file`].
fn read_accounts(path: &Path) -> Result<MailAccounts, String> {
    if let Some(keys) = file_keys() {
        let enc = sealed_twin(path);
        if enc.exists() {
            let raw = std::fs::read(&enc).map_err(|e| e.to_string())?;
            let plain = mail_crypt::open(&keys.field, &mail_crypt::accounts_aad(), &raw)
                .map_err(|e| format!("the mail account list could not be decrypted: {e}"))?;
            return serde_json::from_slice(&plain).map_err(|e| e.to_string());
        }
    }
    if !path.exists() {
        return Ok(MailAccounts {
            version: ACCOUNTS_VERSION,
            ..Default::default()
        });
    }
    storage::read_json(path).map_err(|e| e.to_string())
}

fn write_accounts(path: &Path, data: &MailAccounts) -> Result<(), String> {
    let Some(keys) = file_keys() else {
        if let Some(why) = sealed_write_refusal(sealed_twin(path).exists(), false) {
            return Err(why);
        }
        return storage::write_json_atomic(path, data).map_err(|e| e.to_string());
    };
    let json = serde_json::to_vec(data).map_err(|e| e.to_string())?;
    let sealed = mail_crypt::seal(&keys.field, &mail_crypt::accounts_aad(), &json);
    mail_crypt::write_bytes_atomic(&sealed_twin(path), &sealed)?;
    // Only after the sealed copy is safely on disk. The other order loses every
    // configured account if the process dies between the two calls.
    let _ = std::fs::remove_file(path);
    Ok(())
}

/// Convert a plaintext `accounts.json` into its sealed twin, once.
///
/// Runs at store-open rather than lazily, so a user who never touches the
/// account dialog still ends up with the file sealed. A no-op when there is
/// nothing to convert.
fn migrate_accounts_file(keys: Option<&MailKeys>) -> Result<(), String> {
    let Some(keys) = keys else { return Ok(()) };
    let plain = accounts_path();
    if !plain.exists() || accounts_enc_path().exists() {
        return Ok(());
    }
    let data: MailAccounts = storage::read_json(&plain).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
    let sealed = mail_crypt::seal(&keys.field, &mail_crypt::accounts_aad(), &json);
    mail_crypt::write_bytes_atomic(&accounts_enc_path(), &sealed)?;
    let _ = std::fs::remove_file(&plain);
    Ok(())
}

// ── filters.json ────────────────────────────────────────────────────────────
//
// The keyword rules, stored beside the accounts and sealed the same way (its own
// AAD — see `mail_crypt::filters_aad`). Everything the account file's three
// helpers do, these three do, deliberately as a copy of that shape rather than a
// generalization: two files with slightly different migration timing behind one
// abstraction is how a half-converted store happens.

fn filters_path() -> PathBuf {
    mail_dir().join("filters.json")
}

fn filters_enc_path() -> PathBuf {
    sealed_twin(&filters_path())
}

/// Read the rule list. A missing file is an empty list, not an error.
///
/// A rule the running build cannot parse — a `field` a newer version added — is
/// **dropped rather than guessed at**, which is why `rules` deserializes through
/// a permissive `Vec<Value>` first. Half-understanding a rule would mean filing
/// mail by a condition nobody wrote; the rest of the list still works, and the
/// dropped rule reappears the moment the newer build runs again, because a save
/// from here rewrites only what it could read (stated in the dialog).
fn read_filters(path: &Path) -> Result<MailFilters, String> {
    let raw: Option<Vec<u8>> = if let Some(keys) = file_keys() {
        let enc = sealed_twin(path);
        if enc.exists() {
            let sealed = std::fs::read(&enc).map_err(|e| e.to_string())?;
            let plain = mail_crypt::open(&keys.field, &mail_crypt::filters_aad(), &sealed)
                .map_err(|e| format!("the mail filter list could not be decrypted: {e}"))?;
            Some(plain.to_vec())
        } else {
            None
        }
    } else {
        None
    };
    let bytes = match raw {
        Some(b) => b,
        None => {
            if !path.exists() {
                return Ok(MailFilters {
                    version: FILTERS_VERSION,
                    ..Default::default()
                });
            }
            std::fs::read(path).map_err(|e| e.to_string())?
        }
    };
    Ok(parse_filters(&bytes))
}

/// The lenient half of [`read_filters`], split out so it is testable without a
/// state directory. A file that is not JSON at all reads as an empty list: the
/// alternative is a mail client that refuses to open because a rule file is
/// corrupt, and there is nothing in here that cannot be retyped.
fn parse_filters(bytes: &[u8]) -> MailFilters {
    #[derive(serde::Deserialize, Default)]
    struct Loose {
        #[serde(default)]
        version: u32,
        #[serde(default)]
        rules: Vec<serde_json::Value>,
    }
    let loose: Loose = serde_json::from_slice(bytes).unwrap_or_default();
    MailFilters {
        version: if loose.version == 0 {
            FILTERS_VERSION
        } else {
            loose.version
        },
        rules: loose
            .rules
            .into_iter()
            .filter_map(|v| serde_json::from_value::<MailFilterRule>(v).ok())
            .collect(),
        extra: Default::default(),
    }
}

fn write_filters(path: &Path, data: &MailFilters) -> Result<(), String> {
    let Some(keys) = file_keys() else {
        if let Some(why) = sealed_write_refusal(sealed_twin(path).exists(), false) {
            return Err(why);
        }
        return storage::write_json_atomic(path, data).map_err(|e| e.to_string());
    };
    let json = serde_json::to_vec(data).map_err(|e| e.to_string())?;
    let sealed = mail_crypt::seal(&keys.field, &mail_crypt::filters_aad(), &json);
    mail_crypt::write_bytes_atomic(&sealed_twin(path), &sealed)?;
    // Sealed copy first, plaintext removed second — `write_accounts`' order, for
    // its reason.
    let _ = std::fs::remove_file(path);
    Ok(())
}

/// Convert a plaintext `filters.json` into its sealed twin, once. Runs beside
/// [`migrate_accounts_file`] at store-open.
fn migrate_filters_file(keys: Option<&MailKeys>) -> Result<(), String> {
    let Some(keys) = keys else { return Ok(()) };
    let plain = filters_path();
    if !plain.exists() || filters_enc_path().exists() {
        return Ok(());
    }
    let bytes = std::fs::read(&plain).map_err(|e| e.to_string())?;
    let data = parse_filters(&bytes);
    let json = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
    let sealed = mail_crypt::seal(&keys.field, &mail_crypt::filters_aad(), &json);
    mail_crypt::write_bytes_atomic(&filters_enc_path(), &sealed)?;
    let _ = std::fs::remove_file(&plain);
    Ok(())
}

/// The enabled rules, or an empty list if the file cannot be read.
///
/// **A failure here must never fail a sync.** The rules are an enhancement to
/// mail arriving; a locked keyring or a corrupt file means mail lands unmarked,
/// which is the state every install starts in, not an error worth aborting a
/// fetch for.
fn active_rules() -> Vec<MailFilterRule> {
    read_filters(&filters_path())
        .map(|f| f.rules.into_iter().filter(|r| r.enabled).collect())
        .unwrap_or_default()
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

// ── Authentication-Results trust ────────────────────────────────────────────

/// Apply each header's account's trusted `authserv-id` to its stored
/// `Authentication-Results`.
///
/// **Every** path that hands a `MailHeader` to the frontend goes through here.
/// The store deliberately persists the parsed data in its `Unconfigured` state,
/// so this is where a verdict becomes believable — which means configuring or
/// clearing the id re-judges mail that was synced long before, and a row that
/// somehow skipped this step shows no verdict rather than an unchecked one.
///
/// A missing accounts file, or a header whose account is gone, leaves every
/// verdict unconfigured: failing to *find* the trusted id must never read as
/// having *matched* it.
fn serve_auth_state(headers: &mut [MailHeader]) {
    let accounts = read_accounts(&accounts_path()).unwrap_or_default().accounts;
    apply_auth_trust(headers, &accounts);
}

/// [`serve_auth_state`] with the account list injected, so the rule can be
/// tested without a state directory.
fn apply_auth_trust(headers: &mut [MailHeader], accounts: &[MailAccount]) {
    for h in headers.iter_mut() {
        let Some(auth) = h.auth.as_mut() else { continue };
        let trusted = accounts
            .iter()
            .find(|a| a.id == h.account_id)
            .and_then(|a| a.authserv_id.as_deref());
        mail_authres::apply_trust(auth, trusted);
    }
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

/// The password this session is already authenticating `account_id` with, if any.
///
/// The typed field is only ever *one* of the two places a live password lives:
/// the other is the in-memory map, which is where "save it for the session only"
/// puts it. Ticking Save later has to be able to reach it, or the tick means
/// "retype it or lose it" — see [`mail_account_upsert`].
fn session_secret(state: &MailState, account_id: &str) -> Option<String> {
    let rt = state.lock().ok()?;
    let pw = rt.passwords.get(account_id)?;
    (!pw.is_empty()).then(|| pw.expose().to_string())
}

/// What to report when Save was ticked but there was **no secret to write**.
///
/// `None` means "nothing to say": an entry is already there, so the tick is
/// satisfied and the blank field simply meant "leave it alone". Otherwise the
/// reason has to be said out loud — a bare `saved: false` with no error renders
/// as a box that quietly unticks itself, which is indistinguishable from the
/// feature being broken.
fn blank_save_error(already_saved: bool, store_readable: bool) -> Option<String> {
    if already_saved {
        return None;
    }
    Some(if store_readable {
        "no password to save — type it in the password field, then save again".into()
    } else {
        "the OS keyring is locked, so nothing was saved — unlock it and try again".into()
    })
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
///
/// **A tick with a blank password field still saves.** The password field is
/// deliberately never pre-filled, so the common way to reach this command with
/// Save ticked is a *second* visit to the dialog — at which point the only live
/// copy of the secret is the session map. Passing the blank field straight to
/// `remember_secret` made Save mean `Remember::Save` with no secret, which is a
/// **clear**: it deleted the entry and reported `saved: false` with no error,
/// which is exactly what "saving the mail password does not work" looks like
/// from the outside. The secret is resolved first (typed → session), and a
/// genuinely empty one leaves the keychain alone and says why.
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
        // A pooled IMAP session is an *authenticated* socket, and these are the
        // settings it was authenticated with. Evict on both sides of the write:
        // either the old server tuple or the new one may be the key holding a
        // live connection, and leaving one behind means the next read silently
        // uses the login the user just replaced.
        if let Ok(previous) = account_by_id(&accounts_path(), &account.id) {
            mail_engine::forget_pooled_sessions(&previous.imap);
        }
        let mut account = upsert_account_at(&accounts_path(), account)?;
        mail_engine::forget_pooled_sessions(&account.imap);

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
            // The secret to write is the typed one, else the one this session is
            // already authenticating with. It is **never** `None`:
            // `remember_secret`'s Save branch reads an absent secret as a *clear*
            // (which is what OpenVPN wants for a stale key passphrase), so a
            // ticked box over an empty field used to delete the very entry the
            // user was asking to keep — and report `saved: false` with no error,
            // i.e. "Save password does nothing". `ssh_connect` has always
            // resolved its `effective` secret before remembering; this is that.
            let effective = secret.clone().or_else(|| session_secret(&rt, &account.id));
            // A key needs a host to mean anything. An account with no SMTP server
            // configured must not put `mail:smtp:@:0` in the keychain.
            let keys: Vec<String> = [
                (!account.imap.host.trim().is_empty()).then(|| imap_key(&account)),
                (!account.smtp.host.trim().is_empty()).then(|| smtp_key(&account)),
            ]
            .into_iter()
            .flatten()
            .collect();
            match &effective {
                Some(effective) => {
                    for key in &keys {
                        let outcome = remote_credentials::remember_secret(
                            key,
                            remember,
                            Some(effective.as_str()),
                        );
                        saved |= outcome.saved;
                        if error.is_none() {
                            error = outcome.error;
                        }
                    }
                }
                // Nothing to write — and nothing to clear either. Whatever is in
                // the keychain stays there (this is the pre-ticked box being
                // re-saved), and the state is reported rather than implied.
                None => {
                    saved = keys.first().is_some_and(|k| remote_credentials::has(k));
                    error = blank_save_error(saved, remote_credentials::store_readable());
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

// ── Encryption at rest ──────────────────────────────────────────────────────

/// Everything the UI needs to describe the store's encryption, in one read.
///
/// One command rather than several because the answers have to agree: "is it
/// enabled" and "is the open store actually sealed" are different questions with
/// a meaningful gap between them, and two round trips could observe that gap at
/// two different moments and render a contradiction.
#[tauri::command]
pub async fn mail_encryption_state(
    state: State<'_, MailState>,
) -> Result<MailEncryptionState, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || encryption_state(&rt))
        .await
        .map_err(|e| e.to_string())?
}

/// The blocking half of [`mail_encryption_state`], so the commands that *change*
/// the state can report the result without re-entering a `#[tauri::command]`.
fn encryption_state(rt: &MailState) -> Result<MailEncryptionState, String> {
    {
        // Opening the store is what resolves the unlock, so the report cannot be
        // produced without it. Failing to open is itself an answer, not an
        // error to propagate — the dialog still has to render.
        let store = store_of(rt).ok();
        let note = rt.lock().ok().and_then(|g| g.unlock_note.clone());
        let dir = mail_dir();
        let file = mail_crypt::read_key_file(&dir).ok().flatten();
        Ok(MailEncryptionState {
            enabled: file.is_some(),
            active: store.as_ref().map(|s| s.is_encrypted()).unwrap_or(false),
            mode: file.as_ref().map(|f| match f.mode {
                mail_crypt::UnlockMode::Keychain => "keychain".to_string(),
                mail_crypt::UnlockMode::Passphrase => "passphrase".to_string(),
            }),
            ephemeral: note.is_some(),
            reason: match &note {
                Some(UnlockNote::Unavailable(why)) => Some(why.clone()),
                _ => None,
            },
            needs_passphrase: matches!(note, Some(UnlockNote::NeedsPassphrase)),
            preference: read_settings().mail_encrypt_store,
            has_existing_mail: dir.join("mail.db").exists(),
            keyring: keyring_state_for_ui(),
        })
    }
}

/// Turn encryption on, migrating whatever is already in the store.
///
/// `mode` is `"keychain"` (silent, the recommended default) or `"passphrase"`.
/// The migration itself is [`MailStore::seal_existing`] — idempotent, so an
/// interrupted run finishes on the next open — and it ends by rewriting the
/// database into a fresh file, because `UPDATE`-ing values in place leaves every
/// old plaintext in the WAL and the freelist.
///
/// The honest caveat, which the UI states beside the button: on an SSD or a
/// copy-on-write filesystem, deleting the old file is not erasure.
/// [`mail_encryption_reset`] is the option for anyone who actually cares.
#[tauri::command]
pub async fn mail_encryption_enable(
    mode: String,
    passphrase: Option<String>,
    state: State<'_, MailState>,
) -> Result<MailEncryptionState, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let dir = mail_dir();
        let keys = match mode.as_str() {
            "passphrase" => {
                let pass = passphrase.unwrap_or_default();
                mail_crypt::enable_with_passphrase(&dir, &pass)?
            }
            "keychain" => mail_crypt::enable_with_keychain(&dir)?,
            other => return Err(format!("unknown unlock mode '{other}'")),
        };
        adopt_keys(&rt, &dir, Arc::new(keys))?;
        set_encrypt_preference(Some(true));
        encryption_state(&rt)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a passphrase-protected store that is currently showing its memory-only
/// stand-in.
#[tauri::command]
pub async fn mail_encryption_unlock(
    passphrase: String,
    state: State<'_, MailState>,
) -> Result<MailEncryptionState, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let dir = mail_dir();
        let keys = mail_crypt::unlock_with_passphrase(&dir, &passphrase)?;
        adopt_keys(&rt, &dir, Arc::new(keys))?;
        encryption_state(&rt)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Record that the user does not want the local store encrypted, so the one-time
/// prompt stops asking.
#[tauri::command]
pub async fn mail_encryption_decline() -> Result<(), String> {
    tokio::task::spawn_blocking(|| set_encrypt_preference(Some(false)))
        .await
        .map_err(|e| e.to_string())
}

/// Delete the local mail and start again, encrypted.
///
/// The **honest** alternative to migrating, and the right recommendation for
/// anyone who cares about the plaintext that is already on disk: a migration
/// cannot reliably erase what it replaces, while this never produces a second
/// copy at all. Everything here is a cache with an authoritative copy on the
/// server — the one exception is drafts, which is why the UI says so before it
/// offers the button.
#[tauri::command]
pub async fn mail_encryption_reset(
    mode: String,
    passphrase: Option<String>,
    state: State<'_, MailState>,
) -> Result<MailEncryptionState, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let dir = mail_dir();
        // Drop the open handle first: on Windows a live SQLite connection holds
        // the file open and the removal below would fail rather than delete.
        if let Ok(mut guard) = rt.lock() {
            guard.store = None;
            guard.unlock_note = None;
        }
        set_session_keys(None);
        mail_crypt::forget(&dir)?;
        for name in ["mail.db", "mail.db-wal", "mail.db-shm", "accounts.json.enc"] {
            let _ = std::fs::remove_file(dir.join(name));
        }
        let _ = std::fs::remove_dir_all(dir.join("blobs"));
        let _ = std::fs::remove_dir_all(dir.join("outbox"));
        // `accounts.json` deliberately survives: the account *list* is
        // configuration, not cached mail, and wiping it would make "start over"
        // mean "set up your mail from scratch".
        let keys = match mode.as_str() {
            "passphrase" => {
                mail_crypt::enable_with_passphrase(&dir, &passphrase.unwrap_or_default())?
            }
            "keychain" => mail_crypt::enable_with_keychain(&dir)?,
            other => return Err(format!("unknown unlock mode '{other}'")),
        };
        adopt_keys(&rt, &dir, Arc::new(keys))?;
        set_encrypt_preference(Some(true));
        encryption_state(&rt)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reopen the store under `keys` and publish them for the session.
fn adopt_keys(rt: &MailState, dir: &Path, keys: Arc<MailKeys>) -> Result<(), String> {
    // Released before the (possibly long) migration so nothing else blocks on
    // the runtime lock while a database is being rewritten.
    if let Ok(mut guard) = rt.lock() {
        guard.store = None;
    }
    let store = Arc::new(MailStore::open_with_keys(dir, Some(keys.clone()))?);
    set_session_keys(Some(keys.clone()));
    migrate_accounts_file(Some(&keys))?;
    migrate_filters_file(Some(&keys))?;
    let mut guard = rt.lock().map_err(|_| "mail state is poisoned")?;
    guard.store = Some(store);
    guard.unlock_note = None;
    Ok(())
}

// ── OpenPGP keys ────────────────────────────────────────────────────────────

/// Whether the OpenPGP surface can be used at all.
///
/// One bool the UI gates on, rather than letting every key command fail with the
/// same sentence: the keyring needs an encrypted store, and a settings panel
/// that offers key management it cannot deliver is a worse experience than one
/// that explains the precondition.
#[tauri::command]
pub async fn mail_pgp_available(state: State<'_, MailState>) -> Result<bool, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || Ok(keyring_of(&rt).is_ok()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mail_pgp_keys(state: State<'_, MailState>) -> Result<Vec<PgpKeyInfo>, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || keyring_of(&rt)?.list())
        .await
        .map_err(|e| e.to_string())?
}

/// Generate this account's key. Curve25519, always — see `services::mail_pgp`.
///
/// Key generation is CPU work and runs in `spawn_blocking` like everything else
/// here; a synchronous command would freeze the window for its duration.
#[tauri::command]
pub async fn mail_pgp_generate(
    account_id: String,
    name: String,
    address: String,
    state: State<'_, MailState>,
) -> Result<PgpKeyInfo, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || keyring_of(&rt)?.generate(&name, &address, &account_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Import a key from **pasted text**, never a path.
///
/// The path-free rule this file is built on (`no_command_takes_a_path`) applies
/// here too, and it costs nothing: an armored key is text, so pasting it is the
/// natural gesture anyway. [`mail_pgp_import_pick`] covers the file case by
/// raising the OS dialog inside Rust, exactly as attachments do.
#[tauri::command]
pub async fn mail_pgp_import(
    armored: String,
    state: State<'_, MailState>,
) -> Result<Vec<PgpKeyInfo>, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || keyring_of(&rt)?.import(armored.as_bytes()))
        .await
        .map_err(|e| e.to_string())?
}

/// Import a key from a file the user picks in the **OS dialog raised by Rust**.
///
/// The same shape as `mail_attach_pick`: the dialog runs in the backend and the
/// frontend never sees or supplies a path, and the picker is the async one
/// bridged to a `oneshot` — the blocking variants would freeze the main thread,
/// which is rule 1 of this module and which `the_dialogs_are_never_raised_with_
/// the_blocking_api` enforces by scanning this very file (so it must not be
/// named here either).
#[tauri::command]
pub async fn mail_pgp_import_pick(
    app: AppHandle,
    state: State<'_, MailState>,
) -> Result<Vec<PgpKeyInfo>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("OpenPGP key", &["asc", "gpg", "pgp", "key"])
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(Vec::new());
    };
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let path = picked
            .into_path()
            .map_err(|e| format!("could not read that file: {e}"))?;
        // A key file is small; anything huge is not one, and reading it would be
        // the only unbounded read in the mail subsystem.
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > 1024 * 1024 {
            return Err("that file is too large to be an OpenPGP key".into());
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        keyring_of(&rt)?.import(&bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The armored **public** half, to send to a correspondent. There is no command
/// that exports a private key, and that is not an omission.
#[tauri::command]
pub async fn mail_pgp_export(
    fingerprint: String,
    state: State<'_, MailState>,
) -> Result<String, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || keyring_of(&rt)?.export_public(&fingerprint))
        .await
        .map_err(|e| e.to_string())?
}

/// Record that the user compared this fingerprint out of band.
///
/// The only path to `MailCryptoState::Verified`, and therefore the only way any
/// message ever earns positive chrome. There is no heuristic that can stand in
/// for it, because OpenPGP has no authority to ask.
#[tauri::command]
pub async fn mail_pgp_set_verified(
    fingerprint: String,
    verified: bool,
    state: State<'_, MailState>,
) -> Result<PgpKeyInfo, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || keyring_of(&rt)?.set_verified(&fingerprint, verified))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mail_pgp_bind(
    fingerprint: String,
    account_id: String,
    bind: bool,
    state: State<'_, MailState>,
) -> Result<(), String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || keyring_of(&rt)?.bind_account(&fingerprint, &account_id, bind))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mail_pgp_delete(
    fingerprint: String,
    state: State<'_, MailState>,
) -> Result<(), String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || keyring_of(&rt)?.delete(&fingerprint))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether every recipient of a draft has a key, so the composer can enable or
/// explain the Encrypt control **before** the user writes the message.
///
/// Asked up front rather than discovered on Send, because finding out at that
/// moment means either a refused send or — far worse — a silent downgrade.
#[tauri::command]
pub async fn mail_pgp_recipients_ready(
    account_id: String,
    recipients: Vec<String>,
    state: State<'_, MailState>,
) -> Result<Vec<String>, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let ring = keyring_of(&rt)?;
        if ring.secret_for_account(&account_id)?.is_none() {
            return Err("this account has no OpenPGP key".into());
        }
        let mut missing = Vec::new();
        for address in recipients {
            if ring.public_for_address(&address)?.is_none() {
                missing.push(address);
            }
        }
        Ok(missing)
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
        // Read before the delete: after it there is nothing left to name the
        // server whose pooled connection is still open and logged in.
        if let Ok(account) = account_by_id(&accounts_path(), &account_id) {
            mail_engine::forget_pooled_sessions(&account.imap);
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
        // Forgetting the password has to close the connection it opened, or the
        // mailbox keeps reading over an authenticated socket the user believes
        // they just revoked — an already-open session outlives the credential.
        mail_engine::forget_pooled_sessions(&account.imap);
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
/// Never dispatched from a launch or restore path: the mail overlay renders from
/// the local store and shows a **Check mail** button.
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

    // The user's keyword rules, read ONCE for the whole sync rather than per
    // folder: it is a file read (and a decrypt), and an edit made while a sync is
    // running should not have half this fetch judged by the old list and half by
    // the new one. A failure to read them is not a failure to sync — see
    // `active_rules`.
    let rules = active_rules();

    let mut new_messages = 0u32;
    let mut filtered = 0u32;
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
        // The rules apply to mail that *arrives*, so Sent and Drafts are out —
        // a rule watching for "invoice" must not file the invoices the user
        // wrote — as are Trash and Junk, where a message has already been
        // judged. Same list as `MailStore::unmarked_headers`, for the same
        // reason: the live path and the re-run must agree about scope, or a
        // "apply to existing mail" would file things the sync never would.
        let rules2: Vec<MailFilterRule> = if matches!(
            folder2.kind,
            MailFolderKind::Sent
                | MailFolderKind::Drafts
                | MailFolderKind::Trash
                | MailFolderKind::Junk
        ) {
            Vec::new()
        } else {
            rules.clone()
        };
        let (added, filed): (u32, u32) = tokio::task::spawn_blocking(move || {
            let mut added = 0u32;
            let mut filed = 0u32;
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
                    // Stored as parsed, i.e. `Unconfigured`. `serve_auth_state`
                    // applies the account's trusted `authserv-id` on the way
                    // out, so the setting governs already-synced mail too.
                    auth: h.headers.auth,
                    // Always `None` here, and it never reaches the column:
                    // `upsert_header` writes `priority` in neither half of its
                    // statement precisely so this loop — which runs over every
                    // message in the folder on every check — cannot wipe a mark
                    // the user made. The mark is the user's, not the server's.
                    priority: None,
                };
                if store3.upsert_header(&row)? {
                    added += 1;
                    // **New messages only.** A re-sync re-visits every message
                    // in the folder, so applying rules to all of them would
                    // re-file mail the user had unmarked by hand, every check —
                    // `mark_for` refuses an already-marked message, but an
                    // *unmarked* one the user deliberately cleared looks
                    // identical to one that never matched. The user's own
                    // decision is only safe if the automatic pass happens once.
                    if let Some((mark, _hit)) = mail_filters::mark_for(&rules2, &row) {
                        if store3.set_priority(&row.id, Some(mark))? {
                            filed += 1;
                        }
                    }
                }
            }
            store3.refresh_counts(&folder2.id)?;
            Ok::<_, String>((added, filed))
        })
        .await
        .map_err(|e| e.to_string())??;

        filtered += filed;
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
        filtered,
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
///
/// `sort`/`desc` are optional so an older frontend keeps the newest-first order
/// it used to get; they are a `MailSort`, never a column name, because the order
/// is the one part of the statement SQLite cannot take as a bound parameter.
#[tauri::command]
pub async fn mail_headers(
    folder_id: String,
    offset: u32,
    limit: u32,
    query: Option<String>,
    sort: Option<MailSort>,
    desc: Option<bool>,
    state: State<'_, MailState>,
) -> Result<MailHeaderPage, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let store = store_of(&rt)?;
        let mut page = store.headers_page(
            &folder_id,
            offset,
            limit,
            query.as_deref(),
            sort.unwrap_or_default(),
            desc.unwrap_or(true),
        )?;
        serve_auth_state(&mut page.items);
        Ok(page)
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
            // A cached body is never an end-to-end one: `cache_body` is not
            // called for those (see below), so a cache hit is proof this
            // message was ordinary mail.
            crypto: None,
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
    let rt4 = rt.clone();
    let from_address = header.from.address.clone();
    tokio::task::spawn_blocking(move || {
        // Decrypt FIRST, then parse, then sanitize, then render. The ordering is
        // the plan's one non-negotiable: decryption confers no trust, so the
        // plaintext goes through the same structural caps and the same sanitizer
        // as anything the server handed us in the clear.
        let (raw, crypto) = apply_crypto(&rt4, raw, &from_address);
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

        // **Decrypted plaintext is never written to disk.** Not to
        // `bodies_cache`, not to a blob, not to `preview`. If it were, the store
        // key would become cryptographically equivalent to the mail private key
        // and the end-to-end guarantee would collapse into the at-rest one — a
        // message you can only read with your PGP key would become a message
        // anyone holding the store key can read. So an encrypted message is
        // re-fetched and re-decrypted on every open, which is the cost of the
        // guarantee and is measured in milliseconds.
        let decrypted = crypto.as_ref().is_some_and(|c| c.decrypted);
        if !decrypted {
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
        }

        Ok(MailBody {
            id,
            html,
            text: parsed.text,
            remote_refs,
            links,
            attachments,
            truncated: truncated.then_some(true),
            crypto,
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

/// Mark every unread message in a folder read, locally **and** on the server.
/// Returns how many rows changed.
///
/// It exists because the per-message command cannot stand in for it at any
/// honest cost: 200 unread messages would be 200 `mail_flag` calls, i.e. 200
/// IMAP logins, which is slower than the sync that fetched them and is what a
/// connection-rate limit exists to refuse. Here it is one login, one SELECT and
/// (almost always) one STORE.
///
/// The local index is written **first**, exactly as `mail_flag` does and for the
/// same reason — the UI must not sit on a round trip — and a server refusal is
/// reported rather than swallowed. The divergence that leaves is self-healing in
/// this one direction: `upsert_header` takes `seen` from the server on every
/// sync, so a mark that never reached the server comes back unread at the next
/// check rather than staying wrong forever. That is the safe way round; the
/// opposite (server-first) would leave the user staring at an unchanged list
/// while the connection times out.
#[tauri::command]
pub async fn mail_mark_folder_read(
    folder_id: String,
    state: State<'_, MailState>,
) -> Result<u32, String> {
    let rt = state.inner().clone();
    let rt2 = rt.clone();
    let id = folder_id.clone();
    // The UIDs are read *before* the local flip: afterwards there is nothing
    // unread left to find and the operation would silently become local-only.
    let (account, folder, uids, store) = tokio::task::spawn_blocking(move || {
        let store = store_of(&rt2)?;
        let folder = store
            .folder(&id)?
            .ok_or_else(|| format!("folder '{id}' is not in the local index"))?;
        let account = account_by_id(&accounts_path(), &folder.account_id)?;
        let uids = store.unseen_uids(&id)?;
        Ok::<_, String>((account, folder, uids, store))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Nothing unread is not an error and must not cost a login.
    if uids.is_empty() {
        return Ok(0);
    }

    let id = folder_id.clone();
    let changed = tokio::task::spawn_blocking(move || {
        let changed = store.mark_folder_seen(&id)?;
        store.refresh_counts(&id)?;
        Ok::<_, String>(changed)
    })
    .await
    .map_err(|e| e.to_string())??;

    let Some(pw) = resolve_password(&rt, &account, MailProto::Imap) else {
        return Err(no_password_message());
    };
    InProcessEngine
        // Via the enum, never the literal: one spelling of `\Seen` in the
        // codebase, and it is the one the per-message path already uses.
        .set_flags_bulk(&account, &pw, &folder.path, &uids, MailFlag::Seen.imap_flag(), true)
        .await
        .map_err(String::from)?;
    Ok(changed)
}

// ── Commands: priority marks (Important / Urgent) ───────────────────────────
//
// The one part of the mail surface that **never touches the network**, in either
// direction, and that is not an oversight — it is what the feature is.
//
// Important and Urgent are lists that span *every account*. No IMAP folder can
// hold mail from two accounts, so the instant the list is cross-account the only
// thing that can implement it is a local column; a real server-side move would
// need one folder per account, a round trip per mark, and would mint new UIDs —
// invalidating every cached body, attachment row and store key for the message,
// and leaving a half-applied state whenever one account's server said no. See
// `schema::mail::MailPriority` for the full statement, including the honest
// cost: a mark is this machine's and is invisible to any other mail client.

/// Set — or with `priority: None`, clear — one message's local priority mark.
///
/// Local only: no login, no STORE, no COPY. It returns whether a row actually
/// changed, so the frontend can tell "marked" from "that message is no longer in
/// the index" rather than reporting a silent success either way.
#[tauri::command]
pub async fn mail_priority_set(
    message_id: String,
    priority: Option<MailPriority>,
    state: State<'_, MailState>,
) -> Result<bool, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || store_of(&rt)?.set_priority(&message_id, priority))
        .await
        .map_err(|e| e.to_string())?
}

/// One page of everything carrying `priority`, across every account and folder.
///
/// Deliberately the twin of [`mail_headers`] — same paging, same optional query,
/// same `MailSort`-not-a-column-name rule — so the Important list behaves like a
/// folder and the frontend keeps one list component. `serve_auth_state` runs
/// here too: a cross-account list is exactly where an unchecked SPF/DKIM verdict
/// would be most misleading, since the reader is no longer looking at one
/// account's mail.
#[tauri::command]
pub async fn mail_priority_page(
    priority: MailPriority,
    offset: u32,
    limit: u32,
    query: Option<String>,
    sort: Option<MailSort>,
    desc: Option<bool>,
    state: State<'_, MailState>,
) -> Result<MailHeaderPage, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let store = store_of(&rt)?;
        let mut page = store.priority_page(
            priority,
            offset,
            limit,
            query.as_deref(),
            sort.unwrap_or_default(),
            desc.unwrap_or(true),
        )?;
        serve_auth_state(&mut page.items);
        Ok(page)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The two rail badges' numbers, read together so they cannot disagree.
#[tauri::command]
pub async fn mail_priority_counts(
    state: State<'_, MailState>,
) -> Result<MailPriorityCounts, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || store_of(&rt)?.priority_counts())
        .await
        .map_err(|e| e.to_string())?
}

// ── Commands: filter rules (keywords → a priority mark) ─────────────────────
//
// The automation on top of the marks above, and it inherits every one of their
// properties because it *is* them: a rule sets the same local column the
// right-click menu sets. No socket, no IMAP flag, nothing leaves the folder it
// arrived in — so there is no rule anyone can write here that has an effect on a
// server, and none that can be wrong in a way another mail client would see.
//
// Two deliberate limits, both surfaced in the UI rather than hidden:
//
// - Rules run on **newly arrived** messages during a sync, and on demand over
//   mail already in the index. They are not a background pass; nothing here ever
//   re-examines a message the user has filed by hand.
// - They match the stored header plus the body **snippet**. The full body is not
//   on this machine until the message is opened (`services::mail_filters`).

/// Every rule, in order. Local read; no network, and no database.
///
/// The rule file is sealed under the store's key, and `read_filters` resolves
/// that key itself (`file_keys`) rather than relying on some other command
/// having opened the database first — the ordering bug that made an encrypted
/// install's *account* list read empty at launch is described in full there.
#[tauri::command]
pub async fn mail_filters_list() -> Result<Vec<MailFilterRule>, String> {
    tokio::task::spawn_blocking(|| Ok(read_filters(&filters_path())?.rules))
        .await
        .map_err(|e| e.to_string())?
}

/// Replace the whole rule list.
///
/// Wholesale rather than an upsert/delete pair, for the reason
/// `schema::mail::MailFilters` documents: **the order is data** (the first
/// matching rule wins), so a reorder is an ordinary edit that no per-rule verb
/// can express. Ids are minted here for rules that arrive without one — the
/// store owns identity, exactly as it does for an account.
#[tauri::command]
pub async fn mail_filters_set(rules: Vec<MailFilterRule>) -> Result<Vec<MailFilterRule>, String> {
    tokio::task::spawn_blocking(move || {
        let mut rules = rules;
        for rule in rules.iter_mut() {
            if rule.id.trim().is_empty() {
                rule.id = uuid_v4();
            }
            // Trimmed once, here, so the matcher never has to wonder and the
            // dialog's "  invoice" is the same rule as "invoice".
            rule.terms = rule
                .terms
                .iter()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
        }
        let data = MailFilters {
            version: FILTERS_VERSION,
            rules: rules.clone(),
            extra: Default::default(),
        };
        write_filters(&filters_path(), &data)?;
        Ok(rules)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How many messages this many rules would (or did) file — the same command for
/// both, distinguished by `dry_run`.
///
/// One command rather than a preview and an apply, because the *only* honest
/// preview is the one the apply itself would produce: two code paths answering
/// "what will this catch" and "what did it catch" is how a filter dialog ends up
/// promising 3 and marking 40.
///
/// Bounded by `limit` over the newest unmarked mail (see
/// `MailStore::unmarked_headers` for the folder kinds it refuses and why), and
/// the bound is **reported** — `capped` is what lets the UI say *of the most
/// recent N* instead of implying the whole mailbox was considered.
#[tauri::command]
pub async fn mail_filters_apply(
    dry_run: bool,
    account_id: Option<String>,
    rules: Option<Vec<MailFilterRule>>,
    limit: Option<u32>,
    state: State<'_, MailState>,
) -> Result<MailFilterReport, String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        // An explicit list is the dialog testing a rule it has not saved yet;
        // otherwise the saved, enabled ones. A rule under test is honoured even
        // when disabled — "what would this catch" is asked *before* switching it
        // on, which is the whole point of asking.
        let rules = match rules {
            Some(list) => list,
            None => active_rules(),
        };
        let limit = limit.unwrap_or(2_000).clamp(1, 50_000);
        let store = store_of(&rt)?;
        let mut headers = store.unmarked_headers(account_id.as_deref(), limit)?;
        let scanned = headers.len() as u32;
        // The auth verdicts are not used by matching, but these rows are handed
        // back as samples and every path that shows a header must go through it.
        serve_auth_state(&mut headers);

        let mut report = MailFilterReport {
            scanned,
            dry_run,
            capped: (scanned >= limit).then_some(limit),
            ..Default::default()
        };
        for header in &headers {
            let Some((mark, hit)) = mail_filters::mark_for(&rules, header) else {
                continue;
            };
            report.matched += 1;
            if report.samples.len() < 25 {
                report.samples.push(MailFilterSample {
                    message_id: header.id.clone(),
                    subject: header.subject.clone(),
                    from: header.from.clone(),
                    date: header.date.clone(),
                    hit,
                });
            }
            if !dry_run && store.set_priority(&header.id, Some(mark))? {
                report.marked += 1;
            }
        }
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
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
    sign: bool,
    encrypt: bool,
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

        // Sign and/or encrypt, and **never silently fall back**. An encryption
        // feature that quietly sends in the clear when something goes wrong is
        // worse than no encryption at all, because it looks exactly like
        // success — so a missing recipient key, a locked keyring or a missing
        // own key all abort the send with a message naming the problem, and the
        // user decides what to do about it.
        let opts = SealOpts { sign, encrypt };
        let raw = if opts.any() {
            let ring = keyring_of(&rt2)?;
            // Bcc recipients must be encrypted to as well — a blind copy that
            // cannot be read is not a copy. They stay out of the *headers*
            // (that is what blind means) but they are in the envelope, so they
            // are in the key list.
            ring.seal_outgoing(&draft.account_id, &recipients, &raw, opts)?
        } else {
            raw
        };
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
            // The Sent copy (plan phase 8). **Exactly the bytes that were sent**
            // — which for an encrypted message is the encrypted-to-self form,
            // and that is the whole reason this is here rather than earlier:
            // adding APPEND without encrypt-to-self is precisely how a plaintext
            // Sent copy of an encrypted message ships. Before this existed there
            // was no Sent copy at all, which was accidentally the most private
            // behaviour available; adding one is a deliberate trade.
            //
            // Best effort, and deliberately so: a failed APPEND must not report
            // a failed *send*. The message is already delivered, and telling the
            // user otherwise is how a message gets sent twice.
            if let Some(sent) = sent_folder_for(&rt, &account).await {
                if let Err(e) = InProcessEngine.append(&account, &pw, &sent, &raw).await {
                    eprintln!("mail: could not file the sent copy: {e}");
                }
            }
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
        // `split_inclusive` keeps each line terminator, so the running offset is
        // exact for both LF and CRLF. `lines()` + `len() + 1` assumed a 1-byte
        // terminator and drifted one byte per line on a CRLF checkout (Windows),
        // eventually slicing into the middle of a multi-byte char in a comment.
        for chunk in src.split_inclusive('\n') {
            let line = chunk.trim_end_matches('\n').trim_end_matches('\r');
            if line.trim() == concat!("#[tauri", "::command]") {
                starts.push(offset + line.len());
            }
            offset += chunk.len();
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

    // ── The sealed-file key, and the write that must not happen ─────────────

    /// The regression this pins: an encrypted install whose account list read as
    /// **empty** because nothing had opened the database yet, and whose re-added
    /// account was then written in cleartext beside the sealed file that every
    /// later read preferred. `sealed_write_refusal` is the second half of the
    /// fix — the first (`file_keys`) cannot be unit-tested without a keyring.
    #[test]
    fn a_plaintext_write_is_refused_while_a_sealed_file_exists() {
        // Sealed file present, no key: the only safe answer is "not now".
        let refusal = sealed_write_refusal(true, false).expect("must refuse");
        assert!(
            refusal.contains("Nothing was changed"),
            "the refusal has to say the write did not happen: {refusal}"
        );
        // Every other combination is an ordinary write.
        assert!(sealed_write_refusal(true, true).is_none(), "we hold the key");
        assert!(
            sealed_write_refusal(false, false).is_none(),
            "an unencrypted store writes plaintext by design"
        );
        assert!(sealed_write_refusal(false, true).is_none());
    }

    /// The account list is what a launch reads first, so it must not depend on
    /// something else having opened the database. Guarded structurally, because
    /// the failure is invisible in a plain-store test: `read_accounts` must go
    /// through `file_keys`, never `session_keys`.
    #[test]
    fn the_sealed_files_resolve_their_own_key() {
        let src = include_str!("mail.rs");
        for reader in ["fn read_accounts", "fn read_filters"] {
            let start = src.find(reader).expect(reader);
            let body = &src[start..start + 900];
            assert!(
                body.contains("file_keys()"),
                "{reader} must resolve the key itself"
            );
            assert!(
                !body.contains("session_keys()"),
                "{reader} must not depend on the database having been opened"
            );
        }
    }

    // ── filters.json ────────────────────────────────────────────────────────

    #[test]
    fn a_missing_filters_file_is_an_empty_list() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("filters.json");
        let f = read_filters(&path).unwrap();
        assert!(f.rules.is_empty());
        assert_eq!(f.version, FILTERS_VERSION);
    }

    #[test]
    fn a_rule_this_build_cannot_understand_is_dropped_not_guessed_at() {
        // The `fields` value is one a future version added. Reading it as "some
        // field" would file mail by a condition nobody wrote, so the rule goes
        // and its neighbours stay.
        let raw = br#"{
            "version": 1,
            "rules": [
              {"id":"a","name":"Known","terms":["invoice"],"fields":["subject"],"mark":"urgent"},
              {"id":"b","name":"Future","terms":["x"],"fields":["attachment_name"],"mark":"urgent"},
              {"id":"c","name":"Also known","terms":["y"],"fields":["sender"],"mark":"important"}
            ]
        }"#;
        let parsed = parse_filters(raw);
        let ids: Vec<&str> = parsed.rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "c"]);
    }

    #[test]
    fn a_corrupt_filters_file_reads_as_no_rules_rather_than_failing_the_mailbox() {
        let parsed = parse_filters(b"this is not json");
        assert!(parsed.rules.is_empty());
        assert_eq!(parsed.version, FILTERS_VERSION);
    }

    #[test]
    fn a_rule_defaults_to_enabled_and_to_any_term() {
        let parsed = parse_filters(
            br#"{"rules":[{"id":"a","name":"n","terms":["x"],"fields":["subject"],"mark":"urgent"}]}"#,
        );
        let r = &parsed.rules[0];
        assert!(r.enabled, "a saved rule with no flag is an active rule");
        assert!(!r.match_all);
        assert!(!r.whole_word);
        assert!(r.account_id.is_none(), "every account by default");
    }

    #[test]
    fn the_rule_list_round_trips_through_the_file_in_order() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("filters.json");
        let rules = vec![
            MailFilterRule {
                id: "one".into(),
                name: "Urgent".into(),
                terms: vec!["outage".into()],
                fields: vec![crate::schema::mail::MailFilterField::Subject],
                mark: MailPriority::Urgent,
                match_all: false,
                whole_word: false,
                account_id: None,
                enabled: true,
                extra: Default::default(),
            },
            MailFilterRule {
                id: "two".into(),
                name: "Billing".into(),
                terms: vec!["invoice".into()],
                fields: vec![crate::schema::mail::MailFilterField::Sender],
                mark: MailPriority::Important,
                match_all: false,
                whole_word: false,
                account_id: Some("acct".into()),
                enabled: false,
                extra: Default::default(),
            },
        ];
        write_filters(
            &path,
            &MailFilters {
                version: FILTERS_VERSION,
                rules: rules.clone(),
                extra: Default::default(),
            },
        )
        .unwrap();
        let back = read_filters(&path).unwrap();
        assert_eq!(back.rules, rules, "order and every flag survive");
    }

    // ── Authentication-Results trust, applied at the serve boundary ─────────

    fn header_with_auth(account_id: &str, authserv: &str) -> MailHeader {
        let auth = mail_authres::parse_authentication_results(
            &[format!("{authserv}; dmarc=pass header.from=bank.example")],
            "security@bank.example",
        )
        .unwrap();
        MailHeader {
            id: "m1".into(),
            account_id: account_id.into(),
            folder_id: "f1".into(),
            uid: 1,
            rfc_message_id: None,
            subject: String::new(),
            from: Default::default(),
            to: Vec::new(),
            cc: Vec::new(),
            date: String::new(),
            seen: false,
            flagged: false,
            answered: false,
            has_attachments: false,
            size: 0,
            preview: String::new(),
            malformed_headers: None,
            auth: Some(auth),
            priority: None,
        }
    }

    fn account_with_authserv(id: &str, authserv: Option<&str>) -> MailAccount {
        MailAccount {
            id: id.into(),
            authserv_id: authserv.map(str::to_string),
            ..account("A")
        }
    }

    #[test]
    fn a_matching_authserv_id_is_the_only_thing_that_shows_a_verdict() {
        let mut headers = [header_with_auth("acc1", "mx.example.net")];
        apply_auth_trust(
            &mut headers,
            &[account_with_authserv("acc1", Some("mx.example.net"))],
        );
        let auth = headers[0].auth.as_ref().unwrap();
        assert_eq!(auth.state, crate::schema::mail::MailAuthState::Verified);
        assert_eq!(auth.methods.len(), 1);
    }

    #[test]
    fn an_account_with_no_configured_id_shows_no_verdict() {
        let mut headers = [header_with_auth("acc1", "mx.example.net")];
        apply_auth_trust(&mut headers, &[account_with_authserv("acc1", None)]);
        let auth = headers[0].auth.as_ref().unwrap();
        assert_eq!(auth.state, crate::schema::mail::MailAuthState::Unconfigured);
        assert!(auth.methods.is_empty());
    }

    /// Failing to *find* the account must never read as having *matched* it —
    /// otherwise a deleted account would silently promote every stored header
    /// to whatever the message claimed.
    #[test]
    fn a_header_whose_account_is_gone_shows_no_verdict() {
        let mut headers = [header_with_auth("acc-deleted", "mx.example.net")];
        apply_auth_trust(
            &mut headers,
            &[account_with_authserv("acc1", Some("mx.example.net"))],
        );
        let auth = headers[0].auth.as_ref().unwrap();
        assert_eq!(auth.state, crate::schema::mail::MailAuthState::Unconfigured);
        assert!(auth.methods.is_empty());
    }

    #[test]
    fn a_header_from_a_server_the_account_does_not_name_is_flagged_foreign() {
        let mut headers = [header_with_auth("acc1", "evil.example")];
        apply_auth_trust(
            &mut headers,
            &[account_with_authserv("acc1", Some("mx.example.net"))],
        );
        let auth = headers[0].auth.as_ref().unwrap();
        assert_eq!(auth.state, crate::schema::mail::MailAuthState::Foreign);
        assert!(auth.methods.is_empty());
        assert_eq!(auth.authserv_id.as_deref(), Some("evil.example"));
    }

    /// Each header is judged against **its own** account, not the first one.
    #[test]
    fn two_accounts_are_not_judged_by_each_others_settings() {
        let mut headers = [
            header_with_auth("acc1", "mx.one.example"),
            header_with_auth("acc2", "mx.one.example"),
        ];
        apply_auth_trust(
            &mut headers,
            &[
                account_with_authserv("acc1", Some("mx.one.example")),
                account_with_authserv("acc2", Some("mx.two.example")),
            ],
        );
        assert_eq!(
            headers[0].auth.as_ref().unwrap().state,
            crate::schema::mail::MailAuthState::Verified
        );
        assert_eq!(
            headers[1].auth.as_ref().unwrap().state,
            crate::schema::mail::MailAuthState::Foreign
        );
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

    /// The password field is never pre-filled, so a *second* visit to the dialog
    /// ticks Save with a blank field — and the live secret is then only in the
    /// session map. Reaching it is what makes the tick mean anything.
    #[test]
    fn a_ticked_save_reaches_the_session_password() {
        let state = new_state();
        assert_eq!(session_secret(&state, "acct"), None, "nothing yet");
        state
            .lock()
            .unwrap()
            .passwords
            .insert("acct".into(), Password::new("hunter2"));
        assert_eq!(session_secret(&state, "acct").as_deref(), Some("hunter2"));
        assert_eq!(session_secret(&state, "other"), None, "keyed per account");

        // An empty stashed password is not a password — writing it would store a
        // blank secret that then authenticates with nothing.
        state
            .lock()
            .unwrap()
            .passwords
            .insert("blank".into(), Password::new(""));
        assert_eq!(session_secret(&state, "blank"), None);
    }

    /// A tick with nothing to write must never be silent: `saved: false` and no
    /// error is a box that unticks itself for no stated reason.
    #[test]
    fn a_blank_save_reports_why_instead_of_clearing() {
        assert_eq!(
            blank_save_error(true, true),
            None,
            "already saved — the blank field meant leave it alone"
        );
        assert_eq!(
            blank_save_error(true, false),
            None,
            "unreadable is not absence; the entry is still there"
        );
        let typed = blank_save_error(false, true).expect("must say something");
        assert!(typed.contains("type it"), "{typed}");
        let locked = blank_save_error(false, false).expect("must say something");
        assert!(locked.contains("locked"), "{locked}");
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
