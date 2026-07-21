//! Global worker-machine registry (project-free, mirrors the VPN tunnel
//! registry's "machine-wide, not project-scoped" pattern).
//!
//! A [`GlobalMachine`] is authenticated once via the ordinary login mechanism
//! (`commands::ssh::ssh_connect`) with no `remote_path` — the caller does that
//! *before* calling [`global_machine_add`], which only persists the identity.
//! No connect/disconnect commands live here: `ssh_connect`/`ssh_probe` are
//! already project-free and host-identity keyed, so the frontend calls them
//! directly with a machine's `user`/`host`/`port`.

use crate::schema::GlobalMachine;
use crate::storage;

fn global_machines_path() -> std::path::PathBuf {
    storage::state_dir().join("global_machines.json")
}

fn load_all() -> Vec<GlobalMachine> {
    storage::read_json(&global_machines_path()).unwrap_or_default()
}

fn save_all(list: &[GlobalMachine]) -> Result<(), String> {
    storage::write_json(&global_machines_path(), &list.to_vec()).map_err(|e| e.to_string())
}

/// Every globally connected machine, for the header's Machines indicator.
#[tauri::command]
pub fn global_machines_list() -> Vec<GlobalMachine> {
    load_all()
}

/// Register a machine in the global list. The CALLER has already authenticated
/// it via `ssh_connect` — this command does no auth of its own, it only
/// persists the identity (mirrors how `RemoteMachinesWindow` already separates
/// "log in" from "add" for a project worker).
#[tauri::command]
pub fn global_machine_add(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    label: Option<String>,
) -> Result<GlobalMachine, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("host must not be empty".to_string());
    }
    crate::services::ssh_common::validate_arg("host", &host)?;
    let user = user
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    if let Some(u) = &user {
        crate::services::ssh_common::validate_arg("user", u)?;
    }
    let label = label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty());
    let mut list = load_all();
    let machine = GlobalMachine {
        id: crate::commands::projects::uuid_v4(),
        user,
        host,
        port,
        label,
    };
    list.push(machine.clone());
    save_all(&list)?;
    Ok(machine)
}

/// Drop a machine from the global list. Never touches the OS keychain — the
/// saved SSH credential (if any) is keyed by host identity
/// (`remote_credentials::ssh_account`), shared with any project that reaches
/// the same target, not by this registry. Never touches any project's
/// `compute_hosts` either: a `ComputeHost` is a value copy of the connection
/// info made at drop time, not a reference back here.
#[tauri::command]
pub fn global_machine_remove(id: String) -> Result<Vec<GlobalMachine>, String> {
    let mut list = load_all();
    list.retain(|m| m.id != id);
    save_all(&list)?;
    Ok(list)
}
