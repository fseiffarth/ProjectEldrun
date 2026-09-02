import { useCallback, useEffect, useState } from "react";
import {
  api,
  type MobileMailAccount,
  type MobileMailFolder,
  type MobileMailHeader,
  type MobileMailView,
} from "../api";

const PAGE_SIZE = 25;
const FORMAT_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function safeText(value: string) {
  return value.replace(FORMAT_CONTROLS, "");
}

function sender(message: MobileMailHeader) {
  const name = safeText(message.sender.name ?? "").trim();
  return name || safeText(message.sender.address) || "Unknown sender";
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? safeText(value) : date.toLocaleString();
}

function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function Mail() {
  const [accounts, setAccounts] = useState<MobileMailAccount[] | null>(null);
  const [folder, setFolder] = useState<Extract<MobileMailView, { view: "folder" }> | null>(null);
  const [message, setMessage] = useState<Extract<MobileMailView, { view: "message" }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadOverview = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const { mail } = await api<{ mail: MobileMailView }>("/api/v1/mail");
      if (mail.view !== "overview") throw new Error("unexpected_mail_view");
      setAccounts(mail.accounts); setFolder(null); setMessage(null);
    } catch (reason) {
      setError(`Desktop mail unavailable: ${String(reason)}`);
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void loadOverview(); }, [loadOverview]);

  const loadFolder = async (target: MobileMailFolder, offset = 0) => {
    setBusy(true); setError("");
    try {
      const { mail } = await api<{ mail: MobileMailView }>(`/api/v1/mail/folders/${encodeURIComponent(target.id)}?offset=${offset}`);
      if (mail.view !== "folder") throw new Error("unexpected_mail_view");
      setFolder(mail); setMessage(null);
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };

  const loadMessage = async (target: MobileMailHeader) => {
    if (!folder) return;
    setBusy(true); setError("");
    try {
      const { mail } = await api<{ mail: MobileMailView }>(`/api/v1/mail/folders/${encodeURIComponent(folder.folder.id)}/messages/${encodeURIComponent(target.id)}?offset=${folder.offset}`);
      if (mail.view !== "message") throw new Error("unexpected_mail_view");
      setMessage(mail);
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };

  // Mail is a tab now, so the chevron only ever walks its own stack: message →
  // folder → account list. At the root there is nothing above it to go back to.
  const goBack = message ? () => setMessage(null) : folder ? () => setFolder(null) : null;
  const refresh = () => {
    if (message) void loadMessage(message.message);
    else if (folder) void loadFolder(folder.folder, folder.offset);
    else void loadOverview();
  };

  return <main className="screen mail-mobile-screen">
    <header>
      {goBack && <button className="back" onClick={goBack}>‹</button>}
      <h1>{message ? safeText(message.message.subject) || "(No subject)" : folder ? safeText(folder.folder.name) : "Mail"}</h1>
      <button onClick={refresh} disabled={busy}>↻</button>
    </header>
    <p className="notice">Read-only mail through the connected Eldrun desktop. No sync, reply, state changes, links, or downloads.</p>
    {error && <p className="error">{error}</p>}
    {busy && !accounts && <p className="mail-mobile-empty">Loading…</p>}

    {message ? <article className="mail-mobile-message">
      <div className="mail-mobile-message-meta">
        <strong>{sender(message.message)}</strong>
        <span>{safeText(message.message.sender.address)}</span>
        <time>{dateLabel(message.message.date)}</time>
      </div>
      {message.truncated && <p className="mail-mobile-warning">Message text was truncated for the mobile view.</p>}
      <pre>{safeText(message.body) || "No plain-text body is available."}</pre>
      {message.attachments.length > 0 && <section className="mail-mobile-attachments">
        <h2>Attachments</h2>
        {message.attachments.map((attachment, index) => <div key={`${attachment.filename}-${index}`}>
          <span>{safeText(attachment.filename)}</span><small>{safeText(attachment.mime)} · {sizeLabel(attachment.size)}</small>
        </div>)}
      </section>}
    </article> : folder ? <>
      <section className="mail-mobile-list">
        {folder.messages.map((item) => <button className={`mail-mobile-row${item.seen ? "" : " unread"}`} key={item.id} onClick={() => void loadMessage(item)} disabled={busy}>
          <div><strong>{sender(item)}</strong><time>{dateLabel(item.date)}</time></div>
          <b>{safeText(item.subject) || "(No subject)"}{item.has_attachments ? " 📎" : ""}</b>
          <span>{safeText(item.preview)}</span>
        </button>)}
        {!busy && folder.messages.length === 0 && <p className="mail-mobile-empty">No messages in this page.</p>}
      </section>
      <div className="mail-mobile-pager">
        <button disabled={busy || folder.offset === 0} onClick={() => void loadFolder(folder.folder, Math.max(0, folder.offset - PAGE_SIZE))}>Previous</button>
        <small>{folder.total === 0 ? "0" : `${folder.offset + 1}–${Math.min(folder.offset + folder.messages.length, folder.total)}`} of {folder.total}</small>
        <button disabled={busy || folder.offset + folder.messages.length >= folder.total} onClick={() => void loadFolder(folder.folder, folder.offset + PAGE_SIZE)}>Next</button>
      </div>
    </> : accounts && <section className="mail-mobile-accounts">
      {accounts.map((account) => <div className="mail-mobile-account" key={account.id}>
        <div><strong>{safeText(account.label)}</strong><small>{safeText(account.address)}</small></div>
        <div className="mail-mobile-folders">{account.folders.map((item) => <button key={item.id} onClick={() => void loadFolder(item)} disabled={busy}>
          <span>{safeText(item.name)}</span><small>{item.unread} unread · {item.total}</small>
        </button>)}</div>
      </div>)}
      {accounts.length === 0 && <p className="mail-mobile-empty">No mail accounts are configured in Eldrun.</p>}
    </section>}
  </main>;
}
