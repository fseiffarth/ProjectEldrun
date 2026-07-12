import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dropdown } from "../common/Dropdown";
import { useProjectsStore } from "../../stores/projects";
import { resolveProjectDirectory } from "../../types";
import { isPathWithin } from "../../lib/paths";
import { relFromAbs } from "../../lib/viewers/fileUtils";
import { highlight, languageForPath } from "../../lib/viewers/highlight";
import {
  diffLines,
  groupChanges,
  buildMerged,
  applyBlockToggle,
  canToggle,
  type AlignRow,
  type ChangeBlock,
  type Decision,
} from "../../lib/viewers/linediff";

/** Mirrors the Rust `GitCommit` (serde default snake→camel via serde? no — the
 *  struct is plain, so fields arrive as declared: hash/short/subject/… ). */
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

// Reuse the diff viewer's low-alpha add/del tints so it reads in both themes.
const ADD_BG = "rgba(63, 185, 80, 0.15)";
const DEL_BG = "rgba(248, 81, 73, 0.15)";

/** Resolve the owning project directory for `path` exactly like `useBlame`:
 *  the longest project dir that contains the path, else the active project. */
function projectDirFor(path: string): string {
  const { projects, activeId } = useProjectsStore.getState();
  let best = "";
  for (const p of projects) {
    const dir = resolveProjectDirectory(p);
    if (dir && isPathWithin(path, dir) && dir.length > best.length) best = dir;
  }
  if (!best) {
    const active = projects.find((p) => p.id === activeId);
    best = active ? resolveProjectDirectory(active) : "";
  }
  return best;
}

/** A read-only column (old or new) rendered line-by-line with per-line tinting
 *  and reused syntax highlighting. Only lines present on that side are shown. */
function SideColumn({
  title,
  rows,
  side,
  path,
  scrollRef,
  onScroll,
}: {
  title: string;
  rows: AlignRow[];
  side: "left" | "right";
  path: string;
  scrollRef: React.RefObject<HTMLDivElement>;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}) {
  const lang = useMemo(() => languageForPath(path), [path]);
  const lines = useMemo(() => {
    const out: { text: string; tint: string | undefined; no: number }[] = [];
    let no = 0;
    for (const r of rows) {
      const text = side === "left" ? r.left : r.right;
      if (text == null) continue; // absent on this side
      no++;
      const tint =
        r.kind === "change"
          ? side === "left"
            ? DEL_BG
            : ADD_BG
          : r.kind === "del" && side === "left"
            ? DEL_BG
            : r.kind === "add" && side === "right"
              ? ADD_BG
              : undefined;
      out.push({ text, tint, no });
    }
    return out;
  }, [rows, side]);

  return (
    <div className="file-viewer-compare-col">
      <div className="file-viewer-compare-col-head">{title}</div>
      <div className="file-viewer-compare-col-body" ref={scrollRef} onScroll={onScroll}>
        {lines.map((l, i) => {
          const html = highlight(l.text, lang);
          return (
            <div className="file-viewer-compare-line" style={{ background: l.tint }} key={i}>
              <span className="file-viewer-compare-lno">{l.no}</span>
              {html != null ? (
                <span className="file-viewer-compare-code" dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                <span className="file-viewer-compare-code">{l.text}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Three-column compare/merge view for the in-app text editors. Left is the file
 * at a chosen commit (its own history, via `git_file_log`), right is the live
 * editor content, and the middle is an editable merged result. Each change block
 * can be accepted (keep the new/right lines) or rejected (restore the old/left
 * lines); the middle buffer stays freely editable and toggles splice into it by
 * context anchor. "Apply to file" feeds the merged text back into the editor's
 * normal draft/save flow.
 */
export function CompareView({
  path,
  rightText,
  onApply,
  onClose,
}: {
  path: string;
  /** The live editor content (the "new" side). */
  rightText: string;
  onApply: (merged: string) => void;
  onClose: () => void;
}) {
  const projectDir = useMemo(() => projectDirFor(path), [path]);
  const relPath = useMemo(() => relFromAbs(projectDir, path), [projectDir, path]);

  const [history, setHistory] = useState<GitCommit[]>([]);
  const [rev, setRev] = useState<string>("");
  const [oldText, setOldText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load this file's commit history and default to its most recent commit (the
  // "previous version" relative to the working copy).
  useEffect(() => {
    let cancelled = false;
    setError(null);
    invoke<GitCommit[]>("git_file_log", { projectDir, relPath, limit: 100 })
      .then((commits) => {
        if (cancelled) return;
        setHistory(commits);
        setRev((cur) => cur || (commits[0]?.hash ?? ""));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectDir, relPath]);

  // Fetch the file at the selected revision (the "old" side).
  useEffect(() => {
    if (!rev) {
      setOldText(null);
      return;
    }
    let cancelled = false;
    setOldText(null);
    invoke<string>("git_file_at_rev", { projectDir, relPath, rev })
      .then((text) => {
        if (!cancelled) setOldText(text);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectDir, relPath, rev]);

  const rows = useMemo(() => diffLines(oldText ?? "", rightText), [oldText, rightText]);
  const blocks = useMemo(() => groupChanges(rows), [rows]);

  // Merge state: a decision per block plus the authoritative editable buffer.
  // `manual` flips once the user hand-edits, switching toggles from a wholesale
  // recompute to a context-anchored splice that preserves those edits.
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [resultText, setResultText] = useState<string>("");
  const [manual, setManual] = useState(false);

  // Re-seed the merge whenever the compared versions change: default every block
  // to "accept", so the result starts equal to the live editor content.
  useEffect(() => {
    setDecisions({});
    setManual(false);
    setResultText(oldText == null ? rightText : buildMerged(rows, blocks, {}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oldText, rightText]);

  const decisionOf = (b: ChangeBlock): Decision => decisions[b.id] ?? "accept";

  const toggle = (b: ChangeBlock) => {
    const cur = decisionOf(b);
    if (!manual) {
      const next = { ...decisions, [b.id]: cur === "accept" ? ("reject" as Decision) : ("accept" as Decision) };
      setDecisions(next);
      setResultText(buildMerged(rows, blocks, next));
      return;
    }
    const res = applyBlockToggle(resultText, b, cur);
    if (!res) return; // unanchored — button is disabled anyway
    setResultText(res.text);
    setDecisions({ ...decisions, [b.id]: res.decision });
  };

  const setAll = (d: Decision) => {
    const next: Record<number, Decision> = {};
    for (const b of blocks) next[b.id] = d;
    setDecisions(next);
    setManual(false);
    setResultText(buildMerged(rows, blocks, next));
  };

  const toggleEnabled = (b: ChangeBlock): boolean =>
    !manual || canToggle(resultText, b, decisionOf(b));

  // Proportional scroll-sync across the three panes (content heights differ, so
  // this is by ratio, not line-for-line). A guard flag avoids feedback loops.
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const midRef = useRef<HTMLTextAreaElement>(null);
  const syncing = useRef(false);
  const syncFrom = (src: HTMLElement) => {
    if (syncing.current) return;
    syncing.current = true;
    const ratio = src.scrollHeight - src.clientHeight > 0
      ? src.scrollTop / (src.scrollHeight - src.clientHeight)
      : 0;
    for (const el of [leftRef.current, rightRef.current, midRef.current]) {
      if (!el || el === src) continue;
      const max = el.scrollHeight - el.clientHeight;
      if (max > 0) el.scrollTop = ratio * max;
    }
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  const revLabel = (c: GitCommit) => `${c.short}${c.is_head ? " (HEAD)" : ""} · ${c.subject}`;
  const options =
    history.length > 0
      ? history.map((c) => ({ value: c.hash, label: revLabel(c) }))
      : [{ value: "", label: "No history for this file" }];
  const selected = history.find((c) => c.hash === rev);
  const loading = rev !== "" && oldText == null && error == null;

  return (
    <div className="file-viewer-compare">
      <div className="file-viewer-compare-bar">
        <span className="file-viewer-compare-label">Compare against</span>
        <Dropdown
          value={rev}
          options={options}
          onChange={setRev}
          className="file-viewer-compare-rev"
          title="Pick a commit from this file's history"
          placeholder="Select a commit"
        />
        {selected && <span className="file-viewer-compare-date">{selected.date}</span>}
        <div className="file-viewer-compare-bar-gap" />
        <button
          className="file-viewer-format-btn"
          onClick={() => setAll("accept")}
          disabled={blocks.length === 0}
          title="Keep the current (new) version for every change"
        >
          Accept all
        </button>
        <button
          className="file-viewer-format-btn"
          onClick={() => setAll("reject")}
          disabled={blocks.length === 0}
          title="Revert every change to the old version"
        >
          Reject all
        </button>
        <button
          className="file-viewer-format-btn file-viewer-compare-apply"
          onClick={() => onApply(resultText)}
          title="Write the merged result into the editor"
        >
          Apply to file
        </button>
        <button className="file-viewer-format-btn" onClick={onClose} title="Close compare">
          Close
        </button>
      </div>

      {error != null ? (
        <div className="file-viewer-error">{error}</div>
      ) : loading ? (
        <div className="file-viewer-loading">Loading version…</div>
      ) : (
        <div className="file-viewer-compare-cols">
          <SideColumn
            title={selected ? `Old — ${selected.short}` : "Old"}
            rows={rows}
            side="left"
            path={path}
            scrollRef={leftRef}
            onScroll={(e) => syncFrom(e.currentTarget)}
          />

          <div className="file-viewer-compare-col file-viewer-compare-col-mid">
            <div className="file-viewer-compare-col-head">
              <span>Result</span>
              {blocks.length > 0 && (
                <div className="file-viewer-compare-chips">
                  {blocks.map((b, i) => {
                    const dec = decisionOf(b);
                    const enabled = toggleEnabled(b);
                    return (
                      <span
                        className={`file-viewer-compare-chip ${dec === "accept" ? "accept" : "reject"}${enabled ? "" : " disabled"}`}
                        key={b.id}
                        title={
                          enabled
                            ? dec === "accept"
                              ? "Change kept (new). Click to revert to old."
                              : "Change reverted (old). Click to keep new."
                            : "Edited manually — toggle unavailable"
                        }
                        onClick={() => enabled && toggle(b)}
                      >
                        {dec === "accept" ? "✓" : "↩"} {i + 1}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
            <textarea
              ref={midRef}
              className="file-viewer-compare-result"
              value={resultText}
              spellCheck={false}
              onChange={(e) => {
                setResultText(e.target.value);
                setManual(true);
              }}
              onScroll={(e) => syncFrom(e.currentTarget)}
            />
          </div>

          <SideColumn
            title="Current (editor)"
            rows={rows}
            side="right"
            path={path}
            scrollRef={rightRef}
            onScroll={(e) => syncFrom(e.currentTarget)}
          />
        </div>
      )}
    </div>
  );
}
