# VM projects — why the third tier works the way it does

The design plan (goal, phases, alternatives) is `docs/vm_projects_plan.md`;
the item ledger is `todo/group-g-remote.md` G.26. This doc keeps only the
rationale that isn't discoverable from the code.

## A VM project IS a remote project

The one architectural decision everything follows from: the VM boots, exposes
SSH on a forwarded loopback port, and from that moment Eldrun sees an ordinary
`RemoteSpec { host: "127.0.0.1", port, key_auth: true, vm: true }`. The pooled
ControlMaster/SFTP session, `ssh -tt` tabs, tmux survival, agent resume, the
lamps and dialogs — all apply verbatim, already tested. `services::vm` owns
only what a real remote host doesn't have: boot, readiness, shutdown, the
per-VM SSH identity, and the orphan sweep. No consumer of `remote_target_for`
knows about VMs; the `vm: true` marker exists for the *few* places that must
dispatch on the tier (the spawn guard, the ssh-option injection, the pill).

## The boundary is the absence of a shared filesystem

The container tier's bind-mount is what makes it a cheap toggle; its absence
is what makes the VM a boundary. No virtiofs/9p/sshfs, ever — the only
channels in or out are the SSH session and explicit, user-clicked transfers.
Consequently the tier is chosen **at creation** (converting is a data move,
not a bit-flip), and the sandbox↔VM exclusion is enforced in both directions
(`set_project_sandbox` and `vm_set_spec` each refuse the other's project).
The container's `~/.claude/projects` transcript mount is also deliberately
absent: transcripts of *other* projects inside the boundary would be an
exfiltration channel; the in-VM agent has its own home, auth, history.

## The inverse sync posture

A network remote ships with a mirror, lockstep armed, agents defaulting
local — right for WAN latency, offline work, login nodes. A VM project flips
all three because each rationale inverts: latency is nil, the VM is reachable
whenever booted, and an agent "running local" is precisely the escape the
tier forbids. So: **no mirror by default** (zero agent-written bytes on the
host; the overlay IS the working tree, and the delete/rebuild confirms say so
by name), lockstep not armed, and locality **pinned** to the VM — the silent
remote→local fallback that exists elsewhere in tab spawning is a hard refusal
here, enforced twice: `effectiveTabLocation`'s `vmProject` pin keeps the
frontend from building a local spawn (overriding even a stored
`location: "local"`, which lives in agent-writable layout state), and
`commands::terminal::vm_spawn_refusal` refuses at the backend against the
state-dir record an in-VM agent cannot write. A down VM refuses with the
`ELDRUN_VM_DOWN` sentinel rather than downgrading to a host shell.

## Egress is a knob because pretending otherwise is theater

A no-egress VM cannot run a cloud agent — the agent must reach its model API.
So the knob is explicit and three-valued (Off / Proxy / Open), and the Proxy
default's limit is stated in the UI rather than hidden: the agent can still
exfiltrate *to the allowed endpoints* (e.g. inside a model prompt). The proxy
narrows the channel; it cannot close it. What it buys: everything else is
blocked **and logged**, so an agent probing anywhere unexpected shows up as
blocked CONNECTs — a tripwire, not a wall. The proxy is CONNECT-only by
design (every allowlisted endpoint speaks TLS; plain-HTTP forwarding would
make it a general web proxy), and GitHub is a per-project opt-in, not a
default — the initial clone goes through a *temporary* allow instead of a
standing hole to a code-hosting site. `restrict=on` + `guestfwd` at a fixed
guest address (10.0.2.100:3128) <!-- privacy-check: ok — QEMU slirp, not a real host -->means the guest-side proxy env never changes
across boots even though the host-side port does.

## Per-VM SSH identity, and why host-key confirmation is bypassed

A recreated VM has a new host key; the user's real `~/.ssh/known_hosts` must
never collect or conflict on `[127.0.0.1]:<port>` entries (ports are per-boot
and recycled). Every ssh argv aimed at a live VM's forwarded port gets
`UserKnownHostsFile=<vm dir>/known_hosts` + `IdentityFile` +
`IdentitiesOnly`, injected at the `ssh_common` base-builder choke points via
an **in-memory registry keyed by (loopback host, port)** — only a VM booted
by this process can match, which is exactly the authorization the
host-key-confirmation bypass needs: we generated the key and booted the
machine ourselves. First-contact trust is by construction, not TOFU.

## Lifecycle mirrors the container's

Boot-on-connect lives inside `remote_connect` (one funnel — activation
auto-connect, the lamp click, and a tab's silent reconnect all pass through
it), not in each caller. Shutdown on deactivate unless tabs are live (the
container rule verbatim, same code path in `project_runtime::switch`); down
on app exit; a startup sweep reaps orphaned QEMUs by pidfile, killing only
pids whose `/proc/<pid>/comm` is actually qemu (a recycled pid must never
kill an innocent process). Archive moves the VM state dir (overlay included —
it's the working tree) into the archive; restore moves it back; deleting the
archive deletes the overlay.

## Base image: fetch and bake are build tabs

Both are one-click shell scripts run in a visible tab (house convention),
not hidden backend downloads: the fetch is checksum-verified against the
release's own SHA256SUMS, and the bake boots the stock image once with
`-serial stdio` so cloud-init's own console output *is* the build progress,
powers off via `power_state`, and converts the overlay into
`eldrun-base-<ver>.qcow2`. A VM boots from the stock image when no baked one
exists — the bake only adds the agent toolchain.
