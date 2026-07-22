import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useBigFoldersStore } from "../../stores/bigFolders";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useSyncStore, type BigFolderRow } from "../../stores/sync";
import { fmtSize } from "../../lib/viewers/fileUtils";
import { UntestedTag } from "../common/UntestedTag";

/**
 * "These folders are giant — sync them?", asked once, at setup.
 *
 * Byte-sync's scope is an opt-in manifest that does **not** read `.gitignore`,
 * so nothing else in Eldrun would ever mention that a `node_modules/`, `data/`
 * or `checkpoints/` is about to cross. The file tree already prices ONE folder
 * on the click that would sync it (`sync_auto_preview`); this asks the same
 * question for the whole project at the only moment the answer is cheap — before
 * the first pass has moved anything.
 *
 * It reports **both sides**, because at setup they mean different things: bytes
 * on the host are usually the experiment output that should stay there, bytes in
 * the local folder are usually the build/venv that should never have gone up.
 * A folder that exists on one side only shows a dash for the other, which is the
 * distinction stated rather than inferred.
 *
 * The default answer is **exclude** — every box starts ticked. The prompt only
 * ever lists folders past the giant threshold, and the cost of wrongly excluding
 * one is a click in the file tree, while the cost of wrongly syncing one is the
 * multi-GB transfer this dialog exists to prevent.
 */
export function BigFolderExcludeDialog({ projectId }: { projectId: string }) {
  const close = useBigFoldersStore((s) => s.close);
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const bigFolders = useSyncStore((s) => s.bigFolders);
  const setExcluded = useSyncStore((s) => s.setExcluded);
  // The host half of the census needs a live pool; re-run when one appears so a
  // project that was still connecting when this opened fills in its host column.
  const ssh = useRemoteStatusStore((s) => s.byProject[projectId]?.ssh ?? "off");

  const [rows, setRows] = useState<BigFolderRow[] | null>(null);
  const [hostScanned, setHostScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const scan = useCallback(async () => {
    try {
      const result = await bigFolders(projectId);
      setRows(result.folders);
      setHostScanned(result.hostScanned);
      setError(result.hostError);
      // Ticked by default (see the component doc); a standing exclusion stays
      // ticked, so re-opening the prompt shows the answer already on file.
      setChecked(new Set(result.folders.map((f) => f.rel)));
    } catch (e) {
      setRows([]);
      setError(String(e));
    }
  }, [bigFolders, projectId]);

  useEffect(() => {
    void scan();
  }, [scan, ssh === "connected"]);

  const apply = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const exclude = rows.filter((r) => checked.has(r.rel)).map((r) => r.rel);
      const include = rows.filter((r) => !checked.has(r.rel)).map((r) => r.rel);
      if (exclude.length) await setExcluded(projectId, exclude, true);
      // Un-ticking a row that already carried an exclusion must LIFT it, or the
      // dialog would be a one-way door.
      if (include.length) await setExcluded(projectId, include, false);
      close();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const toggle = (rel: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });

  const side = (files: number, bytes: number) =>
    files === 0 && bytes === 0 ? (
      <span className="big-folder-absent">—</span>
    ) : (
      <>
        {fmtSize(bytes)} <span className="big-folder-files">({files.toLocaleString()} files)</span>
      </>
    );

  return createPortal(
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          Large folders in {project?.name ?? "this project"} <UntestedTag />
        </h2>
        <p className="big-folder-intro">
          These folders are big enough that syncing them would dominate every
          transfer. Sync copies bytes and <strong>does not read .gitignore</strong>,
          so data kept on the host on purpose — experiment output, checkpoints,
          caches, virtualenvs — crosses like any other file unless it is excluded
          here.
        </p>

        {rows === null && <p className="big-folder-intro">Measuring both sides…</p>}

        {rows !== null && rows.length === 0 && (
          <p className="big-folder-intro">
            Nothing oversized found{hostScanned ? "" : " on the local side"}. Sync
            away.
          </p>
        )}

        {rows !== null && rows.length > 0 && (
          <>
            <div className="big-folder-head">
              <span />
              <span>Folder</span>
              <span>This machine</span>
              <span>Host</span>
            </div>
            <div className="big-folder-list">
              {rows.map((r) => (
                <label key={r.rel} className="big-folder-row">
                  <input
                    type="checkbox"
                    checked={checked.has(r.rel)}
                    onChange={() => toggle(r.rel)}
                  />
                  <span className="big-folder-path" title={r.rel}>
                    {r.rel}
                  </span>
                  <span>{side(r.localFiles, r.localBytes)}</span>
                  <span>{side(r.hostFiles, r.hostBytes)}</span>
                </label>
              ))}
            </div>
            <p className="big-folder-note">
              Ticked = <strong>excluded from sync</strong>. Nothing is deleted
              either way, and any folder can be re-included later from its
              right-click menu in the file tree. Git-tracked files still travel
              with your commits — exclusion applies to the byte sync.
            </p>
          </>
        )}

        {!hostScanned && rows !== null && (
          <p className="big-folder-note">
            The host was not measured{error ? ` (${error})` : " — the project is not connected"}.
            Only this machine's folders are listed; re-open this from the file
            view once connected to see the host's.
          </p>
        )}

        <div className="project-dialog-actions">
          <button type="button" onClick={close} disabled={busy}>
            Not now
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void apply()}
            disabled={busy || rows === null}
          >
            {rows && rows.length === 0 ? "Close" : "Apply"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Mounted once (AppShell); renders the prompt for whichever project asked. */
export function BigFolderDialogHost() {
  const projectId = useBigFoldersStore((s) => s.projectId);
  if (!projectId) return null;
  return <BigFolderExcludeDialog projectId={projectId} />;
}
