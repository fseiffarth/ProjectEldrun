import { useState } from "react";
import { createPortal } from "react-dom";
import { useProjectRemarksStore } from "../../stores/projectRemarks";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

export function AddRemarkDialog({ projectId, projectDir, file, line = null, onClose }: {
  projectId: string; projectDir: string; file: string; line?: number | null; onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!text.trim()) return;
    setSaving(true); setError("");
    try { await useProjectRemarksStore.getState().add(projectId, projectDir, file, line, text); onClose(); }
    catch (e) { setError(String(e)); setSaving(false); }
  };
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card project-remark-dialog" style={{ color: "var(--text-primary)" }} role="dialog" aria-modal="true">
        <div className="modal-header"><h2>{t("projectRemarks.addTitle")}</h2><UntestedTag /><button onClick={onClose}>×</button></div>
        <div className="modal-divider" />
        <p className="muted">{line ? `${file}:${line}` : file}</p>
        <textarea autoFocus className="cal-input" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("projectRemarks.placeholder")} />
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions"><button onClick={onClose}>{t("common.cancel")}</button><button className="primary" disabled={saving || !text.trim()} onClick={() => void save()}>{t("common.save")}</button></div>
      </div>
    </div>, document.body,
  );
}
