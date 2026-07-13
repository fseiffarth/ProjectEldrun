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

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Read the saved password for `account`. Returns `None` when nothing is stored
/// or the keychain is unavailable — never an error, so a missing credential
/// cleanly falls through to prompting.
pub fn get(account: &str) -> Option<String> {
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
pub fn set(account: &str, password: Option<&str>) -> Result<(), String> {
    let e = entry(account)?;
    match password.filter(|p| !p.is_empty()) {
        Some(secret) => e.set_password(secret).map_err(|err| err.to_string()),
        None => match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        },
    }
}

/// Whether a non-empty password is stored for `account`. Used to tell the
/// frontend "saved" (so it can pre-check the box) without handing back the secret.
pub fn has(account: &str) -> bool {
    get(account).is_some()
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
