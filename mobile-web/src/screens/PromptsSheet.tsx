import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  createPrompt,
  deletePrompt,
  getPrompts,
  sendPrompt,
  updatePrompt,
  type ProjectPrompt,
  type ProjectPromptList,
  type TabRow,
} from "../api";

/** The project's collected prompts — text kept without a tab. Sending aims
 * one at an agent tab now (the desktop queues a one-time schedule at its own
 * current minute); Schedule hands the text to the per-tab schedule sheet. The
 * phone never learns project paths or tmux names: only opaque ids cross. */
export function PromptsSheet({ projectId, tabs, onClose, onSchedule }: {
  projectId: string;
  tabs: TabRow[];
  onClose: () => void;
  onSchedule: (tab: TabRow, message: string) => void;
}) {
  const agentTabs = tabs.filter((tab) => tab.kind === "agent" && tab.available);
  const [prompts, setPrompts] = useState<ProjectPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [targetId, setTargetId] = useState("");
  const target = agentTabs.find((tab) => tab.id === targetId) ?? agentTabs[0];

  const apply = useCallback((value: ProjectPromptList) => {
    setPrompts(value.prompts ?? []);
    setOffline(false);
    setError("");
  }, []);
  const fail = useCallback((cause: unknown) => {
    const unavailable = cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable");
    setOffline(unavailable);
    setError(unavailable ? "Open desktop Eldrun to manage collected prompts." : "Prompts could not be loaded.");
  }, []);
  const refresh = useCallback(
    () => getPrompts(projectId).then(apply, fail).finally(() => setLoading(false)),
    [apply, fail, projectId],
  );
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const reset = () => {
    setEditing(null);
    setMessage("");
  };
  const save = async () => {
    if (!message.trim()) {
      setError("Enter a prompt.");
      return;
    }
    setBusy(true);
    try {
      apply(editing ? await updatePrompt(projectId, editing, message) : await createPrompt(projectId, message));
      reset();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const send = async (prompt: ProjectPrompt) => {
    if (!target) return;
    setBusy(true);
    setNotice("");
    try {
      apply(await sendPrompt(projectId, prompt.id, target.id));
      setNotice(`Queued for ${target.label} — delivered at its next safe idle point, within one hour.`);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label="Collected prompts" onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label="Close">✕</button><h2>Collected prompts <small>Untested</small></h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">Prompts kept for this project without a tab. Send one to an agent tab now, or turn it into a schedule.</p>
      {agentTabs.length > 0
        ? <label className="mobile-prompt-target">Target tab<select value={target?.id ?? ""} disabled={offline} onChange={(event) => setTargetId(event.target.value)}>{agentTabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.label}</option>)}</select></label>
        : <p className="sheet-note">Open an agent tab to send or schedule a collected prompt.</p>}
      {notice && <p className="sheet-note" role="status">{notice}</p>}
      {error && <p className="sheet-note error" role="alert">{error}</p>}
      {loading ? <p className="sheet-note">Loading prompts…</p> : prompts.length === 0 ? <p className="sheet-note">No prompts collected yet.</p> : <div className="mobile-schedule-list">{prompts.map((prompt) => <article key={prompt.id}>
        <p>{prompt.message}</p>
        <div>
          <button className="primary" disabled={busy || offline || !target} onClick={() => void send(prompt)} aria-label={`Send now: ${prompt.message}`}>Send now</button>
          <button disabled={busy || offline || !target} onClick={() => target && onSchedule(target, prompt.message)}>Schedule…</button>
          <button disabled={busy || offline} onClick={() => { setEditing(prompt.id); setMessage(prompt.message); }}>Edit</button>
          <button className="danger" disabled={busy || offline} onClick={() => { setBusy(true); void deletePrompt(projectId, prompt.id).then(apply, fail).finally(() => setBusy(false)); }}>Delete</button>
        </div>
      </article>)}</div>}
      <div className="mobile-schedule-form" aria-disabled={offline}>
        <h3>{editing ? "Edit prompt" : "Add prompt"}</h3>
        <label>Prompt<textarea rows={4} value={message} disabled={offline} onChange={(event) => setMessage(event.target.value)} /></label>
        <div className="mobile-schedule-actions">{editing && <button disabled={busy} onClick={reset}>Cancel</button>}<button className="primary" disabled={busy || offline} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button></div>
      </div>
    </section>
  </div>;
}
