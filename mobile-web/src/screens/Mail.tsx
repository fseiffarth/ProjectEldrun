import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type MailMarkAction,
  type MobileMailAccount,
  type MobileMailFolder,
  type MobileMailHeader,
  type MobileMailView,
  type MobileMailWrites,
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

/** Longest reply the sidecar accepts (`protocol::MAX_MAIL_REPLY_BYTES`). */
const MAX_REPLY_BYTES = 16 * 1024;

function replyBytes(text: string) {
  return new TextEncoder().encode(text).length;
}

/** A refusal the phone can explain, or the raw code when it cannot. */
function writeError(reason: unknown) {
  const code = reason instanceof ApiError ? reason.code : String(reason);
  if (code === "mail_actions_disabled") return "Switched off in Eldrun → Settings → Eldrun Mobile → Mail from the phone.";
  if (code === "mail_reply_disabled") return "Replies from the phone are switched off in Eldrun → Settings → Eldrun Mobile.";
  if (code === "desktop_unavailable") return "Eldrun is not running on the desktop.";
  if (code === "message_not_found") return "The message moved; refresh the folder.";
  return code;
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
  const [writes, setWrites] = useState<MobileMailWrites>({});
  const [reply, setReply] = useState("");
  const [confirmReply, setConfirmReply] = useState(false);
  const [sent, setSent] = useState(false);

  const loadOverview = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const { mail } = await api<{ mail: MobileMailView }>("/api/v1/mail");
      if (mail.view !== "overview") throw new Error("unexpected_mail_view");
      setAccounts(mail.accounts); setFolder(null); setMessage(null);
      setWrites({ actions: mail.actions === true, reply: mail.reply === true });
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
      setMessage(mail); setReply(""); setConfirmReply(false); setSent(false);
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };

  /** Both writes answer with the refreshed folder page, so the list and the
   * open message's own header are updated from the desktop's answer rather
   * than from what the phone hoped happened. */
  const absorbPage = (page: MobileMailView) => {
    if (page.view !== "folder") throw new Error("unexpected_mail_view");
    setFolder(page);
    setMessage((current) => {
      if (!current) return current;
      const updated = page.messages.find((item) => item.id === current.message.id);
      return updated ? { ...current, message: updated } : current;
    });
  };

  const mark = async (action: MailMarkAction) => {
    if (!folder || !message) return;
    setBusy(true); setError("");
    try {
      const { mail } = await api<{ mail: MobileMailView }>(
        `/api/v1/mail/folders/${encodeURIComponent(folder.folder.id)}/messages/${encodeURIComponent(message.message.id)}/mark`,
        { method: "POST", body: JSON.stringify({ action, offset: folder.offset }) },
        40_000,
      );
      absorbPage(mail);
    } catch (reason) { setError(writeError(reason)); } finally { setBusy(false); }
  };

  const sendReply = async () => {
    if (!folder || !message) return;
    setBusy(true); setError(""); setConfirmReply(false);
    try {
      const { mail } = await api<{ mail: MobileMailView }>(
        `/api/v1/mail/folders/${encodeURIComponent(folder.folder.id)}/messages/${encodeURIComponent(message.message.id)}/reply`,
        { method: "POST", body: JSON.stringify({ body: reply, offset: folder.offset }) },
        70_000,
      );
      absorbPage(mail);
      setReply(""); setSent(true);
    } catch (reason) { setError(writeError(reason)); } finally { setBusy(false); }
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
    <p className="notice">{writes.actions || writes.reply
      ? `Mail through the connected Eldrun desktop. ${writes.actions ? "Read state and star can be changed here. " : ""}${writes.reply ? "Plain-text replies go to the original sender only. " : ""}No sync, delete, move, links, or downloads.`
      : "Read-only mail through the connected Eldrun desktop. No sync, reply, state changes, links, or downloads."}</p>
    {error && <p className="error">{error}</p>}
    {busy && !accounts && <p className="mail-mobile-empty">Loading…</p>}

    {message ? <article className="mail-mobile-message">
      <div className="mail-mobile-message-meta">
        <strong>{sender(message.message)}</strong>
        <span>{safeText(message.message.sender.address)}</span>
        <time>{dateLabel(message.message.date)}</time>
      </div>
      {writes.actions && <div className="mail-mobile-actions">
        <button disabled={busy} onClick={() => void mark(message.message.seen ? "unseen" : "seen")}>
          {message.message.seen ? "Mark unread" : "Mark read"}
        </button>
        <button disabled={busy} onClick={() => void mark(message.message.flagged ? "unflag" : "flag")}>
          {message.message.flagged ? "☆ Unstar" : "★ Star"}
        </button>
      </div>}
      {message.truncated && <p className="mail-mobile-warning">Message text was truncated for the mobile view.</p>}
      <pre>{safeText(message.body) || "No plain-text body is available."}</pre>
      {message.attachments.length > 0 && <section className="mail-mobile-attachments">
        <h2>Attachments</h2>
        {message.attachments.map((attachment, index) => <div key={`${attachment.filename}-${index}`}>
          <span>{safeText(attachment.filename)}</span><small>{safeText(attachment.mime)} · {sizeLabel(attachment.size)}</small>
        </div>)}
      </section>}
      {writes.reply && <section className="mail-mobile-reply">
        <h2>Reply</h2>
        <small>To {safeText(message.message.sender.address)} — the recipient, subject and thread come from the original; only the text is yours.</small>
        {sent && <p className="mail-mobile-sent">Reply sent from the desktop.</p>}
        <textarea
          aria-label="Reply text"
          value={reply}
          disabled={busy}
          placeholder="Type a short reply…"
          onChange={(event) => { setReply(event.target.value); setConfirmReply(false); setSent(false); }}
        />
        {confirmReply ? <div className="mail-mobile-reply-confirm">
          <span>Send this reply to {safeText(message.message.sender.address)} now? It cannot be recalled.</span>
          <div>
            <button className="primary" disabled={busy} onClick={() => void sendReply()}>Send</button>
            <button disabled={busy} onClick={() => setConfirmReply(false)}>Cancel</button>
          </div>
        </div> : <button
          className="primary"
          disabled={busy || !reply.trim() || replyBytes(reply) > MAX_REPLY_BYTES}
          onClick={() => setConfirmReply(true)}
        >Send reply…</button>}
        {replyBytes(reply) > MAX_REPLY_BYTES && <p className="mail-mobile-warning">The reply is longer than the phone may send; finish it on the desktop.</p>}
      </section>}
    </article> : folder ? <>
      <section className="mail-mobile-list">
        {folder.messages.map((item) => <button className={`mail-mobile-row${item.seen ? "" : " unread"}${item.flagged ? " flagged" : ""}${item.answered ? " answered" : ""}`} key={item.id} onClick={() => void loadMessage(item)} disabled={busy}>
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
