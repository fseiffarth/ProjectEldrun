//! Project-VM lifecycle (`docs/vm_projects_plan.md`): the third trust tier.
//! A VM project's whole tree lives inside a locally booted QEMU/KVM guest that
//! Eldrun reaches **exclusively over SSH/SFTP** on a forwarded loopback port —
//! no shared filesystem, no virtiofs/9p, deliberately. From the moment the VM
//! is up, the project is an ordinary remote project (`services::remote` pool,
//! `ssh -tt` tabs, optional git lockstep); this module owns only what a real
//! remote host doesn't have: boot, readiness, shutdown, the per-VM SSH
//! identity, and the orphan sweep.
//!
//! Modeled on `services::sandbox`'s shape (preflight → ensure-running →
//! teardown → startup sweep), with the container's Docker daemon replaced by a
//! direct `qemu-system-x86_64 -enable-kvm` invocation: no libvirt, no root, no
//! bridge networking. Networking is user-mode slirp with a
//! `hostfwd=tcp:127.0.0.1:<port>-:22` forward; the egress story
//! (`services::vm_proxy`) hangs off the same netdev.
//!
//! State layout (`<state_dir>/vm/`):
//! ```text
//! images/<stock cloud image>, images/eldrun-base-<ver>.qcow2
//! <project-id>/disk.qcow2      # per-project qcow2 overlay (copy-on-write)
//! <project-id>/seed/…,seed.iso # cloud-init NoCloud seed (user, key, proxy env)
//! <project-id>/id_ed25519(.pub)# per-VM generated keypair
//! <project-id>/known_hosts     # per-VM host keys (never ~/.ssh/known_hosts)
//! <project-id>/qemu.pid, qmp.sock, serial.log, vm.json
//! ```
//!
//! The per-VM `UserKnownHostsFile` matters: a recreated VM has a new host key,
//! and the user's real `known_hosts` must never collect or conflict on
//! `[127.0.0.1]:<port>` entries. We booted this VM ourselves, so first-contact
//! trust is by construction — [`vm_ssh_opts`] injects the per-VM files into
//! every ssh argv aimed at a live VM's forwarded port (hooked in
//! `ssh_common`'s base builders + `ssh_exec::ssh_pty_args`).
//!
//! Ports are allocated fresh at every boot and rewritten into the project's
//! `RemoteSpec` (`projects.json` + `project.json`) before connecting — nothing
//! may assume they are stable across boots.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::schema::project::{Project, RemoteSpec, VmEgress, VmSpec};
use crate::schema::projects::ProjectsList;
use crate::storage;

/// The guest account every VM project runs as; its home holds the tree.
pub const VM_USER: &str = "eldrun";
/// The project root inside the guest — the `RemoteSpec.remote_path` a VM
/// project is created with.
pub const VM_PROJECT_DIR: &str = "/home/eldrun/project";

/// Baked-base-image version: bump when the bake recipe changes so an outdated
/// base is rebuilt on demand (never automatically).
pub const BASE_VERSION: u32 = 1;

/// The stock Ubuntu LTS cloud image the tier bootstraps from (fetch once,
/// checksum-verified against the release's own SHA256SUMS).
const STOCK_IMAGE_NAME: &str = "ubuntu-24.04-server-cloudimg-amd64.img";
const STOCK_IMAGE_URL: &str =
    "https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-amd64.img";
const STOCK_SUMS_URL: &str = "https://cloud-images.ubuntu.com/releases/noble/release/SHA256SUMS";

// ── Paths ──────────────────────────────────────────────────────────────────

pub fn vm_root() -> PathBuf {
    storage::state_dir().join("vm")
}

pub fn images_dir() -> PathBuf {
    vm_root().join("images")
}

pub fn vm_dir(project_id: &str) -> PathBuf {
    // Project ids are uuids (minted by us); sanitize anyway so a hand-edited
    // projects.json can never traverse out of the vm root.
    let safe: String = project_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    vm_root().join(safe)
}

fn stock_image_path() -> PathBuf {
    images_dir().join(STOCK_IMAGE_NAME)
}

fn baked_image_path() -> PathBuf {
    images_dir().join(format!("eldrun-base-{BASE_VERSION}.qcow2"))
}

/// The base image a new overlay should back onto: the baked toolchain image
/// when present, else the stock cloud image (bootable with sshd out of the
/// box — the bake only adds the agent toolchain). `None` when neither exists.
pub fn base_image_path() -> Option<PathBuf> {
    let baked = baked_image_path();
    if baked.is_file() {
        return Some(baked);
    }
    let stock = stock_image_path();
    stock.is_file().then_some(stock)
}

// ── Runtime state (vm.json + in-memory registry) ───────────────────────────

/// What a boot records in `<vm dir>/vm.json` — enough for the sweep and the
/// status pill to reason about a VM this process (or a crashed predecessor)
/// started.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VmRuntime {
    pub pid: u32,
    pub ssh_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_port: Option<u16>,
    pub egress: VmEgress,
    /// The base image the overlay was created against (display only).
    pub base_image: String,
}

#[derive(Debug, Clone)]
struct RunningVm {
    dir: PathBuf,
    runtime: VmRuntime,
}

fn registry() -> &'static Mutex<HashMap<String, RunningVm>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, RunningVm>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-project boot lock so two activations can't race a double boot.
fn boot_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn boot_lock_for(project_id: &str) -> Arc<Mutex<()>> {
    boot_locks()
        .lock()
        .unwrap()
        .entry(project_id.to_string())
        .or_default()
        .clone()
}

/// Extra `ssh -o` options for a target that is a live project VM: the per-VM
/// known_hosts + identity. Empty for every other target, so the `ssh_common`
/// base builders can call this unconditionally. Matching is by (loopback
/// host, forwarded port) against the in-memory registry — only a VM booted by
/// this process can match, which is exactly the authorization the bypass
/// needs (we generated the key and booted the machine ourselves).
pub fn vm_ssh_opts(host: &str, port: Option<u16>) -> Vec<String> {
    let Some(port) = port else { return Vec::new() };
    let host = host.trim().to_ascii_lowercase();
    if host != "127.0.0.1" && host != "localhost" && host != "::1" {
        return Vec::new();
    }
    let reg = registry().lock().unwrap();
    let Some(vm) = reg.values().find(|vm| vm.runtime.ssh_port == port) else {
        return Vec::new();
    };
    vec![
        "-o".to_string(),
        format!(
            "UserKnownHostsFile={}",
            vm.dir.join("known_hosts").to_string_lossy()
        ),
        "-o".to_string(),
        format!(
            "IdentityFile={}",
            vm.dir.join("id_ed25519").to_string_lossy()
        ),
        "-o".to_string(),
        "IdentitiesOnly=yes".to_string(),
    ]
}

/// Whether a `RemoteSpec` is a project VM's synthesized endpoint (the marker
/// written at creation — see `schema::project::RemoteSpec::vm`).
pub fn is_vm_spec(spec: &RemoteSpec) -> bool {
    spec.vm == Some(true)
}

/// The `VmSpec` mirrored into a `projects.json` entry's `extra["vm"]`, or
/// `None` for a non-VM project. The always-local copy, like `sandbox`'s.
pub fn vm_spec_for(project_id: &str) -> Option<VmSpec> {
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = storage::read_json(&list_path).ok()?;
    let entry = list.into_iter().find(|e| e.id == project_id)?;
    let value = entry.extra.get("vm")?;
    serde_json::from_value(value.clone()).ok()
}

/// Whether this project's VM is currently running (registry + live pid).
pub fn is_running(project_id: &str) -> bool {
    let reg = registry().lock().unwrap();
    reg.get(project_id)
        .map(|vm| pid_alive(vm.runtime.pid))
        .unwrap_or(false)
}

/// The live runtime record for a running VM (`None` when off).
pub fn running_state(project_id: &str) -> Option<VmRuntime> {
    let reg = registry().lock().unwrap();
    reg.get(project_id)
        .filter(|vm| pid_alive(vm.runtime.pid))
        .map(|vm| vm.runtime.clone())
}

// ── Doctor ─────────────────────────────────────────────────────────────────

/// The creation dialog's preflight verdict (surfaced like the sandbox's Docker
/// preflight): can this machine boot project VMs, and what's missing if not.
#[derive(Debug, Clone, Serialize)]
pub struct VmDoctorReport {
    /// Linux-only initially — elsewhere the tier is hidden, like the container
    /// toggle on Windows.
    pub supported: bool,
    /// Everything needed to boot is present (base image handled separately —
    /// missing base is a one-click fetch, not an unavailable tier).
    pub ok: bool,
    pub qemu: bool,
    pub kvm: bool,
    pub qemu_img: bool,
    /// Which ISO-authoring tool the seed will use, when one is installed.
    pub iso_tool: Option<String>,
    /// Free space in the state dir's filesystem, GiB.
    pub disk_free_gb: Option<u64>,
    /// Whether a base image (stock or baked) is already on disk.
    pub base_image_ready: bool,
    /// Whether the *baked* (toolchain) image is on disk — when false a VM
    /// still boots from the stock image, just without the agent toolchain.
    pub baked_image_ready: bool,
    /// Actionable text for each failed probe.
    pub reasons: Vec<String>,
    /// For a missing base image: the build-tab command that fetches it
    /// (house convention — one click, never copy-it-yourself).
    pub fetch_command: Option<String>,
    /// The build-tab command that bakes the toolchain base image (Phase 3).
    pub bake_command: Option<String>,
}

/// The raw probe results [`doctor_verdict`] reasons from — split so the
/// verdict is testable without qemu on the test machine.
#[derive(Debug, Clone, Default)]
pub struct VmDoctorProbes {
    pub supported: bool,
    pub qemu: bool,
    pub kvm: bool,
    pub kvm_reason: Option<String>,
    pub qemu_img: bool,
    pub iso_tool: Option<String>,
    pub disk_free_gb: Option<u64>,
    pub base_image_ready: bool,
    pub baked_image_ready: bool,
}

/// Pure: fold probe results into the report (minus the command fields, which
/// need real paths).
pub fn doctor_verdict(p: &VmDoctorProbes) -> VmDoctorReport {
    let mut reasons = Vec::new();
    if !p.supported {
        reasons.push("Project VMs are Linux-only for now.".to_string());
    } else {
        if !p.qemu {
            reasons.push(
                "'qemu-system-x86_64' not found. Install QEMU (e.g. `sudo apt install qemu-system-x86`)."
                    .to_string(),
            );
        }
        if !p.kvm {
            reasons.push(p.kvm_reason.clone().unwrap_or_else(|| {
                "/dev/kvm is not accessible. Enable virtualization in firmware and add your user to the 'kvm' group."
                    .to_string()
            }));
        }
        if !p.qemu_img {
            reasons.push("'qemu-img' not found (part of qemu-utils).".to_string());
        }
        if p.iso_tool.is_none() {
            reasons.push(
                "No cloud-init seed tool found. Install one of: genisoimage, mkisofs, xorriso, or cloud-image-utils (cloud-localds)."
                    .to_string(),
            );
        }
        if let Some(free) = p.disk_free_gb {
            if free < 8 {
                reasons.push(format!(
                    "Low disk space in the Eldrun state dir ({free} GiB free); a VM overlay can grow to tens of GiB."
                ));
            }
        }
    }
    let ok = p.supported && p.qemu && p.kvm && p.qemu_img && p.iso_tool.is_some();
    VmDoctorReport {
        supported: p.supported,
        ok,
        qemu: p.qemu,
        kvm: p.kvm,
        qemu_img: p.qemu_img,
        iso_tool: p.iso_tool.clone(),
        disk_free_gb: p.disk_free_gb,
        base_image_ready: p.base_image_ready,
        baked_image_ready: p.baked_image_ready,
        reasons,
        fetch_command: None,
        bake_command: None,
    }
}

/// Parse `df -Pk <dir>` output → available KiB (the 4th column of the data
/// line). POSIX `-P` format, so the layout is stable.
pub fn parse_df_avail_kib(output: &str) -> Option<u64> {
    let line = output.lines().nth(1)?;
    line.split_whitespace().nth(3)?.parse().ok()
}

fn binary_ok(bin: &str, arg: &str) -> bool {
    crate::paths::command_no_window(bin)
        .arg(arg)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Which ISO tool builds the seed, in preference order. The style decides the
/// argv shape ([`seed_iso_args`]).
pub fn pick_iso_tool() -> Option<&'static str> {
    ["genisoimage", "mkisofs", "xorriso", "cloud-localds"]
        .into_iter()
        .find(|tool| crate::paths::resolve_executable(tool).is_some())
}

/// The argv (after the binary) that authors `seed.iso` from `user-data` +
/// `meta-data` in the current directory. Pure.
pub fn seed_iso_args(tool: &str) -> Vec<String> {
    let mkisofs_style = [
        "-output",
        "seed.iso",
        "-volid",
        "cidata",
        "-joliet",
        "-rock",
        "user-data",
        "meta-data",
    ];
    match tool {
        "xorriso" => {
            let mut args = vec!["-as".to_string(), "mkisofs".to_string()];
            args.extend(mkisofs_style.iter().map(|s| s.to_string()));
            args
        }
        "cloud-localds" => ["seed.iso", "user-data", "meta-data"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        _ => mkisofs_style.iter().map(|s| s.to_string()).collect(),
    }
}

fn probe_kvm() -> (bool, Option<String>) {
    #[cfg(target_os = "linux")]
    {
        let path = Path::new("/dev/kvm");
        if !path.exists() {
            return (
                false,
                Some(
                    "/dev/kvm does not exist — enable VT-x/AMD-V in firmware (and the kvm modules)."
                        .to_string(),
                ),
            );
        }
        match std::fs::OpenOptions::new().read(true).write(true).open(path) {
            Ok(_) => (true, None),
            Err(e) => (
                false,
                Some(format!(
                    "/dev/kvm exists but is not accessible ({e}). Add your user to the 'kvm' group and re-login."
                )),
            ),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        (false, None)
    }
}

fn disk_free_gb(dir: &Path) -> Option<u64> {
    let out = crate::paths::command_no_window("df")
        .arg("-Pk")
        .arg(dir)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_df_avail_kib(&String::from_utf8_lossy(&out.stdout)).map(|kib| kib / (1024 * 1024))
}

/// Run the full doctor probe. Slowish (a few process spawns) — call from
/// `spawn_blocking`.
pub fn doctor() -> VmDoctorReport {
    let supported = cfg!(target_os = "linux");
    let (kvm, kvm_reason) = if supported {
        probe_kvm()
    } else {
        (false, None)
    };
    let probes = VmDoctorProbes {
        supported,
        qemu: supported && binary_ok("qemu-system-x86_64", "--version"),
        kvm,
        kvm_reason,
        qemu_img: supported && binary_ok("qemu-img", "--version"),
        iso_tool: if supported {
            pick_iso_tool().map(str::to_string)
        } else {
            None
        },
        disk_free_gb: if supported {
            let root = vm_root();
            let _ = std::fs::create_dir_all(&root);
            disk_free_gb(&root)
        } else {
            None
        },
        base_image_ready: base_image_path().is_some(),
        baked_image_ready: baked_image_path().is_file(),
    };
    let mut report = doctor_verdict(&probes);
    if report.ok && !report.base_image_ready {
        report.fetch_command = fetch_base_command().ok();
    }
    if report.ok && report.base_image_ready && !report.baked_image_ready {
        report.bake_command = build_base_command().ok();
    }
    report
}

// ── Base image: fetch + bake (build-tab commands) ──────────────────────────

/// Write the checksum-verified stock-image fetch script and return the
/// build-tab command that runs it (same UX as the sandbox's missing-image
/// build: one click, streamed output, never copy-it-yourself).
pub fn fetch_base_command() -> Result<String, String> {
    let images = images_dir();
    std::fs::create_dir_all(&images).map_err(|e| e.to_string())?;
    let script = format!(
        r#"#!/usr/bin/env bash
set -euo pipefail
cd '{images}'
echo '── Fetching Ubuntu 24.04 cloud image (~600 MB) ──'
curl -fL --progress-bar -o '{name}.part' '{url}'
echo '── Verifying checksum ──'
curl -fsSL -o SHA256SUMS '{sums}'
awk -v f='{name}' '($2 == f || $2 == "*" f) {{ print $1 "  " f ".part" }}' SHA256SUMS | sha256sum -c -
mv '{name}.part' '{name}'
echo '── Base image ready. New VM projects can boot now. ──'
"#,
        images = images.display(),
        name = STOCK_IMAGE_NAME,
        url = STOCK_IMAGE_URL,
        sums = STOCK_SUMS_URL,
    );
    let path = vm_root().join("fetch-base.sh");
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    Ok(format!("bash '{}'", path.display()))
}

/// The provisioning cloud-config the bake boots with: install the agent
/// toolchain, then power down. Pure so the recipe is testable.
pub fn bake_user_data() -> String {
    // node via NodeSource keeps the npm-installed agent CLIs current enough;
    // the stock 24.04 nodejs is fine for all three CLIs today, so stay with
    // the distro package — fewer moving parts inside the trust boundary.
    r#"#cloud-config
package_update: true
packages:
  - git
  - build-essential
  - tmux
  - nodejs
  - npm
  - python3
  - python3-venv
runcmd:
  - [sh, -c, "npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli || true"]
  - [sh, -c, "echo ELDRUN_BAKE_DONE"]
power_state:
  mode: poweroff
  timeout: 60
"#
    .to_string()
}

/// Write the bake script + provisioning seed inputs and return the build-tab
/// command. The bake boots the stock image once with `-serial stdio`, so the
/// guest's own cloud-init output streams into the tab as build progress;
/// cloud-init powers the VM off when done and the script converts the overlay
/// into `eldrun-base-<ver>.qcow2`.
pub fn build_base_command() -> Result<String, String> {
    let root = vm_root();
    let bake = root.join("bake");
    std::fs::create_dir_all(&bake).map_err(|e| e.to_string())?;
    std::fs::write(bake.join("user-data"), bake_user_data()).map_err(|e| e.to_string())?;
    std::fs::write(
        bake.join("meta-data"),
        cloud_init_meta_data("eldrun-bake", "eldrun-bake"),
    )
    .map_err(|e| e.to_string())?;
    let tool = pick_iso_tool().ok_or_else(|| {
        "No cloud-init seed tool found (genisoimage/mkisofs/xorriso/cloud-localds)".to_string()
    })?;
    let iso_argv = seed_iso_args(tool)
        .iter()
        .map(|a| format!("'{a}'"))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        r#"#!/usr/bin/env bash
set -euo pipefail
cd '{bake}'
echo '── Building the Eldrun VM base image (installs git, build tools, node, agent CLIs) ──'
rm -f seed.iso disk.qcow2
{tool} {iso_argv}
qemu-img create -f qcow2 -b '{stock}' -F qcow2 disk.qcow2 32G
echo '── Booting provisioning VM (5–10 min; console output follows) ──'
qemu-system-x86_64 -enable-kvm -machine q35 -cpu host -m 4096 -smp 2 \
  -drive file=disk.qcow2,if=virtio,format=qcow2 \
  -drive file=seed.iso,if=virtio,media=cdrom,format=raw,readonly=on \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  -display none -serial stdio
echo '── Converting to base image ──'
qemu-img convert -O qcow2 disk.qcow2 '{baked}.part'
mv '{baked}.part' '{baked}'
rm -f disk.qcow2 seed.iso
echo '── Baked base image ready: {baked} ──'
echo '   New VM projects boot from it; existing VMs keep their current disk.'
"#,
        bake = bake.display(),
        tool = tool,
        iso_argv = iso_argv,
        stock = stock_image_path().display(),
        baked = baked_image_path().display(),
    );
    let path = root.join("bake-base.sh");
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    Ok(format!("bash '{}'", path.display()))
}

// ── cloud-init seed (per project) ──────────────────────────────────────────

/// Guest-safe hostname from a project name: ASCII alphanumerics and dashes.
pub fn vm_hostname(project_name: &str) -> String {
    let mut out = String::new();
    for c in project_name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if (c == '-' || c == ' ' || c == '_') && !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "eldrun-vm".to_string()
    } else {
        let mut name = String::from("vm-");
        name.push_str(&trimmed.chars().take(24).collect::<String>());
        name.trim_end_matches('-').to_string()
    }
}

/// The per-project NoCloud `user-data`: the `eldrun` account with the per-VM
/// public key, the project dir, and — under `Proxy` egress — the proxy env
/// pointing at the fixed guest-side `guestfwd` address. Pure.
pub fn cloud_init_user_data(hostname: &str, pubkey: &str, proxy: bool) -> String {
    let mut doc = format!(
        r#"#cloud-config
hostname: {hostname}
users:
  - name: {user}
    shell: /bin/bash
    groups: [sudo]
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    lock_passwd: true
    ssh_authorized_keys:
      - {pubkey}
ssh_pwauth: false
"#,
        hostname = hostname,
        user = VM_USER,
        pubkey = pubkey.trim(),
    );
    if proxy {
        let addr = crate::services::vm_proxy::GUEST_PROXY_ADDR;
        doc.push_str(&format!(
            r#"write_files:
  - path: /etc/profile.d/eldrun-proxy.sh
    permissions: '0644'
    content: |
      export http_proxy=http://{addr}
      export https_proxy=http://{addr}
      export HTTP_PROXY=http://{addr}
      export HTTPS_PROXY=http://{addr}
      export no_proxy=localhost,127.0.0.1,::1
      export NO_PROXY=localhost,127.0.0.1,::1
  - path: /etc/apt/apt.conf.d/95eldrun-proxy
    permissions: '0644'
    content: |
      Acquire::http::Proxy "http://{addr}";
      Acquire::https::Proxy "http://{addr}";
"#,
        ));
    }
    doc.push_str(&format!(
        r#"runcmd:
  - mkdir -p {dir}
  - chown {user}:{user} {dir}
"#,
        dir = VM_PROJECT_DIR,
        user = VM_USER,
    ));
    if proxy {
        let addr = crate::services::vm_proxy::GUEST_PROXY_ADDR;
        doc.push_str(&format!(
            "  - [sh, -c, \"printf 'http_proxy=http://{addr}\\nhttps_proxy=http://{addr}\\nHTTP_PROXY=http://{addr}\\nHTTPS_PROXY=http://{addr}\\nno_proxy=localhost,127.0.0.1,::1\\nNO_PROXY=localhost,127.0.0.1,::1\\n' >> /etc/environment\"]\n",
        ));
    }
    doc
}

/// NoCloud `meta-data`. The instance id folds in the user-data's content hash
/// ([`seed_instance_id`]) so an egress-mode change re-runs cloud-init's
/// per-instance modules on the next boot instead of being silently ignored.
pub fn cloud_init_meta_data(instance_id: &str, hostname: &str) -> String {
    format!("instance-id: {instance_id}\nlocal-hostname: {hostname}\n")
}

/// Instance id for a seed: stable while the config is, new when it changes.
pub fn seed_instance_id(project_id: &str, user_data: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(user_data.as_bytes());
    let digest = hasher.finalize();
    let hash_hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    let id8: String = project_id.chars().take(8).collect();
    format!("eldrun-{id8}-{hash_hex}")
}

// ── QEMU argv (pure builders) ──────────────────────────────────────────────

/// The `-netdev user,…` argument for an egress mode. `Off` and `Proxy` set
/// slirp `restrict=on` (guest is isolated from host and world; the explicit
/// `hostfwd`/`guestfwd` rules still work — that is documented slirp behavior
/// and the entire point: ssh in via the forward, and under Proxy exactly one
/// way out, through the allowlisting CONNECT proxy).
pub fn netdev_arg(egress: VmEgress, ssh_port: u16, proxy_port: Option<u16>) -> String {
    let base = format!("user,id=net0,hostfwd=tcp:127.0.0.1:{ssh_port}-:22");
    match egress {
        VmEgress::Open => base,
        VmEgress::Off => format!("{base},restrict=on"),
        VmEgress::Proxy => {
            let proxy = proxy_port.expect("Proxy egress requires a proxy port");
            let guest = crate::services::vm_proxy::GUEST_PROXY_ADDR;
            format!("{base},restrict=on,guestfwd=tcp:{guest}-tcp:127.0.0.1:{proxy}")
        }
    }
}

/// Full QEMU argv (after the binary) for a project VM boot. Pure.
#[allow(clippy::too_many_arguments)]
pub fn qemu_args(
    memory_mb: u32,
    cpus: u32,
    disk: &Path,
    seed: &Path,
    netdev: &str,
    pidfile: &Path,
    qmp_sock: &Path,
    serial_log: &Path,
) -> Vec<String> {
    vec![
        "-enable-kvm".to_string(),
        "-machine".to_string(),
        "q35".to_string(),
        "-cpu".to_string(),
        "host".to_string(),
        "-m".to_string(),
        memory_mb.to_string(),
        "-smp".to_string(),
        cpus.to_string(),
        "-drive".to_string(),
        format!(
            "file={},if=virtio,format=qcow2,discard=unmap",
            disk.display()
        ),
        "-drive".to_string(),
        format!(
            "file={},if=virtio,media=cdrom,format=raw,readonly=on",
            seed.display()
        ),
        "-netdev".to_string(),
        netdev.to_string(),
        "-device".to_string(),
        "virtio-net-pci,netdev=net0".to_string(),
        "-display".to_string(),
        "none".to_string(),
        "-daemonize".to_string(),
        "-pidfile".to_string(),
        pidfile.display().to_string(),
        "-qmp".to_string(),
        format!("unix:{},server=on,wait=off", qmp_sock.display()),
        "-serial".to_string(),
        format!("file:{}", serial_log.display()),
    ]
}

// ── Boot ───────────────────────────────────────────────────────────────────

fn alloc_loopback_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("no free loopback port: {e}"))
}

fn ensure_keypair(dir: &Path) -> Result<String, String> {
    let key = dir.join("id_ed25519");
    if !key.exists() {
        let out = crate::paths::command_no_window("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", "eldrun-vm", "-f"])
            .arg(&key)
            .output()
            .map_err(|e| format!("ssh-keygen: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "ssh-keygen failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    std::fs::read_to_string(dir.join("id_ed25519.pub"))
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("read VM public key: {e}"))
}

fn ensure_overlay(dir: &Path, disk_gb: u32) -> Result<(PathBuf, String), String> {
    let disk = dir.join("disk.qcow2");
    let base = base_image_path().ok_or_else(|| {
        "No VM base image yet. Run the one-click fetch from the VM doctor / creation dialog first."
            .to_string()
    })?;
    if !disk.exists() {
        let out = crate::paths::command_no_window("qemu-img")
            .args(["create", "-f", "qcow2", "-b"])
            .arg(&base)
            .args(["-F", "qcow2"])
            .arg(&disk)
            .arg(format!("{disk_gb}G"))
            .output()
            .map_err(|e| format!("qemu-img: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "qemu-img create failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    Ok((disk, base.display().to_string()))
}

fn ensure_seed(
    dir: &Path,
    project_id: &str,
    hostname: &str,
    pubkey: &str,
    proxy: bool,
) -> Result<PathBuf, String> {
    let seed_dir = dir.join("seed");
    std::fs::create_dir_all(&seed_dir).map_err(|e| e.to_string())?;
    let user_data = cloud_init_user_data(hostname, pubkey, proxy);
    let meta_data = cloud_init_meta_data(&seed_instance_id(project_id, &user_data), hostname);
    let iso = dir.join("seed.iso");

    // Rebuild only when the inputs changed — the iso is consumed on every
    // boot, but cloud-init re-applies per-instance config only when the
    // instance id moves, so a stable config keeps a stable seed.
    let stale = std::fs::read_to_string(seed_dir.join("user-data"))
        .map(|prev| prev != user_data)
        .unwrap_or(true);
    if stale || !iso.is_file() {
        std::fs::write(seed_dir.join("user-data"), &user_data).map_err(|e| e.to_string())?;
        std::fs::write(seed_dir.join("meta-data"), &meta_data).map_err(|e| e.to_string())?;
        let tool = pick_iso_tool().ok_or_else(|| {
            "No cloud-init seed tool (genisoimage/mkisofs/xorriso/cloud-localds) installed"
                .to_string()
        })?;
        let out = crate::paths::command_no_window(tool)
            .args(seed_iso_args(tool))
            .current_dir(&seed_dir)
            .output()
            .map_err(|e| format!("{tool}: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "{tool} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        std::fs::rename(seed_dir.join("seed.iso"), &iso).map_err(|e| e.to_string())?;
    }
    Ok(iso)
}

/// Rewrite the project's `RemoteSpec` endpoint (host/port/key_auth/vm marker)
/// in BOTH `projects.json` (the always-local truth every resolver reads) and
/// the project's own `project.json` — before anything connects. Ports are
/// per-boot; this is the one writer.
fn record_vm_endpoint(project_id: &str, ssh_port: u16) -> Result<(), String> {
    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = storage::read_json(&list_path).map_err(|e| e.to_string())?;
    let entry = list
        .iter_mut()
        .find(|e| e.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    let mut spec: RemoteSpec = entry
        .extra
        .get("remote")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .ok_or_else(|| format!("VM project '{project_id}' has no remote spec"))?;
    spec.host = "127.0.0.1".to_string();
    spec.port = Some(ssh_port);
    spec.key_auth = Some(true);
    spec.vm = Some(true);
    entry.extra.insert(
        "remote".to_string(),
        serde_json::to_value(&spec).map_err(|e| e.to_string())?,
    );
    let local_file = entry.local_file.clone();
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;

    let proj_path = PathBuf::from(local_file);
    if let Ok(mut project) = storage::read_json::<Project>(&proj_path) {
        project.remote = Some(spec);
        let _ = storage::write_json(&proj_path, &project);
    }
    Ok(())
}

/// Poll the forwarded port until sshd answers with its banner (or time out).
/// First boot includes cloud-init user creation + host-key generation, so the
/// window is generous; a warm boot answers in seconds.
fn wait_ssh_ready(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    while Instant::now() < deadline {
        if let Ok(mut conn) =
            std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(800))
        {
            let _ = conn.set_read_timeout(Some(Duration::from_secs(3)));
            let mut buf = [0u8; 4];
            if let Ok(n) = conn.read(&mut buf) {
                if n >= 4 && &buf[..4] == b"SSH-" {
                    return Ok(());
                }
            }
        }
        std::thread::sleep(Duration::from_millis(700));
    }
    Err(format!(
        "VM did not become reachable on 127.0.0.1:{port} within {}s (see serial.log in the VM state dir)",
        timeout.as_secs()
    ))
}

/// Boot the project's VM if it isn't running, and return the live runtime.
/// Idempotent; blocking (call from `spawn_blocking`). On success the
/// project's `RemoteSpec` already points at the fresh forwarded port and sshd
/// has answered — `remote_connect` can proceed immediately.
pub fn ensure_booted(project_id: &str, project_name: &str) -> Result<VmRuntime, String> {
    let lock = boot_lock_for(project_id);
    let _guard = lock.lock().unwrap();

    if let Some(runtime) = running_state(project_id) {
        return Ok(runtime);
    }
    // Not (live-)registered: clear any stale entry.
    registry().lock().unwrap().remove(project_id);

    let spec = vm_spec_for(project_id)
        .ok_or_else(|| format!("project '{project_id}' has no VM config"))?;
    if !spec.enabled {
        return Err("This project's VM is disabled.".to_string());
    }

    let dir = vm_dir(project_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let pubkey = ensure_keypair(&dir)?;
    let (disk, base_image) = ensure_overlay(&dir, spec.disk_gb)?;

    // Egress proxy first — the seed bakes whether proxy env exists, and the
    // netdev needs the listener's port.
    let proxy_port = match spec.egress {
        VmEgress::Proxy => Some(crate::services::vm_proxy::ensure_proxy(
            project_id,
            crate::services::vm_proxy::allowlist_for(&spec.allow_hosts, spec.allow_github),
        )?),
        _ => None,
    };

    let hostname = vm_hostname(project_name);
    let seed = ensure_seed(
        &dir,
        project_id,
        &hostname,
        &pubkey,
        matches!(spec.egress, VmEgress::Proxy),
    )?;

    let ssh_port = alloc_loopback_port()?;
    let pidfile = dir.join("qemu.pid");
    let qmp_sock = dir.join("qmp.sock");
    let serial_log = dir.join("serial.log");
    let _ = std::fs::remove_file(&pidfile);
    let _ = std::fs::remove_file(&qmp_sock);

    let netdev = netdev_arg(spec.egress, ssh_port, proxy_port);
    let args = qemu_args(
        spec.memory_mb,
        spec.cpus,
        &disk,
        &seed,
        &netdev,
        &pidfile,
        &qmp_sock,
        &serial_log,
    );
    let out = crate::paths::command_no_window("qemu-system-x86_64")
        .args(&args)
        .output()
        .map_err(|e| format!("qemu-system-x86_64: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "QEMU failed to start: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    // `-daemonize`: the parent exits once the daemon is up and the pidfile is
    // written.
    let pid: u32 = std::fs::read_to_string(&pidfile)
        .map_err(|e| format!("read qemu pidfile: {e}"))?
        .trim()
        .parse()
        .map_err(|_| "unparseable qemu pidfile".to_string())?;

    let runtime = VmRuntime {
        pid,
        ssh_port,
        proxy_port,
        egress: spec.egress,
        base_image,
    };
    storage::write_json(&dir.join("vm.json"), &runtime).map_err(|e| e.to_string())?;
    registry().lock().unwrap().insert(
        project_id.to_string(),
        RunningVm {
            dir: dir.clone(),
            runtime: runtime.clone(),
        },
    );
    // The endpoint must be recorded before readiness: a parallel caller that
    // sees the registry entry may resolve the spec at any point from here.
    record_vm_endpoint(project_id, ssh_port)?;

    if let Err(e) = wait_ssh_ready(ssh_port, Duration::from_secs(180)) {
        // A VM that never answered is torn down rather than left half-up: the
        // next attempt starts clean, and no stale registry entry keeps
        // authorizing ssh options for a dead port.
        shutdown(project_id);
        return Err(e);
    }
    Ok(runtime)
}

// ── Shutdown / sweep ───────────────────────────────────────────────────────

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

#[cfg(unix)]
fn signal_pid(pid: u32, sig: i32) {
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

/// Ask QEMU for an ACPI powerdown over its QMP socket. Best-effort: any
/// failure falls through to the signal escalation.
fn qmp_powerdown(sock: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::net::UnixStream;
        let mut conn = UnixStream::connect(sock).map_err(|e| e.to_string())?;
        conn.set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        conn.set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        // Greeting → capabilities negotiation → command. Replies are read
        // loosely; we only need the socket to accept the command.
        let mut buf = [0u8; 1024];
        let _ = conn.read(&mut buf);
        conn.write_all(b"{\"execute\":\"qmp_capabilities\"}\n")
            .map_err(|e| e.to_string())?;
        let _ = conn.read(&mut buf);
        conn.write_all(b"{\"execute\":\"system_powerdown\"}\n")
            .map_err(|e| e.to_string())?;
        let _ = conn.read(&mut buf);
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = sock;
        Err("unsupported".to_string())
    }
}

fn wait_pid_gone(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !pid_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    !pid_alive(pid)
}

fn teardown_runtime_files(dir: &Path) {
    for name in ["qemu.pid", "qmp.sock", "vm.json"] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// Shut the project's VM down: ACPI powerdown via QMP, escalate to SIGTERM
/// then SIGKILL after a grace period. Idempotent; also stops the egress
/// proxy and clears runtime state.
pub fn shutdown(project_id: &str) {
    let removed = registry().lock().unwrap().remove(project_id);
    let dir = removed
        .as_ref()
        .map(|vm| vm.dir.clone())
        .unwrap_or_else(|| vm_dir(project_id));
    let pid = removed.map(|vm| vm.runtime.pid).or_else(|| {
        std::fs::read_to_string(dir.join("qemu.pid"))
            .ok()
            .and_then(|s| s.trim().parse().ok())
    });

    if let Some(pid) = pid.filter(|&p| pid_alive(p)) {
        let clean = qmp_powerdown(&dir.join("qmp.sock")).is_ok()
            && wait_pid_gone(pid, Duration::from_secs(15));
        #[cfg(unix)]
        if !clean {
            signal_pid(pid, libc::SIGTERM);
            if !wait_pid_gone(pid, Duration::from_secs(5)) {
                signal_pid(pid, libc::SIGKILL);
                wait_pid_gone(pid, Duration::from_secs(2));
            }
        }
        #[cfg(not(unix))]
        let _ = clean;
    }
    crate::services::vm_proxy::stop_proxy(project_id);
    teardown_runtime_files(&dir);
}

/// Shut down every VM this process booted (app exit). VM lifetime is the app
/// session, never longer — like the project containers.
pub fn down_all() {
    let ids: Vec<String> = registry().lock().unwrap().keys().cloned().collect();
    for id in ids {
        shutdown(&id);
    }
}

/// Startup sweep: reap QEMUs a previous (crashed) run left behind, by
/// pidfile. A VM's lifetime is its app session, so anything alive at startup
/// is an orphan. Only pids whose process is actually qemu are signalled — a
/// recycled pid must never kill an innocent process.
pub fn sweep_orphans() {
    let root = vm_root();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() || entry.file_name() == "images" || entry.file_name() == "bake" {
            continue;
        }
        let Ok(pid_text) = std::fs::read_to_string(dir.join("qemu.pid")) else {
            teardown_runtime_files(&dir);
            continue;
        };
        let Ok(pid) = pid_text.trim().parse::<u32>() else {
            teardown_runtime_files(&dir);
            continue;
        };
        if pid_alive(pid) && process_is_qemu(pid) {
            #[cfg(unix)]
            {
                signal_pid(pid, libc::SIGTERM);
                if !wait_pid_gone(pid, Duration::from_secs(5)) {
                    signal_pid(pid, libc::SIGKILL);
                }
            }
        }
        teardown_runtime_files(&dir);
    }
}

fn process_is_qemu(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .map(|comm| comm.trim().starts_with("qemu"))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        false
    }
}

// ── Rebuild / delete ───────────────────────────────────────────────────────

/// Recreate the VM's disk from the base image: delete the overlay (and the
/// seed, so cloud-init re-provisions). Refused while the VM runs. In-VM
/// uncommitted work dies with the overlay — the caller owns the confirm.
pub fn rebuild(project_id: &str) -> Result<(), String> {
    if is_running(project_id) {
        return Err("Shut the VM down before rebuilding it.".to_string());
    }
    let dir = vm_dir(project_id);
    for name in ["disk.qcow2", "seed.iso"] {
        let path = dir.join(name);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("remove {name}: {e}"))?;
        }
    }
    let _ = std::fs::remove_dir_all(dir.join("seed"));
    Ok(())
}

/// Tear down and delete every trace of the project's VM (project delete).
/// The overlay **is** the working tree for a mirrorless VM project — the
/// caller's confirm dialog must have said so by name.
pub fn delete_state(project_id: &str) {
    shutdown(project_id);
    let _ = std::fs::remove_dir_all(vm_dir(project_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── doctor_verdict ─────────────────────────────────────────────────────

    fn good_probes() -> VmDoctorProbes {
        VmDoctorProbes {
            supported: true,
            qemu: true,
            kvm: true,
            kvm_reason: None,
            qemu_img: true,
            iso_tool: Some("genisoimage".to_string()),
            disk_free_gb: Some(100),
            base_image_ready: true,
            baked_image_ready: false,
        }
    }

    #[test]
    fn doctor_ok_when_all_probes_pass() {
        let report = doctor_verdict(&good_probes());
        assert!(report.ok);
        assert!(report.reasons.is_empty());
    }

    #[test]
    fn doctor_missing_base_image_is_not_a_failure() {
        // A missing base image is a one-click fetch, not an unavailable tier.
        let probes = VmDoctorProbes {
            base_image_ready: false,
            ..good_probes()
        };
        let report = doctor_verdict(&probes);
        assert!(report.ok);
        assert!(!report.base_image_ready);
    }

    #[test]
    fn doctor_unsupported_platform_fails_with_one_reason() {
        let probes = VmDoctorProbes {
            supported: false,
            ..Default::default()
        };
        let report = doctor_verdict(&probes);
        assert!(!report.ok);
        assert_eq!(report.reasons.len(), 1);
    }

    #[test]
    fn doctor_names_each_missing_piece() {
        let probes = VmDoctorProbes {
            qemu: false,
            kvm: false,
            kvm_reason: Some("kvm group".to_string()),
            iso_tool: None,
            ..good_probes()
        };
        let report = doctor_verdict(&probes);
        assert!(!report.ok);
        assert!(report
            .reasons
            .iter()
            .any(|r| r.contains("qemu-system-x86_64")));
        assert!(report.reasons.iter().any(|r| r == "kvm group"));
        assert!(report.reasons.iter().any(|r| r.contains("genisoimage")));
    }

    #[test]
    fn doctor_warns_on_low_disk() {
        let probes = VmDoctorProbes {
            disk_free_gb: Some(3),
            ..good_probes()
        };
        let report = doctor_verdict(&probes);
        // Low disk warns but doesn't gate: the overlay may stay small.
        assert!(report.ok);
        assert!(report.reasons.iter().any(|r| r.contains("disk space")));
    }

    // ── parse_df_avail_kib ─────────────────────────────────────────────────

    #[test]
    fn parses_posix_df_output() {
        let out = "Filesystem 1024-blocks Used Available Capacity Mounted on\n\
                   /dev/sda2  959786032 424742868 486206732  47% /\n";
        assert_eq!(parse_df_avail_kib(out), Some(486_206_732));
        assert_eq!(parse_df_avail_kib("garbage"), None);
    }

    // ── netdev / qemu argv ─────────────────────────────────────────────────

    #[test]
    fn netdev_open_is_plain_nat_with_ssh_forward() {
        let arg = netdev_arg(VmEgress::Open, 40022, None);
        assert_eq!(arg, "user,id=net0,hostfwd=tcp:127.0.0.1:40022-:22");
    }

    #[test]
    fn netdev_off_restricts_and_keeps_the_ssh_forward() {
        let arg = netdev_arg(VmEgress::Off, 40022, None);
        assert!(arg.contains("restrict=on"), "{arg}");
        assert!(arg.contains("hostfwd=tcp:127.0.0.1:40022-:22"), "{arg}");
        assert!(!arg.contains("guestfwd"), "{arg}");
    }

    #[test]
    fn netdev_proxy_restricts_and_wires_the_guestfwd() {
        let arg = netdev_arg(VmEgress::Proxy, 40022, Some(41000));
        assert!(arg.contains("restrict=on"), "{arg}");
        assert!(
            arg.contains("guestfwd=tcp:10.0.2.100:3128-tcp:127.0.0.1:41000"), // privacy-check: ok — QEMU slirp, not a real host
            "{arg}"
        );
    }

    #[test]
    fn qemu_args_shape() {
        let args = qemu_args(
            4096,
            2,
            Path::new("/state/vm/p1/disk.qcow2"),
            Path::new("/state/vm/p1/seed.iso"),
            "user,id=net0",
            Path::new("/state/vm/p1/qemu.pid"),
            Path::new("/state/vm/p1/qmp.sock"),
            Path::new("/state/vm/p1/serial.log"),
        );
        let joined = args.join(" ");
        assert!(joined.contains("-enable-kvm"));
        assert!(joined.contains("-m 4096"));
        assert!(joined.contains("-smp 2"));
        assert!(joined.contains("file=/state/vm/p1/disk.qcow2,if=virtio,format=qcow2"));
        assert!(joined.contains("-daemonize"));
        assert!(joined.contains("unix:/state/vm/p1/qmp.sock,server=on,wait=off"));
        // The seed must be attached read-only — it's consumed, never written.
        assert!(joined.contains("media=cdrom,format=raw,readonly=on"));
    }

    // ── cloud-init ─────────────────────────────────────────────────────────

    #[test]
    fn user_data_carries_user_key_and_project_dir() {
        let doc = cloud_init_user_data("vm-proj", "ssh-ed25519 AAAA test", false);
        assert!(doc.starts_with("#cloud-config\n"));
        assert!(doc.contains("name: eldrun"));
        assert!(doc.contains("ssh-ed25519 AAAA test"));
        assert!(doc.contains("mkdir -p /home/eldrun/project"));
        assert!(doc.contains("ssh_pwauth: false"));
        assert!(!doc.contains("http_proxy"));
    }

    #[test]
    fn user_data_proxy_mode_sets_the_guest_proxy_env() {
        let doc = cloud_init_user_data("vm-proj", "ssh-ed25519 AAAA test", true);
        assert!(doc.contains("export https_proxy=http://10.0.2.100:3128")); // privacy-check: ok — QEMU slirp, not a real host
        assert!(doc.contains("/etc/apt/apt.conf.d/95eldrun-proxy"));
        assert!(doc.contains("/etc/environment"));
    }

    #[test]
    fn seed_instance_id_moves_with_the_config() {
        let a = seed_instance_id("project-1234", "#cloud-config\na");
        let b = seed_instance_id("project-1234", "#cloud-config\nb");
        assert_ne!(a, b);
        assert!(a.starts_with("eldrun-project-"));
        // …and is stable for a stable config:
        assert_eq!(a, seed_instance_id("project-1234", "#cloud-config\na"));
    }

    #[test]
    fn hostname_is_guest_safe() {
        assert_eq!(vm_hostname("My Project!"), "vm-my-project");
        assert_eq!(vm_hostname("---"), "eldrun-vm");
        assert!(vm_hostname(&"x".repeat(100)).len() <= 27);
    }

    // ── seed iso argv ──────────────────────────────────────────────────────

    #[test]
    fn seed_iso_args_per_tool() {
        assert_eq!(seed_iso_args("genisoimage")[0], "-output");
        assert_eq!(seed_iso_args("xorriso")[..2], ["-as", "mkisofs"]);
        assert_eq!(
            seed_iso_args("cloud-localds"),
            ["seed.iso", "user-data", "meta-data"]
        );
    }

    // ── vm_ssh_opts ────────────────────────────────────────────────────────

    #[test]
    fn ssh_opts_only_for_registered_loopback_ports() {
        // Nothing registered → no opts, whoever asks.
        assert!(vm_ssh_opts("127.0.0.1", Some(45999)).is_empty());
        registry().lock().unwrap().insert(
            "test-ssh-opts".to_string(),
            RunningVm {
                dir: PathBuf::from("/state/vm/test-ssh-opts"),
                runtime: VmRuntime {
                    pid: u32::MAX, // never alive, but opts don't require liveness
                    ssh_port: 45998,
                    proxy_port: None,
                    egress: VmEgress::Proxy,
                    base_image: String::new(),
                },
            },
        );
        let opts = vm_ssh_opts("127.0.0.1", Some(45998));
        assert!(opts
            .iter()
            .any(|o| o == "/state/vm/test-ssh-opts/known_hosts" || o.ends_with("known_hosts")));
        assert!(opts.iter().any(|o| o == "IdentitiesOnly=yes"));
        // A real (non-loopback) host on the same port must never match.
        assert!(vm_ssh_opts("build.example.com", Some(45998)).is_empty());
        registry().lock().unwrap().remove("test-ssh-opts");
    }
}
