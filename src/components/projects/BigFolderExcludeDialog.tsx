import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useBigFoldersStore } from "../../stores/bigFolders";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useSettingsStore } from "../../stores/settings";
import { useSyncStore, type BigFolderRow } from "../../stores/sync";
import { isCarefulHost, primaryTargetOf } from "../../lib/carefulHost";
import { fmtSize } from "../../lib/viewers/fileUtils";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";

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
  const t = useT();
  const close = useBigFoldersStore((s) => s.close);
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const bigFolders = useSyncStore((s) => s.bigFolders);
  const setExcluded = useSyncStore((s) => s.setExcluded);
  // The host half of the census needs a live pool; re-run when one appears so a
  // project that was still connecting when this opened fills in its host column.
  const ssh = useRemoteStatusStore((s) => s.byProject[projectId]?.ssh ?? "off");

  // A **careful** host does not get the host half by itself: it is a recursive
  // `du -ak -x`, and on a cluster the project root usually sits on the parallel
  // filesystem, where stat-ing a whole tree is a metadata storm against a shared
  // server. The local walk still runs — it is this machine's own disk — so the
  // prompt is still useful, just half-filled until the user asks for the rest.
  const settings = useSettingsStore((s) => s.settings);
  const careful = isCarefulHost(settings, primaryTargetOf(project));

  const [rows, setRows] = useState<BigFolderRow[] | null>(null);
  const [hostScanned, setHostScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [scanningHost, setScanningHost] = useState(false);

  const scan = useCallback(
    async (scanHost: boolean) => {
      try {
        const result = await bigFolders(projectId, scanHost);
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
    },
    [bigFolders, projectId],
  );

  // The automatic pass — on open, and again when a pool appears so a project that
  // was still connecting fills in its host column. On a careful host this stays
  // local-only however often it re-runs; only the explicit button below crosses.
  useEffect(() => {
    void scan(!careful);
  }, [scan, careful, ssh === "connected"]);

  const measureHost = async () => {
    setScanningHost(true);
    try {
      await scan(true);
    } finally {
      setScanningHost(false);
    }
  };

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
          {t("bigFolder.titlePre")} {project?.name ?? t("bigFolder.thisProject")} <UntestedTag />
        </h2>
        <p className="big-folder-intro">
          {t("bigFolder.introPre")} <strong>{t("bigFolder.doesNotReadGitignore")}</strong>{t("bigFolder.introPost")}
        </p>

        {rows === null && <p className="big-folder-intro">{t("bigFolder.measuring")}</p>}

        {rows !== null && rows.length === 0 && (
          <p className="big-folder-intro">
            {hostScanned ? t("bigFolder.nothingOversizedFull") : t("bigFolder.nothingOversizedLocalOnly")}
          </p>
        )}

        {rows !== null && rows.length > 0 && (
          <>
            <div className="big-folder-head">
              <span />
              <span>{t("bigFolder.colFolder")}</span>
              <span>{t("bigFolder.colThisMachine")}</span>
              <span>{t("bigFolder.colHost")}</span>
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
              {t("bigFolder.notePre")} <strong>{t("bigFolder.excludedFromSync")}</strong>{t("bigFolder.notePost")}
            </p>
          </>
        )}

        {/* Two different reasons the host column is empty, said apart. "Not
            connected" is a state that will fix itself; "marked careful" is a
            decision, and the only thing that lifts it is the button beside it. */}
        {!hostScanned && rows !== null && careful && (
          <p className="big-folder-note">
            {t("bigFolder.hostSkippedCareful")}
            {error ? ` (${error})` : ""}{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => void measureHost()}
              disabled={scanningHost || ssh !== "connected"}
            >
              {scanningHost ? t("bigFolder.measuringHost") : t("bigFolder.measureHost")}
            </button>
          </p>
        )}

        {!hostScanned && rows !== null && !careful && (
          <p className="big-folder-note">
            {t("bigFolder.hostNotMeasuredPre")}{error ? ` (${error})` : ` — ${t("bigFolder.hostNotConnected")}`}
            {t("bigFolder.hostNotMeasuredPost")}
          </p>
        )}

        <div className="project-dialog-actions">
          <button type="button" onClick={close} disabled={busy}>
            {t("bigFolder.notNow")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void apply()}
            disabled={busy || rows === null}
          >
            {rows && rows.length === 0 ? t("bigFolder.close") : t("bigFolder.apply")}
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
