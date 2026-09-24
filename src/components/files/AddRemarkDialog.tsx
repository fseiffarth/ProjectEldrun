import { useId, useState } from "react";
import { useProjectRemarksStore } from "../../stores/projectRemarks";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { DialogShell } from "../common/PromptDialogs";

/** A multi-line note on a file (or one of its lines). Wears the panel's
 *  file-operation dialog (`DialogShell`), like every other question the file
 *  tree and viewer ask. */
export function AddRemarkDialog({ projectId, projectDir, file, line = null, onClose }: {
  projectId: string; projectDir: string; file: string; line?: number | null; onClose: () => void;
}) {
  const t = useT();
  const errorId = useId();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!text.trim()) return;
    setSaving(true); setError("");
    try { await useProjectRemarksStore.getState().add(projectId, projectDir, file, line, text); onClose(); }
    catch (e) { setError(String(e)); setSaving(false); }
  };
  return (
    <DialogShell onDismiss={() => !saving && onClose()}>
      <h2>{t("projectRemarks.addTitle")}<UntestedTag id="projectRemarks.addTitle" /></h2>
      <div className="file-delete-path">{line ? `${file}:${line}` : file}</div>
      <textarea
        autoFocus
        className="file-paste-name"
        rows={5}
        value={text}
        disabled={saving}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("projectRemarks.placeholder")}
      />
      {error && <div id={errorId} role="alert" className="file-delete-path file-delete-error">{error}</div>}
      <div className="file-delete-actions">
        <button type="button" onClick={onClose} disabled={saving}>{t("common.cancel")}</button>
        <button type="button" disabled={saving || !text.trim()} onClick={() => void save()}>{t("common.save")}</button>
      </div>
    </DialogShell>
  );
}
