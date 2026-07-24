//! Commands about the **OS credential store itself**, rather than any one
//! credential in it.
//!
//! Every "is this password saved?" answer in Eldrun — the SSH `remote_has_password`,
//! the VPN `vpn_has_saved_password`, both silent-connect probes — reduces to a
//! keychain read, and on Linux a read against a *locked* Secret Service collection
//! answers exactly like an empty one: nothing saved. That is how a user who ticked
//! "Save password" ends up staring at a blank prompt after a restart, with the
//! credential sitting in the keyring the whole time.
//!
//! So the lock state is its own question, asked once by the UI, with one action
//! behind it. Both commands are `async` + `spawn_blocking` for the reason every
//! keychain command here is: a synchronous Tauri command runs on the **main thread**,
//! and a Secret Service round trip against a locked collection blocks — which would
//! freeze the window in the very state it is trying to explain.

use crate::commands::terminal::RegistryState;
use crate::services::remote_credentials::{self as creds, KeyringState};
use tauri::State;

/// Whether the OS credential store is readable right now (see [`KeyringState`]).
#[tauri::command]
pub async fn keyring_state() -> KeyringState {
    tokio::task::spawn_blocking(creds::keyring_state)
        .await
        // A worker that died tells us nothing about the store; "locked" is the answer
        // with a remedy attached, and a wrong "unlocked" would send the caller back
        // into the silent path that is already failing.
        .unwrap_or(KeyringState::Locked)
}

/// Unlock the OS credential store, raising the system's own unlock dialog.
///
/// Only ever called from an explicit user action (the header's VPN menu, a Connect
/// dialog) — never from a launch path, which promises not to prompt.
#[tauri::command]
pub async fn keyring_unlock() -> Result<(), String> {
    tokio::task::spawn_blocking(creds::unlock_keyring)
        .await
        .map_err(|e| format!("keyring unlock task failed: {e}"))?
}

/// Which saved credential a paste targets. Tagged by `kind` so the frontend names
/// the *credential*, never the keychain account string — the account spelling
/// (`ssh:{user}@{host}:{port}`, `openvpn-key:{config}`, …) stays the backend's, as
/// it is everywhere else, so a UI that mints one by hand can't drift from the one
/// [`creds`] writes.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PasteCredential {
    /// The SSH login password for a host target.
    SshPassword {
        user: Option<String>,
        host: String,
        port: Option<u16>,
    },
    /// An OpenVPN tunnel's primary secret (the `auth-user-pass` password, or the
    /// key passphrase for a config with no account).
    VpnPassword { config: String },
    /// An OpenVPN tunnel's separately-stored private-key passphrase.
    VpnKeyPassphrase { config: String },
    /// An OpenVPN tunnel's saved auth **username** — the one non-secret of the set,
    /// stored in the keychain because a header-started tunnel has no project spec to
    /// carry it (see [`creds::openvpn_user_account`]).
    VpnUsername { config: String },
}

impl PasteCredential {
    fn account(&self) -> String {
        match self {
            Self::SshPassword { user, host, port } => creds::ssh_account(user, host, *port),
            Self::VpnPassword { config } => creds::openvpn_account(config),
            Self::VpnKeyPassphrase { config } => creds::openvpn_key_account(config),
            Self::VpnUsername { config } => creds::openvpn_user_account(config),
        }
    }
}

/// Type a saved credential into a **login terminal**, at its cursor, without it ever
/// reaching the frontend.
///
/// This is the non-headless login's missing half. In that mode Eldrun deliberately
/// handles no passwords — the host asks its own questions in an embedded terminal and
/// the user answers them — but a user who *did* save a credential (from a headless
/// connect, or the header's VPN menu) then has it sitting in the keychain, unreachable,
/// while retyping it by hand into every login. The same is true one flip of "Sign in in
/// a terminal" away: the escape hatch for a host that asks a challenge code still asks
/// for the ordinary password first.
///
/// So the secret goes keychain → PTY **inside the backend**. It is never returned to
/// JS, never rendered into a field, never in a component's state — the same bargain
/// `ssh_connect`'s saved-password fallback makes, applied to a terminal the user is
/// looking at rather than a headless connect. `submit` appends a newline for a prompt
/// the user wants answered outright; by default nothing is sent but the credential, so
/// the line can still be corrected before it is committed.
///
/// Returns `false` when nothing is stored for the target (including a locked keyring,
/// which reads as empty — [`keyring_state`] is what distinguishes the two), so the
/// caller can say "nothing saved" instead of appearing to paste an empty secret.
#[tauri::command]
pub async fn credential_paste_to_pty(
    registry: State<'_, RegistryState>,
    pty: String,
    target: PasteCredential,
    submit: Option<bool>,
) -> Result<bool, String> {
    let account = target.account();
    let Some(secret) = tokio::task::spawn_blocking(move || creds::get(&account))
        .await
        .map_err(|e| format!("credential read task failed: {e}"))?
    else {
        return Ok(false);
    };
    let mut bytes = secret.into_bytes();
    if submit.unwrap_or(false) {
        bytes.push(b'\r');
    }
    registry
        .lock()
        .unwrap()
        .write(&pty, &bytes)
        .map_err(|e| e.to_string())?;
    Ok(true)
}
