import { useEffect, useMemo, useState } from "react";
import { fileMtime } from "../embed/fileAccess";
import { jumpToSource } from "../embed/FileViewerPane";
import { resolvePath } from "../../lib/paths";
import { REMARKS_FILE, resolveRemarkAbsPath, type ProjectRemark } from "../../lib/projectRemarks";
import { useProjectRemarksStore } from "../../stores/projectRemarks";
import { useCalendarStore } from "../../stores/calendar";
import { boardColumns, taskFromRemark } from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

const EMPTY_REMARKS: ProjectRemark[] = [];

export function RemarksPane({ projectId, projectDir, visible }: {
  projectId: string; projectDir: string; visible: boolean;
}) {
  const t = useT();
  const entry = useProjectRemarksStore((s) => s.byProject[projectId]);
  const [cursor, setCursor] = useState(0);
  const remarks = entry?.remarks ?? EMPTY_REMARKS;
  const groups = useMemo(() => {
    const out = new Map<string, ProjectRemark[]>();
    for (const remark of remarks) (out.get(remark.file) ?? out.set(remark.file, []).get(remark.file)!).push(remark);
    return [...out.entries()];
  }, [remarks]);

  useEffect(() => { if (visible) void useProjectRemarksStore.getState().refreshIfStale(projectId, projectDir); }, [visible, projectId, projectDir]);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void Promise.all([...new Set(remarks.filter((r) => !r.invalidPath).map((r) => r.file))].map(async (file) => {
      const abs = resolveRemarkAbsPath(projectDir, file);
      if (!abs) return [file, true] as const;
      try { await fileMtime(abs, projectId); return [file, false] as const; }
      catch { return [file, true] as const; }
    })).then((pairs) => { if (!cancelled) useProjectRemarksStore.getState().setFileMissing(projectId, Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [visible, projectId, projectDir, entry?.mtime, remarks]);

  const jump = (remark: ProjectRemark) => {
    const abs = resolveRemarkAbsPath(projectDir, remark.file);
    if (abs && !entry?.fileMissing[remark.file]) jumpToSource(abs, remark.line ?? 1);
  };
  const makeCard = async (remark: ProjectRemark) => {
    const calendar = useCalendarStore.getState();
    if (!calendar.calendars.length) await calendar.load();
    const current = useCalendarStore.getState();
    const columns = boardColumns(current.taskColumns);
    await current.createTask(taskFromRemark(remark, projectId, {
      calendarId: current.calendars[0]?.id ?? "default", columnId: columns[0]?.id ?? "backlog", now: new Date(),
    }));
  };
  const walk = (delta: number) => {
    if (!remarks.length) return;
    const next = (cursor + delta + remarks.length) % remarks.length;
    setCursor(next); jump(remarks[next]);
  };

  return <div className="project-remarks-pane">
    <div className="project-remarks-walk">
      <button title={t("projectRemarks.previous")} onClick={() => walk(-1)}>‹</button>
      <span>{remarks.length ? `${cursor + 1}/${remarks.length}` : "0/0"}</span>
      <button title={t("projectRemarks.next")} onClick={() => walk(1)}>›</button>
      <UntestedTag />
    </div>
    {entry?.loading ? <p>{t("common.loading")}</p> : entry?.error ? <p className="error-text">{entry.error}</p> : remarks.length === 0 ? (
      <div className="empty-state"><p>{t("projectRemarks.empty")}</p><button onClick={() => jumpToSource(resolvePath(projectDir, REMARKS_FILE), 1)}>{t("projectRemarks.openFile")}</button></div>
    ) : groups.map(([file, rows]) => <section key={file} className="project-remarks-group">
      <h3>{file}</h3>
      {rows.map((remark) => {
        const missing = remark.invalidPath || entry?.fileMissing[file];
        return <div key={`${remark.srcStart}-${remark.text}`} className={`project-remark-row${missing ? " missing" : ""}`}>
          <input type="checkbox" checked={remark.done} onChange={(e) => void useProjectRemarksStore.getState().setDone(projectId, projectDir, remark, e.target.checked)} />
          <button className="project-remark-target" disabled={missing} onClick={() => jump(remark)}>{file}{remark.line != null ? `:${remark.line}` : ""}</button>
          <span className="project-remark-text">{remark.text}</span>
          {missing && <small>{t("projectRemarks.fileMissing")}</small>}
          <button title={t("projectRemarks.edit")} onClick={() => { const next = window.prompt(t("projectRemarks.edit"), remark.text); if (next != null) void useProjectRemarksStore.getState().edit(projectId, projectDir, remark, next); }}>✎</button>
          <button title={t("projectRemarks.delete")} onClick={() => { if (window.confirm(t("projectRemarks.confirmDelete"))) void useProjectRemarksStore.getState().remove(projectId, projectDir, remark); }}>×</button>
          <button onClick={() => void makeCard(remark)}>{t("projectRemarks.makeCard")}</button>
        </div>;
      })}
    </section>)}
  </div>;
}
