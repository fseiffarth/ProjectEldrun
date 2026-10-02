import { useCallback, useEffect, useState } from "react";
import { describeFailure } from "../connection";
import {
  MAIL_MESSAGE_TIMEOUT,
  MAIL_REPLY_TIMEOUT,
  api,
  reloadIfApplied,
  wasApplied,
  type MailMarkAction,
  type MobileMailAccount,
  type MobileMailFolder,
  type MobileMailHeader,
  type MobileMailView,
  type MobileMailWrites,
} from "../api";
import { readChoice, writeChoice } from "../prefs";
import { isUntested } from "../../../src/lib/untested";
import { BRAND } from "../../../src/lib/brand";

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

/** A refusal in the reader's words — never the code (`connection.ts`). */
const writeError = describeFailure;

function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Where a folder sits in the pickers: the inbox first, the bins last, and
 * folders of one kind in the order the desktop sent them (the sort is stable). */
const KIND_ORDER = ["inbox", "drafts", "sent", "archive", "other", "junk", "trash"];
const KIND_GLYPH: Record<string, string> = { inbox: "📥", drafts: "📝", sent: "📤", archive: "🗄", junk: "⚠", trash: "🗑" };

function kindRank(kind: string) {
  const at = KIND_ORDER.indexOf(kind);
  return at < 0 ? KIND_ORDER.indexOf("other") : at;
}

function sortedFolders(folders: MobileMailFolder[]) {
  return [...folders].sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
}

/** The folder an account opens on when it is picked from inside a folder. */
function homeFolder(account: MobileMailAccount): MobileMailFolder | undefined {
  return account.folders.find((item) => item.kind === "inbox") ?? sortedFolders(account.folders)[0];
}

/** An account's entry in the picker carries its inbox's unread count — the one
 * number that says whether switching to it is worth the tap. Junk and trash
 * unread counts would only be noise there. */
function accountOption(account: MobileMailAccount) {
  const unread = account.folders.filter((item) => item.kind === "inbox").reduce((sum, item) => sum + item.unread, 0);
  return `${safeText(account.label) || safeText(account.address)}${unread > 0 ? ` · ${unread} unread` : ""}`;
}

const isAccountId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

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
  // The account the tab shows, remembered on this phone. A stored id the
  // desktop no longer lists falls back to its first account.
  const [accountId, setAccountId] = useState(() => readChoice("mailAccount", isAccountId, ""));
  const account = accounts?.find((item) => item.id === accountId) ?? accounts?.[0] ?? null;
  // An open folder belongs to the account that lists it, whatever is picked.
  const folderAccount = (folder && accounts?.find((item) => item.folders.some((entry) => entry.id === folder.folder.id))) || account;

  const loadOverview = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const { mail } = await api<{ mail: MobileMailView }>("/api/v1/mail");
      if (mail.view !== "overview") throw new Error("unexpected_mail_view");
      setAccounts(mail.accounts); setFolder(null); setMessage(null);
      setWrites({ actions: mail.actions === true, reply: mail.reply === true });
    } catch (reason) {
      setError(writeError(reason));
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void loadOverview(); }, [loadOverview]);

  const loadFolder = async (target: MobileMailFolder, offset = 0) => {
    setBusy(true); setError("");
    try {
      const { mail } = await api<{ mail: MobileMailView }>(`/api/v1/mail/folders/${encodeURIComponent(target.id)}?offset=${offset}`);
      if (mail.view !== "folder") throw new Error("unexpected_mail_view");
      takeFolder(mail); setMessage(null);
    } catch (reason) { setError(writeError(reason)); } finally { setBusy(false); }
  };

  const loadMessage = async (target: MobileMailHeader) => {
    if (!folder) return;
    setBusy(true); setError("");
    try {
      const { mail } = await api<{ mail: MobileMailView }>(`/api/v1/mail/folders/${encodeURIComponent(folder.folder.id)}/messages/${encodeURIComponent(target.id)}?offset=${folder.offset}`, undefined, MAIL_MESSAGE_TIMEOUT);
      if (mail.view !== "message") throw new Error("unexpected_mail_view");
      setMessage(mail); setReply(""); setConfirmReply(false); setSent(false);
    } catch (reason) { setError(writeError(reason)); } finally { setBusy(false); }
  };

  /** A folder page carries the folder's own fresh counts; they replace the
   * overview's copy, so the pickers and the way back show what was just read. */
  const takeFolder = (page: Extract<MobileMailView, { view: "folder" }>) => {
    setFolder(page);
    setAccounts((current) => current?.map((item) => ({
      ...item,
      folders: item.folders.map((entry) => entry.id === page.folder.id ? page.folder : entry),
    })) ?? current);
  };

  /** Picking an account from inside a folder opens that account's inbox; from
   * the overview it only changes whose folders are listed. */
  const chooseAccount = (id: string) => {
    setAccountId(id); writeChoice("mailAccount", id);
    if (!folder) return;
    const next = accounts?.find((item) => item.id === id);
    const target = next && homeFolder(next);
    if (target) void loadFolder(target);
    else setFolder(null);
  };

  const accountPicker = accounts && accounts.length > 1 && <select
    className="mail-mobile-account-select"
    aria-label="Mail account"
    value={(folder ? folderAccount : account)?.id ?? ""}
    disabled={busy}
    onChange={(event) => chooseAccount(event.target.value)}
  >{accounts.map((item) => <option key={item.id} value={item.id}>{accountOption(item)}</option>)}</select>;

  /** Both writes answer with the refreshed folder page, so the list and the
   * open message's own header are updated from the desktop's answer rather
   * than from what the phone hoped happened. */
  const absorbPage = (page: MobileMailView) => {
    if (page.view !== "folder") throw new Error("unexpected_mail_view");
    takeFolder(page);
    setMessage((current) => {
      if (!current) return current;
      const updated = page.messages.find((item) => item.id === current.message.id);
      return updated ? { ...current, message: updated } : current;
    });
  };

  /** The folder page a write answers with, read by its own route — for a
   * write the desktop made whose answer did not come back (`reloadIfApplied`). */
  const reloadPage = (page: { folder: MobileMailFolder; offset: number }) => () =>
    api<{ mail: MobileMailView }>(`/api/v1/mail/folders/${encodeURIComponent(page.folder.id)}?offset=${page.offset}`);

  const mark = async (action: MailMarkAction) => {
    if (!folder || !message) return;
    setBusy(true); setError("");
    try {
      const { mail } = await reloadIfApplied(api<{ mail: MobileMailView }>(
        `/api/v1/mail/folders/${encodeURIComponent(folder.folder.id)}/messages/${encodeURIComponent(message.message.id)}/mark`,
        { method: "POST", body: JSON.stringify({ action, offset: folder.offset }) },
        MAIL_MESSAGE_TIMEOUT,
      ), reloadPage(folder));
      absorbPage(mail);
    } catch (reason) { setError(writeError(reason)); } finally { setBusy(false); }
  };

  const sendReply = async () => {
    if (!folder || !message) return;
    setBusy(true); setError(""); setConfirmReply(false);
    try {
      const { mail } = await reloadIfApplied(api<{ mail: MobileMailView }>(
        `/api/v1/mail/folders/${encodeURIComponent(folder.folder.id)}/messages/${encodeURIComponent(message.message.id)}/reply`,
        { method: "POST", body: JSON.stringify({ body: reply, offset: folder.offset }) },
        MAIL_REPLY_TIMEOUT,
      ), reloadPage(folder));
      absorbPage(mail);
      setReply(""); setSent(true);
    } catch (reason) {
      setError(writeError(reason));
      // Sent, only the folder page did not come back: the draft must not stay
      // in the box under a Send button.
      if (wasApplied(reason)) { setReply(""); setSent(true); }
    } finally { setBusy(false); }
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
      ? `Mail through the connected ${BRAND.display} desktop. ${writes.actions ? "Read state and star can be changed here. " : ""}${writes.reply ? "Plain-text replies go to the original sender only. " : ""}No sync, delete, move, links, or downloads.`
      : `Read-only mail through the connected ${BRAND.display} desktop. No sync, reply, state changes, links, or downloads.`}</p>
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
      <div className="mail-mobile-switch">
        {accountPicker}
        {folderAccount && <select
          aria-label="Folder"
          value={folder.folder.id}
          disabled={busy}
          onChange={(event) => {
            const target = folderAccount.folders.find((item) => item.id === event.target.value);
            if (target) void loadFolder(target);
          }}
        >{sortedFolders(folderAccount.folders).map((item) => <option key={item.id} value={item.id}>
          {safeText(item.name)}{item.unread > 0 ? ` (${item.unread})` : ""}
        </option>)}</select>}
      </div>
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
      {accountPicker && <label className="mail-mobile-picker"><span>Account {isUntested("mobile.mail.accountPicker") && <span className="untested">Untested</span>}</span>{accountPicker}</label>}
      {account && <div className="mail-mobile-account">
        <div><strong>{safeText(account.label)}</strong><small>{safeText(account.address)}</small></div>
        <div className="mail-mobile-folders">{sortedFolders(account.folders).map((item) => <button className={item.unread > 0 ? "has-unread" : undefined} key={item.id} onClick={() => void loadFolder(item)} disabled={busy}>
          <i aria-hidden="true">{KIND_GLYPH[item.kind] ?? "📁"}</i><span>{safeText(item.name)}</span><small>{item.unread} unread · {item.total}</small>
        </button>)}</div>
      </div>}
      {accounts.length === 0 && <p className="mail-mobile-empty">No mail accounts are configured in {BRAND.display}.</p>}
    </section>}
  </main>;
}
