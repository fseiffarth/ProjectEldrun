//! Optional, opt-in secure storage for **remote-connection passwords** (SSH
//! login + OpenVPN passphrase), backed by the OS credential store (Windows
//! Credential Manager / macOS Keychain / Linux Secret Service) via the `keyring`
//! crate — the same mechanism `git_credentials` uses for hosting tokens.
//!
//! The default remains "never persist a password": a password is only written
//! here when the user ticks the per-connection **Save password** checkbox, and it
//! is written **only after authentication has succeeded**. Unticking the box (and
//! reconnecting) clears any previously-saved entry, so the checkbox is the single
//! source of truth for "remember this".
//!
//! Why the OS keychain and not our JSON state? A password in `settings.json` or a
//! project's `project.json` would sit in plaintext on disk (and `project.json`
//! lives in the git working tree). Secrets therefore never touch our JSON — only
//! the keychain holds them, keyed by the **host target** so two projects sharing a
//! host/VPN share one saved credential.
//!
//! All operations degrade gracefully: a keychain that is unavailable (e.g. a
//! headless Linux box with no Secret Service) yields `None` on read and an
//! `Err(String)` on write, so callers fall back to prompting rather than failing.

const SERVICE: &str = "eldrun-remote";

/// The Linux credential handles are trait objects, not `keyring::Entry`, so their
/// `get_password`/`set_password`/`delete_credential` come from this trait. Imported
/// anonymously: only the methods are wanted, never the name.
#[cfg(target_os = "linux")]
use keyring::credential::CredentialApi as _;

/// The keychain account for an SSH host target: `"ssh:{user}@{host}:{port}"`.
/// `user` defaults to empty and `port` to 22 so the key is stable whether the
/// caller passes `None`/`Some(22)` or an omitted user — the same live target
/// always maps to the same entry.
pub fn ssh_account(user: &Option<String>, host: &str, port: Option<u16>) -> String {
    let user = user.as_deref().unwrap_or("").trim();
    let port = port.unwrap_or(22);
    format!("ssh:{user}@{host}:{port}")
}

/// The keychain account for an OpenVPN tunnel's primary secret, keyed by its
/// stored config path — the `auth-user-pass` account password, or (for a config
/// with no account) the private-key passphrase.
pub fn openvpn_account(config: &str) -> String {
    format!("openvpn:{config}")
}

/// The keychain account for an OpenVPN tunnel's **private-key passphrase**, for
/// configs that need it *alongside* an `auth-user-pass` account password. Two
/// independent secrets need two entries; a config that only has a key passphrase
/// keeps storing it under [`openvpn_account`] (there is no account password to
/// collide with).
pub fn openvpn_key_account(config: &str) -> String {
    format!("openvpn-key:{config}")
}

/// The keychain account for an OpenVPN tunnel's **auth username** — the one
/// non-secret in the set, stored here anyway because it is the missing half of a
/// promptless connect and there is nowhere else to put it.
///
/// A username on a *project's* `OpenVpnSpec` only exists for a tunnel a project
/// owns. A tunnel brought up from the header has no project, so without this the
/// username was simply unknown on every reconnect: the silent connect ran without
/// it, `pkexec` raised a polkit prompt, OpenVPN was rejected by the server, and the
/// modal then asked for it — a second polkit prompt for one tunnel. Saved and
/// cleared together with the secrets, under the same opt-in checkbox.
pub fn openvpn_user_account(config: &str) -> String {
    format!("openvpn-user:{config}")
}

/// The platform credential handle for `account`.
///
/// Everywhere but Linux this is `keyring::Entry`, the crate's own dispatch to the
/// Windows Credential Manager / macOS Keychain.
///
/// On **Linux** it is deliberately *not* `Entry`: it is the keyutils-persistent
/// credential built by hand. That store — a kernel-keyring cache in front of the
/// Secret Service, which stays the half that survives a reboot — is what keeps a
/// blocking D-Bus read off every connect path but the first of each boot. It cannot be
/// reached through `Entry`, because keyring 3.6's builder for it
/// (`KeyutilsPersistentCredentialBuilder::build`) returns a plain `SsCredential`:
/// enabling the feature and going on using `Entry` would silently keep today's
/// secret-service-only behaviour. Constructing the credential directly is the whole
/// point of the feature, so it is done here, once.
#[cfg(target_os = "linux")]
fn entry(account: &str) -> Result<keyring::keyutils_persistent::KeyutilsPersistentCredential, String>
{
    keyring::keyutils_persistent::KeyutilsPersistentCredential::new_with_target(
        None, SERVICE, account,
    )
    .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Read `account` from the **kernel keyring only**, never touching the Secret Service.
///
/// This is the locked-collection path. The cache half of the store is a plain syscall:
/// it cannot block, cannot raise a prompt, and is readable while the `login` collection
/// is locked — so a credential already read once this boot keeps working through a lock
/// instead of reading as "nothing saved". A miss is simply `None`; there is deliberately
/// no fallback, because the fallback is the call this exists to avoid.
///
/// The key must match the one the combo store's cache half writes, so it is derived the
/// same way: `new_with_target(None, SERVICE, account)`.
#[cfg(target_os = "linux")]
fn get_cached_only(account: &str) -> Option<String> {
    use keyring::credential::CredentialApi;
    let cred = keyring::keyutils::KeyutilsCredential::new_with_target(None, SERVICE, account).ok()?;
    cred.get_password().ok().filter(|p| !p.is_empty())
}

/// How long a single keychain **read** may block before we give up on it and answer
/// "nothing readable". Comfortably longer than an unlocked read (milliseconds), short
/// enough that a connect never appears wedged.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

/// Run a keychain read on a throwaway thread and abandon it after [`READ_TIMEOUT`].
///
/// The Linux Secret Service blocks **indefinitely** while the keyring collection is
/// *locked*: the read triggers an unlock that has to be answered first, and on a
/// session where that prompt never surfaces (a locked `login` collection with no
/// running prompter, a headless run) the call simply never returns. Every credential
/// read here sits on a connect path — `ssh_connect`'s saved-password fallback, the
/// silent-connect probes, auto-connect — so an unbounded one wedges the connect and
/// parks the lamp on "connecting" forever (the amber-that-never-resolves). Bounding it
/// degrades a locked keyring to "nothing saved", which routes the caller to a prompt —
/// the safe direction. The abandoned worker unblocks if the keyring ever does; that
/// costs at most one parked thread per hung read, and only ever happens locked.
fn read_timed<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static, on_timeout: T) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(READ_TIMEOUT).unwrap_or(on_timeout)
}

/// Read the saved password for `account`. Returns `None` when nothing is stored,
/// the keychain is unavailable, or the read timed out against a locked keyring —
/// never an error, and never a hang, so a missing/unreachable credential cleanly
/// falls through to prompting.
///
/// **A locked collection is never dispatched to.** [`read_timed`] bounds the *caller*,
/// but the abandoned worker stays parked inside the Secret Service call for as long as
/// the unlock prompt goes unanswered — one thread, holding one open D-Bus connection,
/// per read, and every connect path takes one. When the process then exits, all of them
/// drop mid-request, which is a client vanishing between dispatch and reply: the state
/// `gnome-keyring-daemon` aborts on (`assertion 'client' failed` in `OpenSession`). A
/// crashed daemon is restarted by systemd *without* the login password PAM handed the
/// original, so the collection comes back locked — and the next run parks its reads
/// again. Asking [`cached_keyring_state`] first breaks that loop: while locked, the read
/// goes to the kernel-keyring cache, which answers immediately and off the bus.
pub fn get(account: &str) -> Option<String> {
    #[cfg(target_os = "linux")]
    if cached_keyring_state() != KeyringState::Unlocked {
        return get_cached_only(account);
    }
    let account = account.to_string();
    read_timed(move || get_uncapped(&account), None)
}

/// The unbounded keychain read, run on the worker thread by [`get`].
fn get_uncapped(account: &str) -> Option<String> {
    match entry(account).and_then(|e| match e.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }) {
        Ok(pw) => pw.filter(|p| !p.is_empty()),
        Err(_) => None,
    }
}

/// Store (non-empty) or clear (`None`/empty) the password for `account`. Returns
/// an error string if the keychain write fails so the UI can report it.
///
/// A write to a **locked** collection is refused rather than attempted, for the reason
/// [`get`] gives: it would block on an unlock prompt, and a blocked write is a wedged
/// connect and one more parked D-Bus client. Refusing says the true thing ("locked, so
/// nothing was saved") instead of appearing to save and never returning. Writing only
/// the kernel-keyring half would be worse than either — a credential that reads back
/// fine until the next reboot silently loses it.
pub fn set(account: &str, password: Option<&str>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if cached_keyring_state() != KeyringState::Unlocked {
        return Err("the OS keyring is locked, so nothing was saved — unlock it and try again".into());
    }
    let e = entry(account)?;
    let wrote = match password.filter(|p| !p.is_empty()) {
        Some(secret) => e.set_password(secret).map_err(|err| err.to_string()),
        None => match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        },
    };
    // A completed write is a first-hand observation that the collection was open —
    // fresher than anything the cache holds, and the cheapest place to notice a lock
    // that was lifted (or dropped) since the last probe.
    forget_keyring_state();
    wrote
}

/// Whether a non-empty password is stored for `account`. Used to tell the
/// frontend "saved" (so it can pre-check the box) without handing back the secret.
pub fn has(account: &str) -> bool {
    get(account).is_some()
}

/// Whether the OS credential store can be read **right now** — the question every
/// "is this credential saved?" answer silently depends on.
///
/// On Linux the Secret Service collection holding our entries can be *locked*, and a
/// locked collection is indistinguishable from an empty one through the `keyring`
/// crate: every read answers `None`. So a user who ticked "Save password", connected,
/// and restarted finds the box blank and the silent connect gone — the credential is
/// still there, it just cannot be read. Reporting the lock is what lets the UI say
/// that, and offer [`unlock_keyring`], instead of quietly pretending nothing was saved.
///
/// Windows and macOS have no equivalent state (their stores unlock with the login
/// session), so they always report [`KeyringState::Unlocked`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyringState {
    /// Readable: a `None` from [`get`] really does mean "nothing saved".
    Unlocked,
    /// Present but locked — saved credentials exist but read as absent until unlocked.
    Locked,
    /// No credential store at all (no Secret Service on the bus). Saving is impossible
    /// here, so the UI should stop offering it rather than fail every write silently.
    Unavailable,
}

/// The lock state of the collection our entries live in. Bounded like every other
/// keychain read, and *never* prompts: the probe connects with a zero-second prompt
/// timeout, so asking the question can never put a dialog on screen.
///
/// A timeout answers `Locked` rather than `Unavailable` on purpose — a hung Secret
/// Service call is overwhelmingly a locked collection waiting on an unlock nobody
/// answered, and `Locked` is the state with an action behind it.
pub fn keyring_state() -> KeyringState {
    let state = read_timed(keyring_state_uncapped, KeyringState::Locked);
    remember_keyring_state(state);
    state
}

/// How long [`cached_keyring_state`] trusts a reading. Short enough that unlocking the
/// collection from *outside* Eldrun (Seahorse, another app's prompt) is picked up
/// without a restart; long enough that a burst of connects costs one probe, not one per
/// credential. The transition that actually matters — our own [`unlock_keyring`] — does
/// not wait for it: it invalidates the cache outright.
#[cfg(target_os = "linux")]
const STATE_TTL: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(target_os = "linux")]
static STATE_CACHE: std::sync::Mutex<Option<(std::time::Instant, KeyringState)>> =
    std::sync::Mutex::new(None);

/// The lock state as [`get`]'s gate sees it: cached, so that asking "may I dispatch a
/// Secret Service read?" before *every* read costs a D-Bus round trip only once per
/// [`STATE_TTL`]. The probe behind it never prompts, so a miss is cheap and safe.
#[cfg(target_os = "linux")]
fn cached_keyring_state() -> KeyringState {
    if let Ok(cache) = STATE_CACHE.lock() {
        if let Some((at, state)) = *cache {
            if at.elapsed() < STATE_TTL {
                return state;
            }
        }
    }
    keyring_state()
}

/// Record a freshly-observed lock state. A no-op off Linux, where there is no lock to
/// observe and [`get`] never consults the cache.
fn remember_keyring_state(_state: KeyringState) {
    #[cfg(target_os = "linux")]
    {
        if let Ok(mut cache) = STATE_CACHE.lock() {
            *cache = Some((std::time::Instant::now(), _state));
        }
    }
}

/// Drop the cached lock state, so the next [`get`] re-asks. Called wherever the state
/// is known to have just changed under us — an unlock we raised, a write that proved
/// the collection was writable.
pub fn forget_keyring_state() {
    #[cfg(target_os = "linux")]
    {
        if let Ok(mut cache) = STATE_CACHE.lock() {
            *cache = None;
        }
    }
}

#[cfg(target_os = "linux")]
fn keyring_state_uncapped() -> KeyringState {
    use dbus_secret_service::{EncryptionType, SecretService};
    // 0 = never raise a prompt; this is a probe, and a probe that can pop a system
    // dialog is not a probe. `Plain` because no secret crosses this session — we ask
    // for a boolean, so there is nothing to encrypt.
    let Ok(service) = SecretService::connect_with_max_prompt_timeout(EncryptionType::Plain, 0)
    else {
        return KeyringState::Unavailable;
    };
    let Ok(collection) = service.get_default_collection() else {
        return KeyringState::Unavailable;
    };
    match collection.is_locked() {
        Ok(true) => KeyringState::Locked,
        Ok(false) => KeyringState::Unlocked,
        Err(_) => KeyringState::Unavailable,
    }
}

#[cfg(not(target_os = "linux"))]
fn keyring_state_uncapped() -> KeyringState {
    KeyringState::Unlocked
}

/// Ask the OS to unlock the credential store, raising *its own* unlock dialog.
///
/// Deliberately blocking and unbounded-ish (a generous prompt timeout): the user is
/// typing a password into a system dialog, and abandoning that after four seconds
/// would be worse than not asking. Call it only from an explicit user action — never
/// from a launch path that promises not to prompt.
///
/// Returns `Ok(())` once the collection is unlocked (including when it already was);
/// an `Err` if the dialog was dismissed, timed out, or there is no store to unlock.
pub fn unlock_keyring() -> Result<(), String> {
    let out = unlock_keyring_impl();
    // Whichever way the dialog went, the cached reading is now the stale one — and this
    // is precisely the transition [`get`]'s gate must see immediately, since the click
    // exists to make the next connect find its saved credential.
    forget_keyring_state();
    out
}

#[cfg(target_os = "linux")]
fn unlock_keyring_impl() -> Result<(), String> {
    use dbus_secret_service::{EncryptionType, SecretService};
    // Two minutes: long enough to find and answer the dialog, short enough that a
    // prompt nobody ever sees does not park this thread for the session.
    let service = SecretService::connect_with_max_prompt_timeout(EncryptionType::Plain, 120)
        .map_err(|e| format!("no OS credential store available: {e}"))?;
    let collection = service
        .get_default_collection()
        .map_err(|e| format!("no default keyring collection: {e}"))?;
    match collection.is_locked() {
        Ok(false) => return Ok(()),
        Ok(true) => {}
        Err(e) => return Err(format!("could not read the keyring's lock state: {e}")),
    }
    collection
        .unlock()
        .map_err(|e| format!("keyring unlock failed or was dismissed: {e}"))?;
    // `unlock` returns as soon as the prompt is dismissed, whichever way — so confirm
    // rather than report success on a cancelled dialog.
    match collection.is_locked() {
        Ok(false) => Ok(()),
        _ => Err("the keyring is still locked".to_string()),
    }
}

#[cfg(not(target_os = "linux"))]
fn unlock_keyring_impl() -> Result<(), String> {
    Ok(())
}

/// What a successful connect should do to the stored credential, decided by the
/// caller's `remember` argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Remember {
    /// The user ticked "Save password" — persist the working secret.
    Save,
    /// The user *unticked* it — drop any previously-saved secret.
    Clear,
    /// The caller has no checkbox behind it — do not touch the keychain.
    Leave,
}

/// Map a connect command's `remember` argument to a keychain action.
///
/// The case that matters is `None → Leave`. Not every connect comes from a form:
/// a reachability probe, a ControlMaster readiness poll, and a silent auto-connect
/// all authenticate *using* the saved credential while having no opinion about
/// storing it. Folding `None` into "unticked" (the old `unwrap_or(false)`) made
/// each of them delete the very password it had just used — the credential worked
/// exactly once, then the next connect prompted again.
pub fn remember_action(remember: Option<bool>) -> Remember {
    match remember {
        Some(true) => Remember::Save,
        Some(false) => Remember::Clear,
        None => Remember::Leave,
    }
}

/// Apply the post-auth keychain write for `account`: save `secret`, clear the
/// entry, or leave it alone, per [`remember_action`]. Call only *after*
/// authentication succeeded, so a rejected credential is never stored. Best effort
/// — a keychain write failure must not fail an already-successful connect.
pub fn remember_secret(account: &str, remember: Option<bool>, secret: Option<&str>) {
    match remember_action(remember) {
        Remember::Save => {
            let _ = set(account, secret);
        }
        Remember::Clear => {
            let _ = set(account, None);
        }
        Remember::Leave => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point of the tri-state: "no checkbox behind this call" must not be
    /// read as "the user unticked the box". A probe or a silent reconnect that
    /// cleared the keychain would delete the password it had just used.
    #[test]
    fn remember_none_leaves_the_keychain_alone() {
        assert_eq!(remember_action(None), Remember::Leave);
        assert_eq!(remember_action(Some(true)), Remember::Save);
        assert_eq!(remember_action(Some(false)), Remember::Clear);
    }

    #[test]
    fn ssh_account_normalizes_default_port() {
        // None and Some(22) must map to the same entry as the live target.
        assert_eq!(
            ssh_account(&Some("alice".into()), "host.example", None),
            "ssh:alice@host.example:22"
        );
        assert_eq!(
            ssh_account(&Some("alice".into()), "host.example", Some(22)),
            "ssh:alice@host.example:22"
        );
    }

    #[test]
    fn ssh_account_omitted_user_is_empty() {
        assert_eq!(ssh_account(&None, "host.example", Some(2222)), "ssh:@host.example:2222");
        // A blank/whitespace user normalizes to the same empty-user key.
        assert_eq!(ssh_account(&Some("  ".into()), "host.example", Some(2222)), "ssh:@host.example:2222");
    }

    #[test]
    fn ssh_account_distinct_ports_are_distinct_keys() {
        assert_ne!(
            ssh_account(&Some("a".into()), "h", Some(22)),
            ssh_account(&Some("a".into()), "h", Some(2222))
        );
    }

    #[test]
    fn openvpn_account_keys_by_config_path() {
        assert_eq!(openvpn_account("/store/x.ovpn"), "openvpn:/store/x.ovpn");
    }

    #[test]
    fn openvpn_user_account_is_distinct_from_both_secret_accounts() {
        // The username shares the config key but must never share an *entry* with a
        // secret: writing it into either would overwrite the password/passphrase.
        let c = "/store/x.ovpn";
        assert_eq!(openvpn_user_account(c), "openvpn-user:/store/x.ovpn");
        assert_ne!(openvpn_user_account(c), openvpn_account(c));
        assert_ne!(openvpn_user_account(c), openvpn_key_account(c));
    }

    /// The gate's cheap half: a reading taken once is reused, so asking "may I dispatch
    /// a Secret Service read?" before every credential read costs one probe, not one per
    /// account. Deterministic — it asserts only what was just remembered, never a live
    /// probe's answer.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_remembered_lock_state_is_served_from_the_cache() {
        remember_keyring_state(KeyringState::Locked);
        assert_eq!(cached_keyring_state(), KeyringState::Locked);
        // Deliberately not cleared: another test clearing it mid-run would send the next
        // one to a *live* probe, which on an unlocked dev machine would let a test write
        // reach the real keychain. The reading expires on its own.
    }

    /// A locked collection must make the write fail *fast*, not wait on an unlock prompt
    /// nobody may answer. Proven by the error alone: reaching the keychain at all would
    /// mean the gate let the call through.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_locked_keyring_refuses_the_write_instead_of_blocking_on_it() {
        remember_keyring_state(KeyringState::Locked);
        let err = set("test:locked-gate", Some("secret")).unwrap_err();
        assert!(err.contains("locked"), "unexpected error: {err}");
    }

    #[test]
    fn openvpn_key_account_is_distinct_from_the_password_account() {
        // Same config, two secrets — they must never share an entry, or saving one
        // would overwrite the other.
        assert_eq!(
            openvpn_key_account("/store/x.ovpn"),
            "openvpn-key:/store/x.ovpn"
        );
        assert_ne!(
            openvpn_key_account("/store/x.ovpn"),
            openvpn_account("/store/x.ovpn")
        );
    }
}
