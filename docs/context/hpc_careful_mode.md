# Careful mode on remote hosts

Why Eldrun collects *less* from a machine it merely has an account on than from
the machine it runs on, and what "less" is exactly.

**Careful is the default for every remote machine.** It is not a cluster mode
that has to be detected — Eldrun cannot tell whose machine a host is, and the two
wrong guesses do not cost the same: a wrong careful costs a thinner monitor pane
and a skipped host census, a wrong full reading costs a usage-policy violation on
somebody else's cluster. So the question is never asked of the host, only of the
user, and only when they care to answer: the system monitor's per-machine
**Light / Detailed** switch, stored per SSH target in `settings.careful_hosts`
(`src/lib/carefulHost.ts`), which is what "this machine is mine" is written down
as. The rest of this document is what the reduced reading actually is, and the
rules that shaped it.

## The rules this exists for

A university cluster is not a dev box someone lent you; it runs under usage
regulations the account holder has agreed to. The ones Eldrun's host probes can
walk into (wording from the Bonn regulations, but every German site's are close
to identical, and the reasoning is not site-specific):

- **Other people's account names are not yours to enumerate.** *"fremde Uni-IDs
  und Passwörter weder zu ermitteln noch zu nutzen"* — a plain `getent passwd`
  on a directory-backed cluster dumps the entire user base. The bulk dump was
  purely a uid → display-name convenience for the monitor pane's process table.
- **Information about other users that happens to be readable is not yours to
  use.** *"keinen unberechtigten Zugriff auf Informationen anderer Nutzer nehmen
  und bekannt gewordene Informationen anderer Nutzer nicht ohne Genehmigung
  weiterzugeben, selbst zu nutzen oder zu verändern"* — `/proc/<pid>/cmdline` is
  world-readable, so reading it is not an intrusion; shipping every user's argv
  off the cluster and rendering a named per-person breakdown of it is squarely
  the "selbst zu nutzen" half. Command lines on a cluster carry dataset paths,
  job parameters, and occasionally something that should never have been on a
  command line at all.
- **Personal data is not to be processed on the machine.** *"Die Speicherung und
  Verarbeitung von personenbezogenen Daten auf der Infrastruktur von
  Hochleistungsrechnern ist ausdrücklich untersagt"*, and separately, any such
  processing must be *"mit dem HRZ abzustimmen"*. Account names and per-person
  command lines are personal data; the `awk`/`getent` pass that assembled them
  ran on the cluster.
- **A login node is not to carry sustained load.** The site docs put it plainly:
  don't run CPU-intensive work on a login node over longer periods, and
  processes that do may be killed. A monitor pane left open all afternoon at a
  3-second cadence — each poll a directory query, two file opens per process
  across a few thousand processes, a `grep` over every `cmdline`, two
  `nvidia-smi` spawns — is exactly the shape that rule targets.

None of this is criminal-code territory: nothing here defeats an access control
(§202a StGB is not in play). It is the usage agreement, and the sanction for
breaking it is the account.

## What careful mode changes

Both host probes have a careful variant. The **monitor snapshot**
(`sysstat::REMOTE_SNAPSHOT_SCRIPT`):

| Section | Detailed reading | Light (careful) reading |
|---|---|---|
| `@PASSWD@` | full `getent passwd` dump | the sampling account's own entry only |
| `@PASSWD2@` | targeted per-uid lookups for every uid seen | not run |
| `@CMDLINE@` | `grep` over every `/proc/*/cmdline` | the sampling account's own pids only |
| `@PROCS@` | `comm` verbatim for every process | foreign `comm` redacted to `(other)`; no `U` (uid) line for a foreign process |
| `@WHO@` | every login session | the sampling account's own sessions |
| `@GPU@` | device stats + `--query-compute-apps` | device stats only |

The **connect-time usage probe** (`services::remote_usage`) likewise reports
only the account's own `who` sessions and its own `ps` rows; the aggregate
CPU / memory / GPU figures — the whole basis of the `busy` verdict — are
unchanged, because none of them is about a person.

The load half:

- foreign processes still ship, so the pane can still answer *how loaded is this
  machine* — they arrive bucketed under one `other users` label
  (`sysstat::OTHER_USERS`) rather than one row per uid, which would be a
  per-person breakdown by another name;
- the pane polls a careful host every **12 s** instead of 3 s, and **not at all**
  while Eldrun is in the background (`SystemMonitorPane`'s `CAREFUL_POLL_MS`);
- the connect-time usage probe stops firing automatically at a host once it is
  known careful (`services::hpc_mode`); the report stays available on demand from
  the Machines menu.

Both surfaces *say* they are doing this. A silently thinner reading is worse than
none: a login node full of unnamed rows would otherwise read as a bug.

## Who decides

**The user, per machine.** Every remote host reads careful until an explicit
answer says otherwise. The answer is keyed by SSH target (`user@host:port`), not
by host id, because one physical login node is simultaneously a project's primary
`remote`, another project's `compute_hosts` worker and a project-free global
machine — three records, one machine, and a per-record flag would be three values
free to disagree. The switch renders in three places off one component/flag: the
system monitor's machine row (tab **and** the Machines-menu dialog), and the
per-host connect dialog's "Go easy on this machine".

The monitor passes that answer on every poll, and it is authoritative in **both**
directions (`ELDRUN_CAREFUL=1`/`0` via `sysstat::remote_snapshot_script`) — the
only way a machine the user owns gets a full reading is for their answer to
outrank anything the host says about itself.

**The host, only when nobody has said anything.** The probe scripts still ask
whether SLURM is on `PATH` (`sbatch`/`sinfo`/`squeue`) and report the answer on
their own first line, so the flag rides in the payload (`SystemSnapshot.careful`,
`RemoteUsageReport.careful`). That still matters for a caller with no stored
answer to pass — nothing in Eldrun hardcodes an institution's hostnames to guess
with, so asking the host is the only signal left. `services::hpc_mode` remembers a
positive verdict per SSH target for the process lifetime, for the caller holding
no probe result at all (the connect path, deciding whether to fire the usage
check). That memory only ever *raises* carefulness, and it does not override an
explicit answer: it exists to stop a flaky probe from talking a cluster down, not
to overrule a person saying whose machine it is.

## What careful mode does not touch — and the tag that does

Careful mode is about *reading*. It says nothing about how work runs: shells,
agents, SLURM submission, byte-sync and git lockstep are the same on a careful
host as on any other. Those are the second half of the problem, and they need a
different instrument, because they cannot be defaulted safely (switching sync off
for every remote project would break the feature) and cannot be inferred from the
host (`sbatch` on `PATH` says a machine *has* a scheduler — a compute node held
through `srun` has one too, and there you own the machine outright).

So they hang off an explicit per-machine **HPC tag**, ticked wherever a host is
logged in to — the Machines menu's add-a-machine form, the per-host connect
dialog (`HpcHostToggle`, beside "Go easy on this machine"), and the new/extend
project flow — and shown afterwards as an `HPC` badge on that machine's row, with
a toggle in its expanded detail. Stored per SSH target in `settings.hpc_hosts`
(`src/lib/hpcHost.ts`, `schema::settings`): the same key as `careful_hosts`, so
tagging a login node once covers it as a project primary, as another project's
worker, and as a global machine.

Tagged, a machine gets:

| Behaviour | Untagged | Tagged |
|---|---|---|
| monitor reading | careful by default, user may switch to Detailed | careful, **and the Detailed switch is disabled** |
| connect-time usage probe | fires on every connect | not fired automatically (`commands::remote`) |
| giant-folder census (`du -ak`) | runs on connect | never runs against the host (`commands::sync`) |
| disk-usage scan | runs | **refused until confirmed for that scan** (`commands::disk_usage` → `HPC_GUARD` → `lib/hpcGuard.ts`) |
| auto byte-sync loop (25 s) | starts on connect | never starts (`services::sync_auto`) — manual push/pull still works |
| git lockstep poll (12 s) | starts when lockstep is on | never starts (`services::git_peer`) — manual reconcile still works |
| auto-connect at launch/VPN-up | as armed | never, project or global machine (`stores/projects`, `stores/globalMachines`) |
| Python run / debug, script run | runs | **asks first** when it would land on the tagged host |

Two design notes worth keeping:

- **Refuse-and-confirm, not refuse.** A scan of the cluster tree and a run on the
  login node are things people legitimately want; what the tag buys is that
  neither happens *by accident*. The backend refuses with a sentinel naming what
  was refused and which machine (`services::hpc_mode::guard_error`), the frontend
  wraps the call in `withHpcConfirm`, and confirmation is per act, never
  remembered — a gate that can be worn down by one click is not a gate.
- **Opening a plain shell is deliberately not gated.** On a cluster you open
  shells constantly, to submit and to look around; a prompt on each is the
  warning everyone learns to click through. The gate sits on the two actions that
  actually compute.
