//! Read-only network monitoring for project tabs.
//!
//! A local project observes the local Linux host. A remote project observes its
//! SSH host by riding the already-authenticated ControlMaster; it never opens a
//! connection on its own. The separate SSH-link snapshot is collected locally
//! from the ControlMaster's TCP socket so it includes every multiplexed channel
//! (terminal, SFTP, sync, git).

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::services::remote::{self, RemotePoolState};

const REMOTE_IFACES: &str = "test -r /proc/net/dev || exit 42; \
printf '__ELDRUN_IFACES__\\n'; cat /proc/net/dev; \
printf '__ELDRUN_STATES__\\n'; \
for p in /sys/class/net/*; do test -e \"$p\" || continue; \
printf '%s ' \"${p##*/}\"; cat \"$p/operstate\" 2>/dev/null || printf 'unknown\\n'; done";
const REMOTE_WITH_CONNECTIONS: &str = "test -r /proc/net/dev || exit 42; \
printf '__ELDRUN_IFACES__\\n'; cat /proc/net/dev; \
printf '__ELDRUN_STATES__\\n'; \
for p in /sys/class/net/*; do test -e \"$p\" || continue; \
printf '%s ' \"${p##*/}\"; cat \"$p/operstate\" 2>/dev/null || printf 'unknown\\n'; done; \
printf '__ELDRUN_CONNECTIONS__\\n'; \
if command -v ss >/dev/null 2>&1; then LC_ALL=C ss -H -tuna -p 2>/dev/null || true; \
else printf '__ELDRUN_NO_SS__\\n'; fi";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterface {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub up: bool,
    pub loopback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConnection {
    pub protocol: String,
    pub state: String,
    pub local_address: String,
    pub local_port: String,
    pub remote_address: String,
    pub remote_port: String,
    pub pid: Option<u32>,
    pub process: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkHostSnapshot {
    pub supported: bool,
    pub remote: bool,
    pub connected: bool,
    pub sampled_at_ms: u64,
    pub host_label: String,
    pub interfaces: Vec<NetworkInterface>,
    pub connections: Option<Vec<NetworkConnection>>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshLinkSnapshot {
    pub supported: bool,
    pub connected: bool,
    pub sampled_at_ms: u64,
    pub connection_id: Option<String>,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub local_endpoint: Option<String>,
    pub remote_endpoint: Option<String>,
    pub warning: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn unsupported_host(
    remote: bool,
    connected: bool,
    host_label: String,
    warning: &str,
) -> NetworkHostSnapshot {
    NetworkHostSnapshot {
        supported: false,
        remote,
        connected,
        sampled_at_ms: now_ms(),
        host_label,
        interfaces: Vec::new(),
        connections: None,
        warning: Some(warning.to_string()),
    }
}

fn split_endpoint(value: &str) -> (String, String) {
    let value = value.trim();
    if let Some(rest) = value.strip_prefix('[') {
        if let Some((address, port)) = rest.rsplit_once("]:") {
            return (address.to_string(), port.to_string());
        }
    }
    value
        .rsplit_once(':')
        .map(|(address, port)| (address.to_string(), port.to_string()))
        .unwrap_or_else(|| (value.to_string(), String::new()))
}

fn process_meta(text: &str) -> (Option<u32>, Option<String>) {
    let pid = text
        .find("pid=")
        .and_then(|start| {
            text[start + 4..]
                .split(|c: char| !c.is_ascii_digit())
                .next()
        })
        .and_then(|v| v.parse().ok());
    let process = text
        .find("((\"")
        .and_then(|start| {
            let tail = &text[start + 3..];
            tail.find('"').map(|end| tail[..end].to_string())
        })
        .filter(|v| !v.is_empty());
    (pid, process)
}

fn parse_interfaces(text: &str) -> Vec<NetworkInterface> {
    text.lines()
        .filter_map(|line| {
            let (name, counters) = line.rsplit_once(':')?;
            let name = name.trim();
            if name.is_empty() || name == "Inter-| Receive" {
                return None;
            }
            let fields: Vec<&str> = counters.split_whitespace().collect();
            let rx_bytes = fields.first()?.parse().ok()?;
            let tx_bytes = fields.get(8)?.parse().ok()?;
            Some(NetworkInterface {
                name: name.to_string(),
                rx_bytes,
                tx_bytes,
                // Remote snapshots do not make an extra round trip for operstate.
                // An interface present in /proc is selectable; the local path
                // replaces this with the kernel's current state below.
                up: true,
                loopback: name == "lo",
            })
        })
        .collect()
}

fn parse_connections(text: &str) -> Vec<NetworkConnection> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 6 {
                return None;
            }
            let protocol = fields[0].to_ascii_uppercase();
            if protocol != "TCP" && protocol != "UDP" {
                return None;
            }
            let (local_address, local_port) = split_endpoint(fields[4]);
            let (remote_address, remote_port) = split_endpoint(fields[5]);
            let meta = fields.get(6..).unwrap_or_default().join(" ");
            let (pid, process) = process_meta(&meta);
            Some(NetworkConnection {
                protocol,
                state: fields[1].to_string(),
                local_address,
                local_port,
                remote_address,
                remote_port,
                pid,
                process,
            })
        })
        .collect()
}

fn parse_remote_snapshot(
    output: &str,
    host_label: String,
    include_connections: bool,
) -> NetworkHostSnapshot {
    let Some(after_ifaces) = output.split_once("__ELDRUN_IFACES__\n").map(|(_, v)| v) else {
        return unsupported_host(
            true,
            true,
            host_label,
            "The SSH host does not expose Linux /proc network counters.",
        );
    };
    let (iface_text, after_states) = after_ifaces
        .split_once("__ELDRUN_STATES__\n")
        .unwrap_or((after_ifaces, ""));
    let (state_text, connection_text) = after_states
        .split_once("__ELDRUN_CONNECTIONS__\n")
        .map(|(a, b)| (a, Some(b)))
        .unwrap_or((after_states, None));
    let states: std::collections::HashMap<&str, &str> = state_text
        .lines()
        .filter_map(|line| line.split_once(' '))
        .map(|(name, state)| (name.trim(), state.trim()))
        .collect();
    let mut interfaces = parse_interfaces(iface_text);
    for iface in &mut interfaces {
        iface.up = states
            .get(iface.name.as_str())
            .map(|state| matches!(*state, "up" | "unknown"))
            .unwrap_or(true);
    }
    if interfaces.is_empty() {
        return unsupported_host(
            true,
            true,
            host_label,
            "No Linux network interfaces were available on the SSH host.",
        );
    }
    let no_ss = connection_text.is_some_and(|v| v.contains("__ELDRUN_NO_SS__"));
    NetworkHostSnapshot {
        supported: true,
        remote: true,
        connected: true,
        sampled_at_ms: now_ms(),
        host_label,
        interfaces,
        connections: if include_connections && !no_ss {
            Some(parse_connections(connection_text.unwrap_or_default()))
        } else {
            None
        },
        warning: no_ss.then(|| {
            "`ss` is unavailable on the SSH host; connection details are hidden.".to_string()
        }),
    }
}

#[cfg(target_os = "linux")]
fn local_snapshot(include_connections: bool) -> NetworkHostSnapshot {
    let proc_net = match std::fs::read_to_string("/proc/net/dev") {
        Ok(v) => v,
        Err(e) => {
            return unsupported_host(
                false,
                true,
                "Local host".to_string(),
                &format!("Cannot read /proc/net/dev: {e}"),
            );
        }
    };
    let mut interfaces = parse_interfaces(&proc_net);
    for iface in &mut interfaces {
        iface.up = std::fs::read_to_string(format!("/sys/class/net/{}/operstate", iface.name))
            .map(|v| matches!(v.trim(), "up" | "unknown"))
            .unwrap_or(true);
    }

    let (connections, warning) = if include_connections {
        match crate::paths::command_no_window("ss")
            .args(["-H", "-tuna", "-p"])
            .env("LC_ALL", "C")
            .output()
        {
            Ok(out) if out.status.success() => (
                Some(parse_connections(&String::from_utf8_lossy(&out.stdout))),
                None,
            ),
            Ok(out) => {
                let message = String::from_utf8_lossy(&out.stderr).trim().to_string();
                (
                    None,
                    Some(if message.is_empty() {
                        "`ss` could not list connections.".to_string()
                    } else {
                        message
                    }),
                )
            }
            Err(_) => (
                None,
                Some("`ss` is unavailable; connection details are hidden.".to_string()),
            ),
        }
    } else {
        (None, None)
    };

    NetworkHostSnapshot {
        supported: true,
        remote: false,
        connected: true,
        sampled_at_ms: now_ms(),
        host_label: "Local host".to_string(),
        interfaces,
        connections,
        warning,
    }
}

#[cfg(not(target_os = "linux"))]
fn local_snapshot(_include_connections: bool) -> NetworkHostSnapshot {
    unsupported_host(
        false,
        true,
        "Local host".to_string(),
        "Network monitoring is currently supported on Linux.",
    )
}

#[tauri::command]
pub async fn network_host_snapshot(
    pool: State<'_, RemotePoolState>,
    project_id: String,
    include_connections: bool,
) -> Result<NetworkHostSnapshot, String> {
    let Some(target) = remote::remote_target_for(&project_id) else {
        return Ok(local_snapshot(include_connections));
    };
    let host_label = target.spec.host.clone();
    if !remote::is_connected(pool.inner(), &project_id).await {
        return Ok(unsupported_host(
            true,
            false,
            host_label,
            "Connect the SSH project to observe its remote host.",
        ));
    }
    let spec = target.spec;
    let command = if include_connections {
        REMOTE_WITH_CONNECTIONS
    } else {
        REMOTE_IFACES
    };
    let output = tokio::task::spawn_blocking(move || {
        crate::services::ssh_exec::run_remote_shell(&spec, command)
    })
    .await
    .map_err(|e| format!("network snapshot task failed: {e}"))??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Ok(unsupported_host(
            true,
            true,
            host_label,
            if stderr.is_empty() {
                "The SSH host does not support the Linux network collector."
            } else {
                &stderr
            },
        ));
    }
    Ok(parse_remote_snapshot(
        &String::from_utf8_lossy(&output.stdout),
        host_label,
        include_connections,
    ))
}

fn parse_master_pid(text: &str) -> Option<u32> {
    let start = text.find("pid=")?;
    text[start + 4..]
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
fn linux_ssh_link(project_id: &str) -> SshLinkSnapshot {
    let Some(target) = remote::remote_target_for(project_id) else {
        return SshLinkSnapshot {
            supported: false,
            connected: false,
            sampled_at_ms: now_ms(),
            connection_id: None,
            rx_bytes: 0,
            tx_bytes: 0,
            local_endpoint: None,
            remote_endpoint: None,
            warning: Some("SSH-link traffic is only available for remote projects.".to_string()),
        };
    };
    let check =
        match crate::services::ssh_exec::ssh_control_check_args(&target.spec).and_then(|args| {
            crate::paths::command_no_window("ssh")
                .args(args)
                .output()
                .map_err(|e| format!("failed to inspect SSH ControlMaster: {e}"))
        }) {
            Ok(v) => v,
            Err(e) => {
                return SshLinkSnapshot {
                    supported: true,
                    connected: false,
                    sampled_at_ms: now_ms(),
                    connection_id: None,
                    rx_bytes: 0,
                    tx_bytes: 0,
                    local_endpoint: None,
                    remote_endpoint: None,
                    warning: Some(e),
                };
            }
        };
    let check_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&check.stdout),
        String::from_utf8_lossy(&check.stderr)
    );
    let Some(master_pid) = parse_master_pid(&check_text) else {
        return SshLinkSnapshot {
            supported: true,
            connected: false,
            sampled_at_ms: now_ms(),
            connection_id: None,
            rx_bytes: 0,
            tx_bytes: 0,
            local_endpoint: None,
            remote_endpoint: None,
            warning: Some("The shared SSH transport is not connected.".to_string()),
        };
    };

    let output = Command::new("ss")
        .args(["-H", "-t", "-i", "-n", "-p"])
        .env("LC_ALL", "C")
        .output();
    let Ok(output) = output else {
        return SshLinkSnapshot {
            supported: false,
            connected: true,
            sampled_at_ms: now_ms(),
            connection_id: Some(master_pid.to_string()),
            rx_bytes: 0,
            tx_bytes: 0,
            local_endpoint: None,
            remote_endpoint: None,
            warning: Some(
                "`ss` is unavailable; SSH-link byte counters cannot be read.".to_string(),
            ),
        };
    };
    let parsed = parse_ssh_link_ss(&String::from_utf8_lossy(&output.stdout), master_pid);
    parsed.unwrap_or_else(|| SshLinkSnapshot {
        supported: true,
        connected: true,
        sampled_at_ms: now_ms(),
        connection_id: Some(master_pid.to_string()),
        rx_bytes: 0,
        tx_bytes: 0,
        local_endpoint: None,
        remote_endpoint: None,
        warning: Some(
            "The SSH socket is connected, but its byte counters are not visible.".to_string(),
        ),
    })
}

#[cfg(not(target_os = "linux"))]
fn linux_ssh_link(_project_id: &str) -> SshLinkSnapshot {
    SshLinkSnapshot {
        supported: false,
        connected: false,
        sampled_at_ms: now_ms(),
        connection_id: None,
        rx_bytes: 0,
        tx_bytes: 0,
        local_endpoint: None,
        remote_endpoint: None,
        warning: Some("SSH-link monitoring is currently supported on Linux.".to_string()),
    }
}

fn counter(text: &str, key: &str) -> Option<u64> {
    let start = text.find(key)?;
    text[start + key.len()..]
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

fn parse_ssh_link_ss(text: &str, master_pid: u32) -> Option<SshLinkSnapshot> {
    let needle = format!("pid={master_pid},");
    let lines: Vec<&str> = text.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        if !line.contains(&needle) {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5 {
            continue;
        }
        let info = lines.get(index + 1).copied().unwrap_or_default();
        let tx_bytes = counter(info, "bytes_sent:")?;
        let rx_bytes = counter(info, "bytes_received:")?;
        return Some(SshLinkSnapshot {
            supported: true,
            connected: true,
            sampled_at_ms: now_ms(),
            connection_id: Some(format!("{master_pid}:{}:{}", fields[3], fields[4])),
            rx_bytes,
            tx_bytes,
            local_endpoint: Some(fields[3].to_string()),
            remote_endpoint: Some(fields[4].to_string()),
            warning: None,
        });
    }
    None
}

#[tauri::command]
pub async fn network_ssh_link_snapshot(
    pool: State<'_, RemotePoolState>,
    project_id: String,
) -> Result<SshLinkSnapshot, String> {
    if remote::remote_target_for(&project_id).is_none() {
        return Ok(linux_ssh_link(&project_id));
    }
    if !remote::is_connected(pool.inner(), &project_id).await {
        return Ok(SshLinkSnapshot {
            supported: cfg!(target_os = "linux"),
            connected: false,
            sampled_at_ms: now_ms(),
            connection_id: None,
            rx_bytes: 0,
            tx_bytes: 0,
            local_endpoint: None,
            remote_endpoint: None,
            warning: Some("Connect the SSH project to observe its link.".to_string()),
        });
    }
    tokio::task::spawn_blocking(move || linux_ssh_link(&project_id))
        .await
        .map_err(|e| format!("SSH-link snapshot task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proc_interfaces() {
        let input = "Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n  lo: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\neth0: 1234 2 0 0 0 0 0 0 5678 4 0 0 0 0 0 0\n";
        let parsed = parse_interfaces(input);
        assert_eq!(parsed.len(), 2);
        assert!(parsed[0].loopback);
        assert_eq!(parsed[1].name, "eth0");
        assert_eq!(parsed[1].rx_bytes, 1234);
        assert_eq!(parsed[1].tx_bytes, 5678);
    }

    #[test]
    fn parses_ipv4_ipv6_and_optional_processes() {
        let input = "tcp ESTAB 0 0 127.0.0.1:51000 10.0.0.2:22 users:((\"ssh\",pid=42,fd=3))\nudp UNCONN 0 0 [::]:5353 [::]:*\n";
        let parsed = parse_connections(input);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].process.as_deref(), Some("ssh"));
        assert_eq!(parsed[0].pid, Some(42));
        assert_eq!(parsed[1].local_address, "::");
        assert_eq!(parsed[1].remote_port, "*");
    }

    #[test]
    fn parses_control_master_pid() {
        assert_eq!(parse_master_pid("Master running (pid=8123)"), Some(8123));
        assert_eq!(parse_master_pid("Control socket connect failed"), None);
    }

    #[test]
    fn parses_ssh_transport_counters() {
        let input = "ESTAB 0 0 192.0.2.2:40000 198.51.100.4:22 users:((\"ssh\",pid=8123,fd=3))\n\t cubic wscale:7,7 bytes_sent:4567 bytes_received:8910 segs_out:2\n";
        let parsed = parse_ssh_link_ss(input, 8123).unwrap();
        assert_eq!(parsed.tx_bytes, 4567);
        assert_eq!(parsed.rx_bytes, 8910);
        assert_eq!(parsed.remote_endpoint.as_deref(), Some("198.51.100.4:22"));
    }

    #[test]
    fn remote_snapshot_without_ss_keeps_interface_data() {
        let output = "__ELDRUN_IFACES__\neth0: 12 0 0 0 0 0 0 0 34 0 0 0 0 0 0 0\n__ELDRUN_STATES__\neth0 up\n__ELDRUN_CONNECTIONS__\n__ELDRUN_NO_SS__\n";
        let parsed = parse_remote_snapshot(output, "host".to_string(), true);
        assert!(parsed.supported);
        assert!(parsed.interfaces[0].up);
        assert!(parsed.connections.is_none());
        assert!(parsed.warning.is_some());
    }
}
