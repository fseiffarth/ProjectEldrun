//! CalDAV accounts — the command surface (`docs/caldav_plan.md`, Phases 1–2).
//!
//! Named to mirror the existing `mail_*`/`calendar_*` surfaces rather than
//! inventing a vocabulary: `caldav_accounts_list`, `caldav_account_upsert`,
//! `caldav_account_delete`, `caldav_password_state`, `caldav_forget_password`
//! are `commands::mail`'s account commands with a different store behind them,
//! down to `CalDavAccountSaved`'s `{account, saved, save_error}` — that shape is
//! the generic "what did the keychain actually do" answer, not a mail-specific
//! one.
//!
//! **A sync is two commands, not one**, and the seam is where the iCalendar
//! parser lives:
//!
//! 1. [`caldav_fetch`] does the protocol — ctag check, then either an
//!    incremental `sync-collection` or a full `calendar-query` — and hands back
//!    each resource's iCalendar text *unparsed*.
//! 2. The frontend runs that text through `src/lib/ics.ts`, the one parser here
//!    that understands folding, escaping, `RRULE` and `VALARM`.
//! 3. [`caldav_apply`] reconciles the parsed rows into `calendar.json` through
//!    `commands::calendar::merge_caldav_calendar_at` — one atomic write —
//!    and records the new ctag/sync-token.
//!
//! That is exactly the split `calendar_fetch_ics` + `calendar_replace_events`
//! already has, for the same reason: a second iCalendar parser in Rust would be
//! two implementations that can disagree about the same feed.
//!
//! **Credentials are not a fourth mechanism.** Same OS keychain, same
//! `services::remote_credentials`, same opt-in-default-off rule, same
//! `true | null` (never bare `false`) remember argument, same "unreadable is not
//! absence" tri-state the SSH and mail dialogs already share.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::State;

use crate::commands::projects::uuid_v4;
use crate::schema::calendar::CalendarData;
use crate::schema::caldav::{
    CalDavAccount, CalDavAccountSaved, CalDavAccounts, CalDavChanges, CalDavCollection,
    CalDavParsed, CalDavPasswordState, ACCOUNTS_VERSION,
};
use crate::services::caldav::{self, Credentials};
use crate::services::remote_credentials::{self, KeyringState};
use crate::storage;

// ── Managed state ───────────────────────────────────────────────────────────

/// Session-only passwords, for accounts the user chose **not** to persist.
///
/// Nothing here is ever serialized and it dies with the process — that is what
/// "not persisted by default" means operationally. Same shape as
/// `MailRuntime::passwords`.
#[derive(Default)]
pub struct CalDavRuntime {
    passwords: HashMap<String, String>,
}

pub type CalDavState = Arc<Mutex<CalDavRuntime>>;

// ── Store ───────────────────────────────────────────────────────────────────

pub fn caldav_dir() -> PathBuf {
    storage::state_dir().join("caldav")
}

fn accounts_path() -> PathBuf {
    caldav_dir().join("accounts.json")
}

fn read_accounts(path: &Path) -> Result<CalDavAccounts, String> {
    if !path.exists() {
        return Ok(CalDavAccounts {
            version: ACCOUNTS_VERSION,
            ..Default::default()
        });
    }
    storage::read_json(path).map_err(|e| e.to_string())
}

fn write_accounts(path: &Path, data: &CalDavAccounts) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    storage::write_json_atomic(path, data).map_err(|e| e.to_string())
}

/// Insert or replace one account, minting an id when the caller has none. The
/// store owns identity, exactly as `commands::calendar` does.
fn upsert_account_at(path: &Path, mut account: CalDavAccount) -> Result<CalDavAccount, String> {
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
        return Err(format!("CalDAV account '{id}' not found"));
    }
    write_accounts(path, &data)
}

fn account_by_id(path: &Path, id: &str) -> Result<CalDavAccount, String> {
    read_accounts(path)?
        .accounts
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("CalDAV account '{id}' not found"))
}

// ── Credentials ─────────────────────────────────────────────────────────────

/// The keychain account for a CalDAV login.
///
/// Keyed by **server target, not account id** — the rule `ssh_account` and
/// `mail_account` already hold to: one saved secret per login, so two Eldrun
/// accounts pointed at the same server share one entry instead of silently
/// disagreeing about whether a password is saved. The backend owns the
/// spelling; the frontend never mints one.
fn account_key(account: &CalDavAccount) -> String {
    remote_credentials::caldav_account(&account.user, &account.base_url)
}

/// The password to authenticate with: session map first, keychain second.
///
/// The keychain read goes through `remote_credentials::get`, which is bounded at
/// 4 s by `read_timed` **and** asks `cached_keyring_state()` before dispatching,
/// so a locked collection is never dispatched to. That is the locked-keyring
/// lesson inherited rather than reinvented.
fn resolve_password(rt: &CalDavState, account: &CalDavAccount) -> Option<String> {
    if let Ok(guard) = rt.lock() {
        if let Some(pw) = guard.passwords.get(&account.id) {
            if !pw.is_empty() {
                return Some(pw.clone());
            }
        }
    }
    remote_credentials::get(&account_key(account))
}

fn credentials(rt: &CalDavState, account: &CalDavAccount) -> Result<Credentials, String> {
    let password = resolve_password(rt, account).ok_or_else(|| {
        "no password available for this CalDAV account — open its settings and type one, or \
         unlock the OS keyring"
            .to_string()
    })?;
    Ok(Credentials {
        user: account.user.clone(),
        password,
    })
}

/// `Some(false)` is coerced to `None`.
///
/// The bug this closes is documented in `docs/context/remote_credentials.md`: a
/// checkbox seeded by an async keyring read, clicked before the read lands,
/// sends `false` and deletes the password it just authenticated with. Clearing
/// is only ever [`caldav_forget_password`], which is a verb of its own.
fn remember_arg(remember: Option<bool>) -> Option<bool> {
    remember.filter(|v| *v)
}

fn session_secret(rt: &CalDavState, account_id: &str) -> Option<String> {
    let guard = rt.lock().ok()?;
    let pw = guard.passwords.get(account_id)?;
    (!pw.is_empty()).then(|| pw.clone())
}

/// What to report when Save was ticked but there was no secret to write. `None`
/// means "nothing to say" — an entry is already there, so the blank field meant
/// "leave it alone". Otherwise the reason is said out loud, because a bare
/// `saved: false` renders as a box that unticks itself.
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
pub async fn caldav_accounts_list() -> Result<Vec<CalDavAccount>, String> {
    tokio::task::spawn_blocking(|| Ok(read_accounts(&accounts_path())?.accounts))
        .await
        .map_err(|e| e.to_string())?
}

/// Create or update an account, and apply the opt-in keychain write.
///
/// Returns what the keychain *actually did*. **A tick with a blank password
/// field still saves**: the field is never pre-filled, so the common way here
/// with Save ticked is a second visit to the dialog, at which point the only
/// live copy of the secret is the session map. Passing the blank field straight
/// to `remember_secret` would mean `Save` with no secret, which is a *clear* —
/// exactly what "saving the password does not work" looks like from outside.
#[tauri::command]
pub async fn caldav_account_upsert(
    account: CalDavAccount,
    password: Option<String>,
    remember: Option<bool>,
    state: State<'_, CalDavState>,
) -> Result<CalDavAccountSaved, String> {
    let rt = state.inner().clone();
    let remember = remember_arg(remember);
    tokio::task::spawn_blocking(move || {
        let mut account = upsert_account_at(&accounts_path(), account)?;

        // An empty password field means "use whatever is already there", never
        // "authenticate with nothing".
        let secret = password.filter(|p| !p.is_empty());
        if let Some(secret) = &secret {
            if let Ok(mut guard) = rt.lock() {
                guard.passwords.insert(account.id.clone(), secret.clone());
            }
        }

        let mut saved = false;
        let mut error: Option<String> = None;
        if remember == Some(true) {
            let effective = secret.clone().or_else(|| session_secret(&rt, &account.id));
            let key = account_key(&account);
            match &effective {
                Some(effective) => {
                    let outcome = remote_credentials::remember_secret(
                        &key,
                        remember,
                        Some(effective.as_str()),
                    );
                    saved = outcome.saved;
                    error = outcome.error;
                }
                // Nothing to write — and nothing to clear either. Whatever is in
                // the keychain stays; the state is reported rather than implied.
                None => {
                    saved = remote_credentials::has(&key);
                    error = blank_save_error(saved, remote_credentials::store_readable());
                }
            }
        }

        // Record what landed, never a hopeful `true` over a refused write.
        if account.save_password != saved && remember == Some(true) {
            account.save_password = saved;
            account = upsert_account_at(&accounts_path(), account)?;
        }

        Ok(CalDavAccountSaved {
            account,
            saved,
            save_error: error,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove the account. **The keychain entry is left alone** — it is keyed by
/// server target, so another account (or another app's saved login for the same
/// server) may still be using it. "Forget saved password" is the verb for that,
/// and it is a click of its own.
///
/// The synced calendars are left alone too: they are ordinary calendars in
/// `calendar.json` at this point, and silently deleting a month of appointments
/// because an account was removed is a surprise, not a cleanup. Deleting the
/// calendar is `delete_calendar`, which the sidebar already offers.
#[tauri::command]
pub async fn caldav_account_delete(
    account_id: String,
    state: State<'_, CalDavState>,
) -> Result<(), String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        if let Ok(mut guard) = rt.lock() {
            guard.passwords.remove(&account_id);
        }
        delete_account_at(&accounts_path(), &account_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn caldav_password_state(account_id: String) -> Result<CalDavPasswordState, String> {
    tokio::task::spawn_blocking(move || {
        let account = account_by_id(&accounts_path(), &account_id)?;
        let keyring = remote_credentials::keyring_state();
        // A locked keyring must read as "locked", never as "nothing saved" — the
        // UI shows an Unlock button rather than a silently empty checkbox.
        let has_saved = match keyring {
            KeyringState::Unlocked => remote_credentials::has(&account_key(&account)),
            _ => false,
        };
        Ok(CalDavPasswordState { has_saved, keyring })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The **only** path that deletes a saved CalDAV password.
#[tauri::command]
pub async fn caldav_forget_password(
    account_id: String,
    state: State<'_, CalDavState>,
) -> Result<(), String> {
    let rt = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut account = account_by_id(&accounts_path(), &account_id)?;
        // `remember_secret(Some(false), …)` refuses to clear an entry it could
        // not first read, so a locked keyring cannot destroy a password the user
        // still wants.
        let outcome = remote_credentials::remember_secret(&account_key(&account), Some(false), None);
        if let Ok(mut guard) = rt.lock() {
            guard.passwords.remove(&account_id);
        }
        account.save_password = false;
        upsert_account_at(&accounts_path(), account)?;
        match outcome.error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Commands: discovery ─────────────────────────────────────────────────────

/// Run the discovery chain once and return the calendar collections found.
///
/// The "Test connection" analogue of `mail_account_test`: **the password passed
/// here is never persisted by this call**, and a saved one is used when the
/// field was left blank (the usual second-visit case).
#[tauri::command]
pub async fn caldav_discover(
    base_url: String,
    user: String,
    password: Option<String>,
    account_id: Option<String>,
    state: State<'_, CalDavState>,
) -> Result<Vec<CalDavCollection>, String> {
    let rt = state.inner().clone();
    let typed = password.filter(|p| !p.is_empty());
    let secret = match typed {
        Some(p) => Some(p),
        None => {
            let account = CalDavAccount {
                id: account_id.unwrap_or_default(),
                base_url: base_url.clone(),
                user: user.clone(),
                ..Default::default()
            };
            let rt2 = rt.clone();
            tokio::task::spawn_blocking(move || resolve_password(&rt2, &account))
                .await
                .map_err(|e| e.to_string())?
        }
    };
    let Some(password) = secret else {
        return Err(
            "type the account's password to look up its calendars (it is not saved by this step)"
                .to_string(),
        );
    };
    caldav::discover(&base_url, &Credentials { user, password }).await
}

// ── Commands: sync ──────────────────────────────────────────────────────────

/// Fetch one collection. See the module doc for why this stops short of writing.
///
/// The cheap check comes first: an unchanged `getctag` means nothing was
/// fetched and `unchanged: true` comes back, which is what makes a background
/// timer cost one small request rather than a whole calendar. `force` skips it,
/// for the "Sync now" button — a user clicking Sync after fixing something on
/// the server should not be told "nothing changed" by a token.
#[tauri::command]
pub async fn caldav_fetch(
    account_id: String,
    href: String,
    force: bool,
    state: State<'_, CalDavState>,
) -> Result<CalDavChanges, String> {
    let rt = state.inner().clone();
    let (account, cred) = {
        let rt2 = rt.clone();
        let account_id = account_id.clone();
        tokio::task::spawn_blocking(move || {
            let account = account_by_id(&accounts_path(), &account_id)?;
            let cred = credentials(&rt2, &account)?;
            Ok::<_, String>((account, cred))
        })
        .await
        .map_err(|e| e.to_string())??
    };

    let stored = account
        .calendars
        .iter()
        .find(|c| c.href == href)
        .cloned()
        .ok_or_else(|| format!("this account is not subscribed to '{href}'"))?;

    // 1. The cheap "is it worth doing the expensive read" check.
    if !force && !stored.ctag.is_empty() {
        if let Ok((ctag, _)) = caldav::change_tokens(&href, &cred).await {
            if !ctag.is_empty() && ctag == stored.ctag {
                return Ok(CalDavChanges {
                    ctag,
                    unchanged: true,
                    ..Default::default()
                });
            }
        }
    }

    // 2. Incremental when the server offered a token last time; a full read
    //    otherwise, or when the token turned out to be stale/unsupported — the
    //    fallback every pre-RFC-6578 server has always been on.
    if let Some(token) = stored.sync_token.as_deref().filter(|t| !t.is_empty()) {
        match caldav::fetch_changes(&href, &cred, token).await {
            Ok(changes) => return Ok(changes),
            Err(_) => { /* fall through to the full read */ }
        }
    }
    caldav::fetch_all(&href, &cred, &stored.components).await
}

/// Reconcile a fetched-and-parsed collection into `calendar.json`, and record
/// the change tokens the next fetch will compare against.
///
/// The tokens are stored **after** the merge succeeds, and only then: a token
/// saved over a write that failed would make the next sync skip the very change
/// it just dropped, and the calendar would sit quietly wrong until something
/// else happened to move the ctag.
#[tauri::command]
pub async fn caldav_apply(
    account_id: String,
    href: String,
    parsed: Vec<CalDavParsed>,
    removed: Vec<String>,
    incremental: bool,
    ctag: String,
    sync_token: Option<String>,
    last_sync: String,
) -> Result<CalendarData, String> {
    tokio::task::spawn_blocking(move || {
        let mut account = account_by_id(&accounts_path(), &account_id)?;
        let calendar_id = account
            .calendars
            .iter()
            .find(|c| c.href == href)
            .map(|c| c.calendar_id.clone())
            .ok_or_else(|| format!("this account is not subscribed to '{href}'"))?;

        let data = crate::commands::calendar::merge_caldav_calendar_at(
            &crate::commands::calendar::calendar_path(),
            &calendar_id,
            parsed,
            &removed,
            // A full listing is authoritative about what still exists; an
            // incremental one says nothing at all about what it omits.
            !incremental,
        )?;

        if let Some(slot) = account.calendars.iter_mut().find(|c| c.href == href) {
            if !ctag.is_empty() {
                slot.ctag = ctag;
            }
            if let Some(token) = sync_token {
                if !token.is_empty() {
                    slot.sync_token = Some(token);
                }
            }
            slot.last_sync = last_sync;
        }
        upsert_account_at(&accounts_path(), account)?;
        Ok(data)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        (dir, path)
    }

    fn account(user: &str) -> CalDavAccount {
        CalDavAccount {
            base_url: "https://dav.example.org/dav/".into(),
            user: user.into(),
            label: "Work".into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_missing_store_is_an_empty_account_list() {
        let (_dir, path) = tmp();
        assert!(read_accounts(&path).unwrap().accounts.is_empty());
    }

    #[test]
    fn upsert_mints_an_id_and_then_replaces_in_place() {
        let (_dir, path) = tmp();
        let a = upsert_account_at(&path, account("me")).unwrap();
        assert!(!a.id.is_empty(), "the store owns identity");

        let mut edited = a.clone();
        edited.label = "Home".into();
        let b = upsert_account_at(&path, edited).unwrap();
        assert_eq!(a.id, b.id);
        let all = read_accounts(&path).unwrap().accounts;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].label, "Home");
    }

    #[test]
    fn delete_removes_only_the_named_account() {
        let (_dir, path) = tmp();
        let a = upsert_account_at(&path, account("one")).unwrap();
        let b = upsert_account_at(&path, account("two")).unwrap();
        delete_account_at(&path, &a.id).unwrap();
        let left = read_accounts(&path).unwrap().accounts;
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, b.id);
        assert!(delete_account_at(&path, "nope").is_err());
    }

    #[test]
    fn the_store_carries_no_secret() {
        let (_dir, path) = tmp();
        upsert_account_at(&path, account("me")).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.to_lowercase().contains("password") || raw.contains("save_password"),
            "the only 'password' in the file may be the opt-in flag: {raw}"
        );
    }

    #[test]
    fn remember_false_is_coerced_to_none() {
        // A connect must never be able to *forget*: only the explicit
        // forget-password command clears an entry.
        assert_eq!(remember_arg(Some(false)), None);
        assert_eq!(remember_arg(None), None);
        assert_eq!(remember_arg(Some(true)), Some(true));
    }

    #[test]
    fn a_blank_save_over_an_existing_entry_says_nothing() {
        assert!(blank_save_error(true, true).is_none());
        assert!(blank_save_error(false, true).unwrap().contains("type it"));
        assert!(blank_save_error(false, false).unwrap().contains("keyring"));
    }

    #[test]
    fn the_keychain_key_is_the_server_target_not_the_account_id() {
        let mut a = account("me");
        a.id = "account-1".into();
        let mut b = account("me");
        b.id = "account-2".into();
        assert_eq!(
            account_key(&a),
            account_key(&b),
            "two Eldrun accounts on one login share one saved secret"
        );
        assert!(!account_key(&a).contains("account-1"));
    }

    #[test]
    fn subscriptions_round_trip_with_their_cursors() {
        let (_dir, path) = tmp();
        let mut a = account("me");
        a.calendars.push(crate::schema::caldav::CalDavCalendarRef {
            href: "https://dav.example.org/dav/me/personal/".into(),
            calendar_id: "cal-1".into(),
            display_name: "Personal".into(),
            ctag: "ctag-1".into(),
            sync_token: Some("tok-1".into()),
            components: vec!["VEVENT".into()],
            read_only: true,
            last_sync: "2026-07-28T10:00".into(),
            ..Default::default()
        });
        let saved = upsert_account_at(&path, a).unwrap();
        let read = account_by_id(&path, &saved.id).unwrap();
        assert_eq!(read.calendars.len(), 1);
        assert_eq!(read.calendars[0].ctag, "ctag-1");
        assert_eq!(read.calendars[0].sync_token.as_deref(), Some("tok-1"));
        assert!(read.calendars[0].read_only);
    }
}
