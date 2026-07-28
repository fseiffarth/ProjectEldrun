import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Toggle } from "../common/Toggle";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { useTabsStore } from "../../stores/tabs";
import { useT, type TranslationKey } from "../../lib/i18n";

interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
  refs: string;
  is_head: boolean;
  parents: string[];
}

interface GitBranch {
  name: string;
  is_current: boolean;
  is_remote: boolean;
}

interface Worktree {
  path: string;
  branch: string;
  head: string;
  is_main: boolean;
  is_locked: boolean;
  /** git's own words for why — the whole content of a lock. */
  lock_reason: string;
  /** The admin entry survives but the checkout is gone; only `prune` clears it. */
  is_prunable: boolean;
  prunable_reason: string;
  is_bare: boolean;
  /** This worktree is the one Eldrun is working in — never removable (#23 D4). */
  is_current: boolean;
}

/** The create form's fields. `branch` means different things per mode: an existing
 *  branch to check out, or the NEW branch's name — which is why the control has to
 *  swap between a dropdown and a text input (#23 B1). */
interface WorktreeForm {
  name: string;
  branch: string;
  newBranch: boolean;
  /** Only meaningful when `newBranch`: where the new branch starts. */
  startPoint: string;
}

/** A peer's HEAD as reported by the git-lockstep backend (#28n). */
type HeadRef =
  | { kind: "branch"; name: string; sha: string }
  | { kind: "detached"; sha: string }
  | { kind: "unborn" };

type LockstepStatus =
  | "synchronized"
  | "syncing"
  | "desynchronized"
  /** #28p D4: the SSH pool is cold, so nothing is known about the host — and, crucially,
   *  nothing is claimed. This used to render as a green "synchronized". */
  | "disconnected";

/** The files an initial pairing refused to overwrite (#28p D3). */
interface PairingConflict {
  /** True when the repo side is the local mirror, i.e. the files at risk are the host's. */
  sourceIsLocal: boolean;
  paths: string[];
}

/** One `refs/eldrun/backup/*` safety ref (#28p D6). */
interface BackupRef {
  peer: "local" | "remote";
  refname: string;
  ts: number;
  branch: string;
  sha: string;
  subject: string;
}

/** Mirrors `services::git_peer::GitPeerState` (camelCase). */
interface GitPeerState {
  enabled: boolean;
  status: LockstepStatus;
  detail: string | null;
  localHead: HeadRef | null;
  remoteHead: HeadRef | null;
  lastSyncTs: number | null;
  localSubject: string | null;
  remoteSubject: string | null;
  pairingConflict: PairingConflict | null;
}

/** `<short sha> subject` for a peer's HEAD — shown so a Use-local/Use-remote choice is
 *  informed rather than blind (#28p D8). */
function headLabel(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  head: HeadRef | null,
  subject: string | null,
): string {
  if (!head || head.kind === "unborn") return "—";
  const sha = head.sha.slice(0, 7);
  const name = head.kind === "branch" ? head.name : t("gitHistory.detached");
  return subject ? `${name} ${sha} · ${subject}` : `${name} ${sha}`;
}

interface Props {
  projectDir: string;
  /** Project id — only supplied for SSH remote projects, enabling git lockstep (#28n). */
  projectId?: string;
  /** True for SSH remote projects (gates the lockstep UI). */
  remote?: boolean;
  /** Called after a checkout/reword so the parent can refresh git status. */
  onChanged?: () => void;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * The one place a worktree may live for this project, derived from the **main
 * worktree's own path** in the listing rather than from `projectDir` — for a
 * remote project those are two different machines' paths, and the listing is
 * always the side the command actually ran on (#23 I2/I3).
 *
 * Mirrors `commands::git::WorktreeCtx::worktrees_root`; the backend re-derives
 * and enforces it, so this is a preview, never the gate.
 */
function worktreesRoot(worktrees: Worktree[]): string {
  const main = worktrees.find((w) => w.is_main);
  if (!main) return "";
  const root = main.path.replace(/[/\\]+$/, "");
  const sep = /^[a-zA-Z]:[\\/]/.test(root) || root.includes("\\") ? "\\" : "/";
  return `${root}${sep}.eldrun${sep}worktrees`;
}

function parseRefs(refs: string): string[] {
  return refs
    .split(",")
    .map((r) => r.trim().replace(/^HEAD -> /, ""))
    .filter((r) => r && r !== "HEAD");
}

// ── Commit graph layout ─────────────────────────────────────────────────────

const LANE_PALETTE = [
  "#58a6ff", "#3fb950", "#e3b341", "#bc8cff",
  "#39c5cf", "#f0883e", "#db61a2", "#f85149",
];
const laneColor = (i: number) => LANE_PALETTE[((i % LANE_PALETTE.length) + LANE_PALETTE.length) % LANE_PALETTE.length];

interface RowLayout {
  col: number;          // column of this commit's dot
  laneCount: number;    // lanes occupied at this row (for width)
  verticals: number[];  // lane indices passing straight through this row
  merges: number[];     // child lane indices (≠ col) merging into the dot from above
  topToDot: boolean;    // a lane arrives from above directly into the dot
  trunk: boolean;       // first parent continues straight down from the dot
  branches: number[];   // parent lane indices (≠ col) leaving the dot downward
}

/**
 * Assigns each commit a column and records the edges entering/leaving its row,
 * mirroring how `git log --graph` threads branches. Commits must be in the
 * newest-first order returned by git log. Lanes are kept positionally stable
 * (freed slots are reused, never compacted) so a branch keeps one column —
 * and therefore one colour — until it merges.
 */
function computeGraph(commits: GitCommit[]): RowLayout[] {
  const lanes: (string | null)[] = []; // hash each column is currently waiting for
  const indexOf = (h: string) => lanes.findIndex((l) => l === h);
  const alloc = (h: string) => {
    const empty = lanes.findIndex((l) => l === null);
    if (empty === -1) {
      lanes.push(h);
      return lanes.length - 1;
    }
    lanes[empty] = h;
    return empty;
  };

  const rows: RowLayout[] = [];
  for (const commit of commits) {
    let col = indexOf(commit.hash);
    const topToDot = col !== -1;
    if (col === -1) col = alloc(commit.hash);

    const merges: number[] = [];
    const verticals: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) {
        if (i !== col) merges.push(i);
      } else if (lanes[i] !== null) {
        verticals.push(i);
      }
    }

    const beforeLen = lanes.length;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) lanes[i] = null;
    }

    let trunk = false;
    const branches: number[] = [];
    commit.parents.forEach((parent, idx) => {
      const existing = indexOf(parent);
      if (idx === 0 && existing === -1) {
        lanes[col] = parent; // first parent continues this commit's column
        trunk = true;
      } else if (existing !== -1) {
        branches.push(existing); // parent already tracked → connect to its lane
      } else {
        branches.push(alloc(parent));
      }
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    rows.push({
      col,
      laneCount: Math.max(beforeLen, lanes.length, col + 1),
      verticals,
      merges,
      topToDot,
      trunk,
      branches,
    });
  }
  return rows;
}

const LANE_W = 14;
const GRAPH_ROW_H = 22;
const cx = (col: number) => col * LANE_W + LANE_W / 2;

function CommitGraphCell({
  row,
  height,
  lanes,
  head,
  tip,
}: {
  row: RowLayout;
  height: number;
  lanes: number;
  head: boolean;
  tip: boolean;
}) {
  const mid = height / 2;
  const width = lanes * LANE_W;
  const x = (c: number) => cx(c);
  const dotX = x(row.col);

  return (
    <svg className="git-graph-cell" width={width} height={height} style={{ flexShrink: 0 }} aria-hidden>
      {row.verticals.map((i) => (
        <line key={`v${i}`} x1={x(i)} y1={0} x2={x(i)} y2={height} stroke={laneColor(i)} strokeWidth={1.5} />
      ))}
      {row.topToDot && (
        <line x1={dotX} y1={0} x2={dotX} y2={mid} stroke={laneColor(row.col)} strokeWidth={1.5} />
      )}
      {row.merges.map((i) => (
        <path
          key={`m${i}`}
          d={`M ${x(i)} 0 C ${x(i)} ${mid} ${dotX} 0 ${dotX} ${mid}`}
          fill="none"
          stroke={laneColor(i)}
          strokeWidth={1.5}
        />
      ))}
      {row.trunk && (
        <line x1={dotX} y1={mid} x2={dotX} y2={height} stroke={laneColor(row.col)} strokeWidth={1.5} />
      )}
      {row.branches.map((j) => (
        <path
          key={`b${j}`}
          d={`M ${dotX} ${mid} C ${dotX} ${height} ${x(j)} ${mid} ${x(j)} ${height}`}
          fill="none"
          stroke={laneColor(j)}
          strokeWidth={1.5}
        />
      ))}
      {/* Branch tips get a hollow ring in their lane color so the heads stand
          out from ordinary commits along the same lane. */}
      {tip && (
        <circle cx={dotX} cy={mid} r={head ? 7 : 6} fill="none" stroke={laneColor(row.col)} strokeWidth={1.5} />
      )}
      <circle cx={dotX} cy={mid} r={head ? 4.5 : 3.5} fill={laneColor(row.col)} stroke="var(--bg-panel)" strokeWidth={head ? 1.5 : 1} />
    </svg>
  );
}

const GRAPH_MODE_KEY = "eldrun.gitHistoryGraph";

const LOCKSTEP_STATUS_KEY: Record<LockstepStatus, TranslationKey> = {
  synchronized: "gitHistory.statusSynchronized",
  syncing: "gitHistory.statusSyncing",
  desynchronized: "gitHistory.statusDesynchronized",
  disconnected: "gitHistory.statusDisconnected",
};

export function GitHistory({ projectDir, projectId, remote, onChanged }: Props) {
  const t = useT();
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  // Git lockstep (#28n): only meaningful for SSH remote projects.
  const lockstepEligible = !!(remote && projectId);
  const [lockstep, setLockstep] = useState<GitPeerState | null>(null);
  const [lockstepBusy, setLockstepBusy] = useState(false);
  // #28p D6: null = the Backups list is closed.
  const [backups, setBackups] = useState<BackupRef[] | null>(null);
  const [wtForm, setWtForm] = useState<WorktreeForm | null>(null);
  /**
   * Which side's worktrees these are (#23 I2). For a remote project `projectDir`
   * is the **local mirror** while the repo of record is on the host, so resolving
   * this from the directory alone created host worktrees at mirror-shaped paths
   * and left the mirror's own repo unmanageable. Defaults to the host, which is
   * what the rest of this panel reflects. Meaningless (and hidden) for a local
   * project, where there is only one side.
   */
  const [wtSite, setWtSite] = useState<"host" | "mirror">("host");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GitCommit | null>(null);
  const [graphMode, setGraphMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(GRAPH_MODE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const toggleGraphMode = useCallback(() => {
    setGraphMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(GRAPH_MODE_KEY, next ? "1" : "0");
      } catch {
        /* ignore storage failures */
      }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    if (!projectDir) return;
    setLoading(true);
    setError(null);
    // `allSettled`, not `all`: these are three independent reads, and one of them
    // rejecting used to reject the whole batch — so a git build that does not know
    // `git_worktree_list`, or a worktree probe that failed on its own, blanked the
    // commit list and the branch pills too. Each result now stands or falls alone
    // and only the failures are reported.
    const [log, br, wt] = await Promise.allSettled([
      invoke<GitCommit[]>("git_log", { projectDir, limit: 100 }),
      invoke<GitBranch[]>("git_branches", { projectDir }),
      invoke<Worktree[]>("git_worktree_list", { projectDir, site: wtSite }),
    ]);
    if (log.status === "fulfilled") setCommits(log.value ?? []);
    if (br.status === "fulfilled") setBranches(br.value ?? []);
    if (wt.status === "fulfilled") setWorktrees(wt.value ?? []);
    const failed = [log, br, wt].filter((r) => r.status === "rejected");
    setError(failed.length ? String((failed[0] as PromiseRejectedResult).reason) : null);
    setLoading(false);
  }, [projectDir, wtSite]);

  useEffect(() => {
    load();
  }, [load]);

  // Load git-lockstep status + subscribe to backend status pushes (#28n).
  useEffect(() => {
    if (!lockstepEligible || !projectId) {
      setLockstep(null);
      return;
    }
    let alive = true;
    invoke<GitPeerState>("git_peer_status", { projectId })
      .then((s) => alive && setLockstep(s))
      .catch(() => {});
    const un = listen<{ projectId: string; state: GitPeerState }>("git-peer-status", (e) => {
      if (alive && e.payload.projectId === projectId) setLockstep(e.payload.state);
    });
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, [lockstepEligible, projectId]);

  const toggleLockstep = useCallback(async () => {
    if (!projectId) return;
    setLockstepBusy(true);
    setError(null);
    try {
      const s = await invoke<GitPeerState>("git_peer_set_enabled", {
        projectId,
        enabled: !(lockstep?.enabled ?? false),
      });
      setLockstep(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setLockstepBusy(false);
    }
  }, [projectId, lockstep?.enabled]);

  const lockstepSyncNow = useCallback(async () => {
    if (!projectId) return;
    setLockstepBusy(true);
    setError(null);
    try {
      const s = await invoke<GitPeerState>("git_peer_sync_now", { projectId });
      setLockstep(s);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setLockstepBusy(false);
    }
  }, [projectId, load]);

  // Use-local / Use-remote divergence resolution (#28n Phase 2): the chosen side
  // becomes authoritative and the loser's overwritten tips are backed up to
  // refs/eldrun/backup/* before it is reset. Confirm first — it discards commits
  // on the losing side (recoverable only via those backup refs).
  const lockstepResolve = useCallback(
    async (authority: "local" | "remote") => {
      if (!projectId) return;
      const authorityLabel = t(
        authority === "local" ? "gitHistory.authorityLocal" : "gitHistory.authorityRemoteHost",
      );
      const other = t(
        authority === "local" ? "gitHistory.authorityRemoteHost" : "gitHistory.authorityLocalMirror",
      );
      if (
        !window.confirm(
          t("gitHistory.confirmResolve", { authority: authorityLabel, other }),
        )
      )
        return;
      setLockstepBusy(true);
      setError(null);
      try {
        const s = await invoke<GitPeerState>("git_peer_resolve", {
          projectId,
          authority,
        });
        setLockstep(s);
        await load();
        onChanged?.();
      } catch (e) {
        setError(String(e));
      } finally {
        setLockstepBusy(false);
      }
    },
    [projectId, load, onChanged, t],
  );

  // #28p D3: pairing refused because the empty side holds files that differ from what
  // it would be reset to. `reset --hard` destroys those silently, so the overwrite only
  // happens on an explicit confirmation that has *named* them.
  const lockstepPairConfirm = useCallback(async () => {
    const conflict = lockstep?.pairingConflict;
    if (!projectId || !conflict) return;
    const side = t(
      conflict.sourceIsLocal ? "gitHistory.authorityRemoteHost" : "gitHistory.authorityLocalMirror",
    );
    const list = conflict.paths.slice(0, 10).join("\n  ");
    const more =
      conflict.paths.length > 10
        ? t("gitHistory.andMore", { count: conflict.paths.length - 10 })
        : "";
    if (
      !window.confirm(
        t("gitHistory.confirmOverwritePair", {
          count: conflict.paths.length,
          side,
          list,
          more,
        }),
      )
    )
      return;
    setLockstepBusy(true);
    setError(null);
    try {
      const s = await invoke<GitPeerState>("git_peer_pair_confirm", { projectId });
      setLockstep(s);
      await load();
      onChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setLockstepBusy(false);
    }
  }, [projectId, lockstep?.pairingConflict, load, onChanged, t]);

  // #28p D6: the backup refs every resolve/restore creates were write-only — they
  // pinned objects forever and nothing could list or restore them, which also hollowed
  // out the "it's recoverable" promise of Use-local/Use-remote.
  const loadBackups = useCallback(async () => {
    if (!projectId) return;
    setLockstepBusy(true);
    setError(null);
    try {
      const list = await invoke<BackupRef[]>("git_peer_backups", { projectId });
      setBackups(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLockstepBusy(false);
    }
  }, [projectId]);

  const restoreBackup = useCallback(
    async (b: BackupRef) => {
      if (!projectId) return;
      if (
        !window.confirm(
          t("gitHistory.confirmRestore", {
            peer: b.peer,
            branch: b.branch,
            sha: b.sha.slice(0, 7),
            subject: b.subject || t("gitHistory.noSubject"),
          }),
        )
      )
        return;
      setLockstepBusy(true);
      setError(null);
      try {
        const s = await invoke<GitPeerState>("git_peer_restore_backup", {
          projectId,
          peer: b.peer,
          refname: b.refname,
        });
        setLockstep(s);
        await loadBackups();
        await load();
        onChanged?.();
      } catch (e) {
        setError(String(e));
      } finally {
        setLockstepBusy(false);
      }
    },
    [projectId, load, loadBackups, onChanged, t],
  );

  // #28p D8: a genuine two-sided divergence used to offer only "pick a winner". Open a
  // local shell in the mirror instead — the peer's tip is already parked at
  // refs/eldrun/peer/<branch> by the reconcile that detected the divergence, so the user
  // can merge or rebase with plain git and the next pass fast-forwards the host normally.
  const resolveInTerminal = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const mirror = await invoke<string>("git_peer_mirror_dir", { projectId });
      const branch =
        lockstep?.localHead?.kind === "branch" ? lockstep.localHead.name : undefined;
      useTabsStore.getState().addTab({
        label: "resolve",
        cmd: "",
        cwd: mirror,
        kind: "shell",
        // The mirror is a LOCAL working copy; a remote-located shell would cd into the
        // host tree, where the peer ref isn't.
        location: "local",
        initialInput: branch
          ? `git log --oneline --graph HEAD refs/eldrun/peer/${branch}`
          : undefined,
      });
    } catch (e) {
      setError(String(e));
    }
  }, [projectId, lockstep?.localHead]);

  async function checkout(target: string) {
    setLoading(true);
    setError(null);
    try {
      // With git lockstep enabled, route through the coordinator so the paired
      // local mirror + remote host tree switch together (#28n). The Git UI here
      // reflects the host tree, so the host initiates.
      if (lockstepEligible && projectId && lockstep?.enabled) {
        const s = await invoke<GitPeerState>("git_peer_checkout", {
          projectId,
          target,
          initiatingSide: "remote",
        });
        setLockstep(s);
      } else {
        await invoke("git_checkout", { projectDir, target });
      }
      setSelected(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }

  async function createWorktree() {
    if (!wtForm) return;
    setLoading(true);
    setError(null);
    try {
      await invoke("git_worktree_add", {
        projectDir,
        site: wtSite,
        // A NAME, not a path: the backend owns where a worktree lives (#23 I3).
        path: wtForm.name.trim() || wtForm.branch.trim(),
        branch: wtForm.branch.trim(),
        newBranch: wtForm.newBranch,
        startPoint: wtForm.newBranch ? wtForm.startPoint || null : null,
      });
      setWtForm(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }

  /**
   * Remove a worktree, asking first and naming what goes (#23 B2/B3).
   *
   * `git worktree remove` refuses a *dirty* tree but does **not** refuse on
   * **ignored** files — it deletes the tree wholesale, so a `node_modules`, a
   * `.venv` and a `.env` full of keys all go with it. There is no undo and no
   * trash, which is exactly why the sibling destructive actions in this file
   * (lockstep resolve, pairing overwrite, backup restore) all confirm first.
   *
   * `force` is a **count**: git answers a locked worktree with "use 'remove -f -f'
   * to override or unlock first" and exits 128 for a single `--force`. So a
   * refusal is re-offered at the next level rather than dead-ending — the state
   * that used to be escapable only from a terminal.
   */
  async function removeWorktree(wt: Worktree, force = 0) {
    if (force === 0) {
      if (!window.confirm(t("gitHistory.confirmRemoveWorktree", { path: wt.path }))) return;
    }
    setLoading(true);
    setError(null);
    try {
      await invoke("git_worktree_remove", { projectDir, path: wt.path, force, site: wtSite });
      await load();
      onChanged?.();
    } catch (e) {
      const msg = String(e);
      setLoading(false);
      // git names its own escape in the failure. Offer exactly that one, once.
      const next = /use\s+'?remove\s+-f\s+-f|locked working tree/i.test(msg)
        ? 2
        : /use --force|use `--force`/i.test(msg)
          ? 1
          : 0;
      if (next > force) {
        const key =
          next === 2 ? "gitHistory.confirmForceRemoveLocked" : "gitHistory.confirmForceRemoveDirty";
        if (window.confirm(t(key, { path: wt.path }))) {
          await removeWorktree(wt, next);
          return;
        }
      }
      setError(msg);
    }
  }

  async function setWorktreeLock(wt: Worktree, lock: boolean) {
    setLoading(true);
    setError(null);
    try {
      if (lock) {
        const reason = window.prompt(t("gitHistory.lockReasonPrompt", { path: wt.path }), "");
        if (reason === null) {
          setLoading(false);
          return;
        }
        await invoke("git_worktree_lock", { projectDir, path: wt.path, reason, site: wtSite });
      } else {
        await invoke("git_worktree_unlock", { projectDir, path: wt.path, site: wtSite });
      }
      await load();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }

  /** Drop the administrative entries of worktrees whose checkout is gone. The
   *  command has existed since #23 landed and was never invoked from anywhere. */
  async function pruneWorktrees() {
    setLoading(true);
    setError(null);
    try {
      await invoke("git_worktree_prune", { projectDir, site: wtSite });
      await load();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }

  // The graph layout is computed regardless of view mode so the per-lane colors
  // can also tint the branch selector and the ref labels in list view; only the
  // SVG cell itself is gated on graphMode below.
  const graph = useMemo(() => computeGraph(commits), [commits]);
  const graphLanes = useMemo(
    () => graph.reduce((max, r) => Math.max(max, r.laneCount), 1),
    [graph],
  );

  // Map each ref (branch tip / remote / tag) to the color of the lane its commit
  // occupies in the graph, so a branch wears one consistent color everywhere it
  // appears: the selector pill, its ref label, and its lane in the graph. Tag
  // refs ("tag: …") are skipped — only branch heads get a color. First write wins
  // when several refs share a commit (they share the lane anyway).
  const branchColor = useMemo(() => {
    const m = new Map<string, string>();
    commits.forEach((c, i) => {
      const col = graph[i]?.col;
      if (col == null) return;
      for (const r of parseRefs(c.refs)) {
        if (r.startsWith("tag: ") || m.has(r)) continue;
        m.set(r, laneColor(col));
      }
    });
    return m;
  }, [commits, graph]);

  const current = branches.find((b) => b.is_current)?.name;
  const localBranches = branches.filter((b) => !b.is_remote);
  const remoteBranches = branches.filter((b) => b.is_remote);
  const currentBranch = current;

  // A branch already checked out anywhere — the main worktree included — cannot be
  // checked out again: git answers `'x' is already used by worktree at '…'`. Offering
  // it was a guaranteed failure one click away. `Worktree.branch` and `GitBranch.name`
  // are the same string space, so this is an exact match, not a heuristic.
  const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean));
  const addableBranches = localBranches.filter((b) => !checkedOut.has(b.name));
  const wtRoot = worktreesRoot(worktrees);

  if (!projectDir) {
    return <div className="file-tree-empty">{t("common.noProjectSelected")}</div>;
  }

  return (
    <div className="git-history">
      <div className="git-history-toolbar">
        <span className="git-history-branch" title={t("gitHistory.currentBranchTitle")}>
          ⎇ {current ?? t("gitHistory.detached")}
        </span>
        <button
          className={`tab-add-btn git-history-mode${graphMode ? " active" : ""}`}
          onClick={toggleGraphMode}
          aria-pressed={graphMode}
          title={t(graphMode ? "gitHistory.switchToListView" : "gitHistory.switchToGraphView")}
        >
          {t(graphMode ? "gitHistory.graphModeGraph" : "gitHistory.graphModeList")}
        </button>
        <button className="tab-add-btn git-history-refresh" onClick={load} title={t("common.refresh")} disabled={loading}>
          ⟳
        </button>
      </div>

      {lockstepEligible && (
        <div className="git-lockstep-bar" style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 6px", borderBottom: "1px solid var(--border-color)", fontSize: 10 }}>
          <button
            className={`tab-add-btn${lockstep?.enabled ? " active" : ""}`}
            onClick={toggleLockstep}
            disabled={lockstepBusy}
            aria-pressed={!!lockstep?.enabled}
            title={t(lockstep?.enabled ? "gitHistory.lockstepOnTitle" : "gitHistory.lockstepOffTitle")}
          >
            {t("gitHistory.lockstepLabel")} {t(lockstep?.enabled ? "gitHistory.on" : "gitHistory.off")}
          </button>
          {lockstep?.enabled && (
            <>
              <span
                title={lockstep.detail ?? undefined}
                style={{
                  padding: "1px 6px",
                  borderRadius: "var(--radius)",
                  color: "#fff",
                  background:
                    lockstep.status === "synchronized"
                      ? "var(--success, #3fb950)"
                      : lockstep.status === "syncing"
                        ? "var(--warning, #e3b341)"
                        : lockstep.status === "disconnected"
                          ? "var(--text-muted, #8b949e)"
                          : "var(--danger, #f85149)",
                }}
              >
                {t(LOCKSTEP_STATUS_KEY[lockstep.status])}
              </span>
              <button
                className="tab-add-btn"
                onClick={lockstepSyncNow}
                // Nothing to sync against without a connection — the button would only
                // produce another "disconnected" (#28p D4).
                disabled={lockstepBusy || lockstep.status === "disconnected"}
                title={t(
                  lockstep.status === "disconnected"
                    ? "gitHistory.syncDisabledTitle"
                    : "gitHistory.syncNowTitle",
                )}
              >
                {t(lockstep.status === "desynchronized" ? "gitHistory.retry" : "gitHistory.syncNow")}
              </button>
              {lockstep.status === "desynchronized" && lockstep.pairingConflict ? (
                // Pairing was refused: the ONLY action offered is the one that names what
                // it would destroy (#28p D3) — Use-local/Use-remote would be meaningless
                // here (there is nothing paired yet to pick a winner between).
                <button
                  className="tab-add-btn"
                  onClick={lockstepPairConfirm}
                  disabled={lockstepBusy}
                  title={t("gitHistory.overwritePairTitle", {
                    side: t(lockstep.pairingConflict.sourceIsLocal ? "gitHistory.host" : "gitHistory.mirror"),
                  })}
                >
                  {t("gitHistory.overwriteAndPair", { count: lockstep.pairingConflict.paths.length })}
                </button>
              ) : (
                lockstep.status === "desynchronized" && (
                  <>
                    <button
                      className="tab-add-btn"
                      onClick={() => lockstepResolve("local")}
                      disabled={lockstepBusy}
                      title={t("gitHistory.useLocalTitle")}
                    >
                      {t("gitHistory.useLocal")}
                    </button>
                    <button
                      className="tab-add-btn"
                      onClick={() => lockstepResolve("remote")}
                      disabled={lockstepBusy}
                      title={t("gitHistory.useRemoteTitle")}
                    >
                      {t("gitHistory.useRemote")}
                    </button>
                    <button
                      className="tab-add-btn"
                      onClick={resolveInTerminal}
                      disabled={lockstepBusy}
                      title={t("gitHistory.resolveInTerminalTitle")}
                    >
                      {t("gitHistory.resolveInTerminal")}
                    </button>
                  </>
                )
              )}
              <button
                className="tab-add-btn"
                onClick={() => (backups ? setBackups(null) : loadBackups())}
                disabled={lockstepBusy || lockstep.status === "disconnected"}
                aria-pressed={!!backups}
                title={t("gitHistory.backupsTitle")}
              >
                {t("gitHistory.backups")}
              </button>
              {lockstep.status === "desynchronized" && lockstep.detail && (
                <span style={{ color: "var(--danger, #f85149)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={lockstep.detail}>
                  {lockstep.detail}
                </span>
              )}
              {/* Both heads, so a Use-local/Use-remote choice is informed (#28p D8). */}
              {lockstep.status === "desynchronized" && !lockstep.pairingConflict && (
                <span style={{ marginLeft: "auto", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {t("gitHistory.localLabel")} {headLabel(t, lockstep.localHead, lockstep.localSubject)} ·{" "}
                  {t("gitHistory.remoteLabel")} {headLabel(t, lockstep.remoteHead, lockstep.remoteSubject)}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {lockstepEligible && backups && (
        <div className="git-lockstep-backups" style={{ borderBottom: "1px solid var(--border-color)", padding: "3px 6px", fontSize: 10, maxHeight: 140, overflowY: "auto" }}>
          {backups.length === 0 ? (
            <div style={{ color: "var(--text-muted)" }}>{t("gitHistory.noBackupRefs")}</div>
          ) : (
            backups.map((b) => (
              <div key={`${b.peer}:${b.refname}`} style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 0" }}>
                <span style={{ color: "var(--text-muted)" }}>{b.peer}</span>
                <span>{b.branch}</span>
                <span style={{ color: "var(--text-muted)" }}>{b.sha.slice(0, 7)}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={b.subject}>
                  {b.subject}
                </span>
                <span style={{ color: "var(--text-muted)" }}>
                  {new Date(b.ts * 1000).toLocaleString()}
                </span>
                <button
                  className="tab-add-btn"
                  onClick={() => restoreBackup(b)}
                  disabled={lockstepBusy}
                  title={t("gitHistory.restoreTitle", { peer: b.peer, branch: b.branch })}
                >
                  {t("gitHistory.restore")}
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {(localBranches.length > 0 || remoteBranches.length > 0) && (
        <div className="git-branch-list">
          {localBranches.map((b) => (
            <button
              key={b.name}
              className={`git-branch-pill${b.is_current ? " current" : ""}`}
              onClick={() => !b.is_current && checkout(b.name)}
              disabled={loading || b.is_current}
              title={t(b.is_current ? "gitHistory.onBranchTitle" : "gitHistory.checkoutBranchTitle", { name: b.name })}
            >
              {branchColor.has(b.name) && (
                <span className="git-branch-dot" style={{ background: branchColor.get(b.name) }} aria-hidden />
              )}
              {b.name}
            </button>
          ))}
          {remoteBranches.map((b) => (
            <button
              key={b.name}
              className="git-branch-pill remote"
              onClick={() => checkout(b.name)}
              disabled={loading}
              title={t("gitHistory.checkoutBranchTitle", { name: b.name })}
            >
              {branchColor.has(b.name) && (
                <span className="git-branch-dot" style={{ background: branchColor.get(b.name) }} aria-hidden />
              )}
              {b.name}
            </button>
          ))}
        </div>
      )}

      <div className="git-worktree-section">
        <div className="git-worktree-header">
          <span className="git-worktree-title">{t("gitHistory.worktrees")}</span>
          <UntestedTag />
          {remote && (
            // #23 I2: two repos, two answers. `git_publish`'s "Publish from"
            // selector is the precedent — where the bytes are is not where the
            // operation runs, and for a remote project `projectDir` is the mirror.
            <Dropdown
              className="git-worktree-site"
              value={wtSite}
              title={t("gitHistory.worktreeSiteLabel")}
              onChange={(v) => {
                setWtForm(null);
                setWtSite(v === "mirror" ? "mirror" : "host");
              }}
              options={[
                { value: "host", label: t("gitHistory.worktreeSiteHost") },
                { value: "mirror", label: t("gitHistory.worktreeSiteMirror") },
              ]}
            />
          )}
          <span className="git-worktree-spacer" />
          {worktrees.some((w) => w.is_prunable) && (
            <button
              className="tab-add-btn"
              onClick={pruneWorktrees}
              disabled={loading}
              title={t("gitHistory.pruneWorktreesTitle")}
            >
              {t("gitHistory.pruneWorktrees")}
            </button>
          )}
          <button
            className="tab-add-btn"
            onClick={() =>
              setWtForm((f) =>
                f
                  ? null
                  : {
                      name: "",
                      branch: addableBranches[0]?.name ?? "",
                      newBranch: addableBranches.length === 0,
                      startPoint: "",
                    },
              )
            }
            disabled={loading}
            title={t("gitHistory.addWorktreeTitle")}
          >
            {t(wtForm ? "gitHistory.cancel" : "gitHistory.addWorktree")}
          </button>
        </div>
        {lockstep?.enabled && (
          // #23 I5: `worktree add` does not route through the lockstep coordinator
          // the way `checkout` does, and a branch checked out in a worktree is one
          // lockstep will now refuse to move rather than corrupt (#23 D1).
          <div className="git-worktree-note">{t("gitHistory.worktreeLockstepNote")}</div>
        )}
        {worktrees.length > 0 && (
          <div className="git-branch-list git-worktree-list">
            {worktrees.map((wt) => {
              const label = wt.branch || wt.head.slice(0, 7) || basename(wt.path);
              const state = wt.is_prunable
                ? t("gitHistory.worktreeGone", {
                    reason: wt.prunable_reason || t("gitHistory.worktreeGoneReason"),
                  })
                : wt.is_locked
                  ? t("gitHistory.worktreeLocked", {
                      reason: wt.lock_reason || t("gitHistory.worktreeNoReason"),
                    })
                  : "";
              return (
                <span
                  key={wt.path}
                  className={
                    `git-branch-pill git-worktree-pill${wt.is_current ? " current" : ""}` +
                    `${wt.is_prunable ? " prunable" : ""}`
                  }
                  title={state ? `${wt.path}\n${state}` : wt.path}
                >
                  {wt.is_locked && (
                    <span className="git-worktree-flag" aria-label={t("gitHistory.locked")}>
                      🔒
                    </span>
                  )}
                  {wt.is_prunable && (
                    <span className="git-worktree-flag" aria-label={t("gitHistory.prunable")}>
                      ⚠
                    </span>
                  )}
                  {label}
                  {!wt.is_main && (
                    <button
                      className="git-worktree-btn"
                      onClick={() => setWorktreeLock(wt, !wt.is_locked)}
                      disabled={loading}
                      aria-label={t(
                        wt.is_locked ? "gitHistory.unlockWorktreeTitle" : "gitHistory.lockWorktreeTitle",
                        { path: wt.path },
                      )}
                      title={t(
                        wt.is_locked ? "gitHistory.unlockWorktreeTitle" : "gitHistory.lockWorktreeTitle",
                        { path: wt.path },
                      )}
                    >
                      {wt.is_locked ? "🔓" : "🔒"}
                    </button>
                  )}
                  {/* `is_main` is not the question a Remove control has to answer:
                      git deletes the tree you are standing in without complaint
                      (#23 D4), and the backend refuses that separately. */}
                  {!wt.is_main && !wt.is_current && (
                    <button
                      className="git-worktree-btn git-worktree-remove"
                      onClick={() => removeWorktree(wt)}
                      disabled={loading}
                      aria-label={t("gitHistory.removeWorktreeTitle", { path: wt.path })}
                      title={t("gitHistory.removeWorktreeTitle", { path: wt.path })}
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {wtForm && (
          <div className="git-worktree-form">
            <label className="git-worktree-newbranch">
              <Toggle
                size="sm"
                checked={wtForm.newBranch}
                onChange={(e) =>
                  setWtForm({
                    ...wtForm,
                    newBranch: e.target.checked,
                    // The field means a different thing in each mode, so it is
                    // cleared rather than carried across: an existing branch name
                    // is precisely the one value `-b` can never accept.
                    branch: e.target.checked ? "" : (addableBranches[0]?.name ?? ""),
                    startPoint: e.target.checked ? (currentBranch || localBranches[0]?.name || "") : "",
                  })
                }
              />
              {t("gitHistory.newBranchLabel")}
            </label>
            {wtForm.newBranch ? (
              <>
                {/* B1: with the toggle on, this MUST be free text. It was a listbox
                    of existing branches, so `-b <existing>` was the only payload the
                    form could send and git always answered "already exists". */}
                <input
                  type="text"
                  className="git-worktree-input"
                  placeholder={t("gitHistory.newBranchPlaceholder")}
                  value={wtForm.branch}
                  onChange={(e) => setWtForm({ ...wtForm, branch: e.target.value })}
                  aria-label={t("gitHistory.newBranchPlaceholder")}
                />
                <Dropdown
                  value={wtForm.startPoint}
                  title={t("gitHistory.startPointLabel")}
                  onChange={(v) => setWtForm({ ...wtForm, startPoint: v })}
                  options={[...localBranches, ...remoteBranches].map((b) => ({
                    value: b.name,
                    label: b.name,
                  }))}
                  placeholder={t("gitHistory.startPointLabel")}
                />
              </>
            ) : (
              <Dropdown
                value={wtForm.branch}
                title={t("gitHistory.branchLabel")}
                onChange={(v) => setWtForm({ ...wtForm, branch: v })}
                options={addableBranches.map((b) => ({ value: b.name, label: b.name }))}
                placeholder={t("gitHistory.branchLabel")}
              />
            )}
            <input
              type="text"
              className="git-worktree-input"
              placeholder={t("gitHistory.worktreeNamePlaceholder")}
              value={wtForm.name}
              onChange={(e) => setWtForm({ ...wtForm, name: e.target.value })}
              aria-label={t("gitHistory.worktreeNamePlaceholder")}
            />
            <button
              className="tab-add-btn"
              onClick={createWorktree}
              disabled={loading || !wtForm.branch.trim()}
            >
              {t("gitHistory.create")}
            </button>
            {/* One legal location, so the path is shown rather than chosen. */}
            {wtRoot && (
              <div className="git-worktree-path" title={wtRoot}>
                {`${wtRoot}${wtRoot.includes("\\") ? "\\" : "/"}${
                  wtForm.name.trim() || wtForm.branch.trim() || "…"
                }`}
              </div>
            )}
            {!wtForm.newBranch && addableBranches.length === 0 && (
              <div className="git-worktree-note">{t("gitHistory.noBranchesToAdd")}</div>
            )}
          </div>
        )}
      </div>

      {error && <div className="file-tree-error">{error}</div>}
      {loading && commits.length === 0 && <div className="file-tree-loading">{t("common.loading")}</div>}
      {!loading && commits.length === 0 && !error && (
        <div className="file-tree-empty">{t("gitHistory.noCommitsYet")}</div>
      )}

      <div className={`git-commit-list${graphMode ? " graph" : ""}`}>
        {commits.map((c, i) => {
          const refs = parseRefs(c.refs);
          // A branch tip carries at least one non-tag ref; mark it in the graph.
          const isTip = refs.some((r) => !r.startsWith("tag: "));
          return (
            <button
              key={c.hash}
              className={`git-commit-row${c.is_head ? " head" : ""}`}
              onClick={() => setSelected(c)}
              title={c.subject}
            >
              {graphMode && (
                <CommitGraphCell
                  row={graph[i]}
                  height={GRAPH_ROW_H}
                  lanes={graphLanes}
                  head={c.is_head}
                  tip={isTip}
                />
              )}
              <span className="git-commit-hash">{c.short}</span>
              <span className="git-commit-subject">{c.subject}</span>
              {refs.map((r) => {
                const color = branchColor.get(r);
                return (
                  <span
                    key={r}
                    className="git-commit-ref"
                    style={color ? { background: color } : undefined}
                  >
                    {r}
                  </span>
                );
              })}
              <span className="git-commit-date">{c.date}</span>
            </button>
          );
        })}
      </div>

      {selected && createPortal(
        <CommitWindow
          projectDir={projectDir}
          commit={selected}
          onClose={() => setSelected(null)}
          onCheckout={() => checkout(selected.hash)}
          onReworded={async () => {
            setSelected(null);
            await load();
            onChanged?.();
          }}
        />,
        document.body,
      )}
    </div>
  );
}

interface CommitWindowProps {
  projectDir: string;
  commit: GitCommit;
  onClose: () => void;
  onCheckout: () => void;
  onReworded: () => void;
}

function CommitWindow({ projectDir, commit, onClose, onCheckout, onReworded }: CommitWindowProps) {
  const t = useT();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<string>("git_commit_message", { projectDir, hash: commit.hash })
      .then(setMessage)
      .catch((e) => setError(String(e)));
  }, [projectDir, commit.hash]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const msg = await invoke<string>("git_generate_commit_message", { projectDir });
      setMessage(msg);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reword() {
    setBusy(true);
    setError(null);
    try {
      await invoke("git_reword_head", { projectDir, message });
      onReworded();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="commit-window" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{t("gitHistory.commitTitle", { short: commit.short })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="commit-window-meta">
          <span>{commit.author}</span>
          <span>·</span>
          <span>{commit.date}</span>
          {commit.is_head && <span className="git-commit-ref">HEAD</span>}
        </div>
        <textarea
          className="commit-window-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={8}
          readOnly={!commit.is_head}
          spellCheck={false}
        />
        {!commit.is_head && (
          <p className="settings-help">{t("gitHistory.onlyHeadReworded")}</p>
        )}
        {error && <div className="settings-error">{error}</div>}
        <div className="commit-window-actions">
          {commit.is_head && (
            <>
              <button type="button" disabled={busy} onClick={generate} title={t("gitHistory.generateTitle")}>
                {t("gitHistory.generateAgent")}
              </button>
              <button type="button" className="primary" disabled={busy || !message.trim()} onClick={reword}>
                {t("gitHistory.saveAmend")}
              </button>
            </>
          )}
          <button type="button" disabled={busy} onClick={onCheckout} title={t("gitHistory.checkoutCommitTitle")}>
            {t("gitHistory.checkout")}
          </button>
          <button type="button" onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}
