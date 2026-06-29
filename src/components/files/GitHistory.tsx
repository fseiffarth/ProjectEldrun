import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

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
  is_bare: boolean;
}

interface Props {
  projectDir: string;
  /** Called after a checkout/reword so the parent can refresh git status. */
  onChanged?: () => void;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
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

export function GitHistory({ projectDir, onChanged }: Props) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [wtForm, setWtForm] = useState<{ path: string; branch: string; newBranch: boolean } | null>(null);
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
    try {
      const [log, br, wt] = await Promise.all([
        invoke<GitCommit[]>("git_log", { projectDir, limit: 100 }),
        invoke<GitBranch[]>("git_branches", { projectDir }),
        invoke<Worktree[]>("git_worktree_list", { projectDir }),
      ]);
      setCommits(log);
      setBranches(br);
      setWorktrees(wt ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectDir]);

  useEffect(() => {
    load();
  }, [load]);

  async function checkout(target: string) {
    setLoading(true);
    setError(null);
    try {
      await invoke("git_checkout", { projectDir, target });
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
        path: wtForm.path,
        branch: wtForm.branch,
        newBranch: wtForm.newBranch,
      });
      setWtForm(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }

  async function removeWorktree(path: string, force = false) {
    setLoading(true);
    setError(null);
    try {
      await invoke("git_worktree_remove", { projectDir, path, force });
      await load();
      onChanged?.();
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

  if (!projectDir) {
    return <div className="file-tree-empty">No project selected</div>;
  }

  return (
    <div className="git-history">
      <div className="git-history-toolbar">
        <span className="git-history-branch" title="Current branch">
          ⎇ {current ?? "(detached)"}
        </span>
        <button
          className={`tab-add-btn git-history-mode${graphMode ? " active" : ""}`}
          onClick={toggleGraphMode}
          aria-pressed={graphMode}
          title={graphMode ? "Switch to list view" : "Switch to graph view"}
        >
          {graphMode ? "⌗ Graph" : "≡ List"}
        </button>
        <button className="tab-add-btn git-history-refresh" onClick={load} title="Refresh" disabled={loading}>
          ⟳
        </button>
      </div>

      {(localBranches.length > 0 || remoteBranches.length > 0) && (
        <div className="git-branch-list">
          {localBranches.map((b) => (
            <button
              key={b.name}
              className={`git-branch-pill${b.is_current ? " current" : ""}`}
              onClick={() => !b.is_current && checkout(b.name)}
              disabled={loading || b.is_current}
              title={b.is_current ? `On ${b.name}` : `Checkout ${b.name}`}
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
              title={`Checkout ${b.name}`}
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
          <span className="git-worktree-title">Worktrees</span>
          <button
            className="tab-add-btn"
            onClick={() =>
              setWtForm((f) =>
                f ? null : { path: "", branch: localBranches[0]?.name ?? "", newBranch: false },
              )
            }
            disabled={loading}
            title="Add a worktree"
          >
            {wtForm ? "Cancel" : "+ Worktree"}
          </button>
        </div>
        {worktrees.length > 0 && (
          <div className="git-branch-list git-worktree-list">
            {worktrees.map((wt) => {
              const label = wt.branch || wt.head.slice(0, 7) || basename(wt.path);
              return (
                <span
                  key={wt.path}
                  className={`git-branch-pill${wt.is_main ? " current" : ""}`}
                  title={wt.path}
                >
                  {wt.is_locked && <span aria-label="locked">🔒 </span>}
                  {label}
                  {!wt.is_main && (
                    <button
                      className="git-worktree-remove"
                      onClick={() => removeWorktree(wt.path)}
                      disabled={loading}
                      aria-label={`Remove worktree ${wt.path}`}
                      title={`Remove worktree ${wt.path}`}
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
            <select
              value={wtForm.branch}
              onChange={(e) => setWtForm({ ...wtForm, branch: e.target.value })}
              aria-label="Branch"
            >
              {localBranches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Worktree path"
              value={wtForm.path}
              onChange={(e) => setWtForm({ ...wtForm, path: e.target.value })}
              aria-label="Worktree path"
            />
            <label className="git-worktree-newbranch">
              <input
                type="checkbox"
                checked={wtForm.newBranch}
                onChange={(e) => setWtForm({ ...wtForm, newBranch: e.target.checked })}
              />
              new branch
            </label>
            <button
              className="tab-add-btn"
              onClick={createWorktree}
              disabled={loading || !wtForm.path.trim() || !wtForm.branch.trim()}
            >
              Create
            </button>
          </div>
        )}
      </div>

      {error && <div className="file-tree-error">{error}</div>}
      {loading && commits.length === 0 && <div className="file-tree-loading">Loading…</div>}
      {!loading && commits.length === 0 && !error && (
        <div className="file-tree-empty">No commits yet</div>
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
          <h2>Commit {commit.short}</h2>
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
          <p className="settings-help">Only the latest commit (HEAD) can be reworded.</p>
        )}
        {error && <div className="settings-error">{error}</div>}
        <div className="commit-window-actions">
          {commit.is_head && (
            <>
              <button type="button" disabled={busy} onClick={generate} title="Generate a message from current changes">
                Generate (agent)
              </button>
              <button type="button" className="primary" disabled={busy || !message.trim()} onClick={reword}>
                Save (amend)
              </button>
            </>
          )}
          <button type="button" disabled={busy} onClick={onCheckout} title="Checkout this commit (detached HEAD)">
            Checkout
          </button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
