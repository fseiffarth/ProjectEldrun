/**
 * QuickOpen-style file picker for attaching reference files as local-autocomplete
 * context (#45 context files). Modelled on `QuickOpen` but used as a controlled
 * modal (mounted while open) instead of a global Ctrl/Cmd+P singleton: it lists
 * the editor's project files via `list_project_paths`, fuzzy-ranks them with the
 * shared `src/lib/fuzzy.ts`, and calls `onPick(rel)` for the chosen file. Files
 * already attached are shown ticked and are picked-through to a no-op by the
 * caller. Reuses the `.qo-*` styles from QuickOpen.css.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fuzzyMatch, fuzzyRank } from "../../lib/fuzzy";
import "../files/QuickOpen.css";

interface PathEntry {
  path: string;
  is_dir: boolean;
}

const MAX_RESULTS = 50;

/** Render the rel path with the fuzzy-matched characters emphasised. */
function HighlightedPath({ text, query }: { text: string; query: string }) {
  const positions = useMemo(() => {
    if (!query) return null;
    const m = fuzzyMatch(query, text);
    return m ? new Set(m.positions) : null;
  }, [text, query]);

  if (!positions || positions.size === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  for (let i = 0; i < text.length; i++) {
    out.push(
      positions.has(i) ? (
        <span key={i} className="qo-hl">
          {text[i]}
        </span>
      ) : (
        text[i]
      ),
    );
  }
  return <>{out}</>;
}

export function ContextFilePicker({
  projectDir,
  attached,
  onPick,
  onClose,
}: {
  /** Project root whose files are offered (empty → "No project"). */
  projectDir: string;
  /** Relative paths already attached, shown ticked. */
  attached: string[];
  /** Add the picked file (project-relative path). The picker stays open so
   *  several files can be added in one session; Esc / backdrop closes it. */
  onPick: (rel: string) => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const attachedSet = useMemo(() => new Set(attached), [attached]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    if (!projectDir) {
      setFiles([]);
      setLoading(false);
      return;
    }
    invoke<PathEntry[]>("list_project_paths", { projectDir })
      .then((entries) => {
        if (!alive) return;
        setFiles(entries.filter((e) => !e.is_dir).map((e) => e.path));
      })
      .catch(() => alive && setFiles([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [projectDir]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(
    () => fuzzyRank(query, files, (f) => f).slice(0, MAX_RESULTS),
    [query, files],
  );

  useEffect(() => {
    setSelected((s) => (results.length === 0 ? 0 : Math.min(s, results.length - 1)));
  }, [results]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selected, results]);

  const onInputKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => (results.length === 0 ? 0 : (s + 1) % results.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => (results.length === 0 ? 0 : (s - 1 + results.length) % results.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = results[selected];
        if (pick) onPick(pick);
      }
    },
    [results, selected, onClose, onPick],
  );

  return (
    <div className="qo-backdrop" onMouseDown={onClose}>
      <div className="qo-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="qo-input"
          type="text"
          placeholder="Add file as autocomplete context…"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onInputKey}
        />
        <div className="qo-list" ref={listRef}>
          {loading ? (
            <div className="qo-empty">Loading…</div>
          ) : results.length === 0 ? (
            <div className="qo-empty">
              {!projectDir ? "No project" : files.length === 0 ? "No files" : "No matches"}
            </div>
          ) : (
            results.map((rel, idx) => (
              <div
                key={rel}
                data-idx={idx}
                className={"qo-row" + (idx === selected ? " qo-row-sel" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(rel);
                }}
                onMouseEnter={() => setSelected(idx)}
              >
                <span>
                  {attachedSet.has(rel) ? "✓ " : ""}
                  <HighlightedPath text={rel} query={query} />
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
