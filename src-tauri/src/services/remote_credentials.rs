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

/// The keychain account for an OpenVPN tunnel, keyed by its stored config path.
pub fn openvpn_account(config: &str) -> String {
    format!("openvpn:{config}")
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
