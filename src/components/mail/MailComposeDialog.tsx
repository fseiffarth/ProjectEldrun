import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { UntestedTag } from "../common/UntestedTag";
import {
  formatAddress,
  formatMailDate,
  formatSize,
  mailAiErrorKey,
  mailAttachPick,
  mailAttachRemove,
  mailDraftSave,
  mailDraftSend,
  mailFormalizeReply,
  mailPgpAvailable,
  mailPgpRecipientsReady,
  stripFormatControls,
  useMailAiFeature,
} from "../../lib/mail";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import type { MailAccount, MailBody, MailDraft, MailHeader, StagedAttachment } from "../../types/mail";

/**
 * The composer.
 *
 * The one thing to understand before editing it: **attaching a file is a backend
 * action.** `mail_attach_pick` raises the OS open dialog *inside Rust*, copies
 * what the user picked into the mail sandbox directory, and hands back opaque
 * staged ids. This component never sees, constructs, or displays a filesystem
 * path — there is no path field to type into and no drag-and-drop (the app window
 * sets `dragDropEnabled: false`, and compose must not be the exception). Because
 * the pick is keyed by draft id, the draft is saved first when it has no id yet;
 * that is the only reason `ensureDraft` exists.
 *
 * Chrome is the canonical `.modal-backdrop` > `.settings-dialog`, and the portal
 * sets its text color explicitly (`body` carries none, so black would be
 * inherited).
 */
export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export interface MailComposeDialogProps {
  accounts: MailAccount[];
  /** The account the message is sent from; the picker starts here. */
  accountId: string;
  mode: ComposeMode;
  /** The message being replied to / forwarded, when there is one. */
  source?: { header: MailHeader; body: MailBody | null };
  /** Pre-filled recipient (a `mailto:` link the user confirmed). */
  toAddress?: string;
  onClose: () => void;
}

/** Recipients are typed one per line or comma-separated, and parsed into a list —
 *  never concatenated into a header. A CR/LF in a recipient is how a `Bcc:` gets
 *  injected into an outgoing message (T16), and a list cannot carry one. */
export function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/[\r\n]/.test(s));
}

function quotedBody(
  source: { header: MailHeader; body: MailBody | null } | undefined,
  mode: ComposeMode,
  intro: string,
  forwardMark: string,
): string {
  if (!source || mode === "new") return "";
  const text = source.body?.text ?? "";
  const quoted = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return mode === "forward" ? `\n\n${forwardMark}\n${text}` : `\n\n${intro}\n${quoted}`;
}

export function MailComposeDialog({
  accounts,
  accountId,
  mode,
  source,
  toAddress,
  onClose,
}: MailComposeDialogProps) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();

  const header = source?.header;
  const initialTo =
    toAddress ??
    (mode === "reply" || mode === "replyAll" ? (header?.from.address ?? "") : "");
  const initialCc =
    mode === "replyAll" && header
      ? [...header.to, ...header.cc]
          .map((a) => a.address)
          .filter((a) => a && a !== header.from.address)
          .join("\n")
      : "";
  const subjectBase = stripFormatControls(header?.subject ?? "");
  const initialSubject =
    mode === "reply" || mode === "replyAll"
      ? subjectBase.toLowerCase().startsWith("re:")
        ? subjectBase
        : `${t("mail.replyPrefix")}${subjectBase}`
      : mode === "forward"
        ? `${t("mail.forwardPrefix")}${subjectBase}`
        : "";

  const [from, setFrom] = useState(accountId);
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState(initialCc);
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(initialSubject);
  const [text, setText] = useState(() =>
    quotedBody(
      source,
      mode,
      header
        ? t("mail.quotedIntro", {
            date: formatMailDate(header.date, lang, use24h),
            sender: formatAddress(header.from),
          })
        : "",
      t("mail.forwardedIntro"),
    ),
  );
  const [draftId, setDraftId] = useState("");
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [busy, setBusy] = useState<"" | "attach" | "save" | "send">("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  // End-to-end signing/encryption. **Both default off**, per message, and never
  // remembered — a sticky "encrypt" that silently turned itself off once would
  // be worse than one that always has to be chosen.
  const [sign, setSign] = useState(false);
  const [encrypt, setEncrypt] = useState(false);
  const [pgpReady, setPgpReady] = useState(false);
  const [missingKeys, setMissingKeys] = useState<string[]>([]);

  // #206 — draft a formal reply from rough notes, on a **loopback** model. It
  // only ever fills the body below; it never sends. Gated by the **sending
  // account's** `formalize` toggle plus the global master switch and a resolvable
  // mail-role model — `from` is the account this reply goes out as.
  const fromAccount = accounts.find((a) => a.id === from);
  const canFormalize = useMailAiFeature(fromAccount, "formalize");
  const [notes, setNotes] = useState("");
  const [tone, setTone] = useState("");
  const [drafting, setDrafting] = useState(false);

  async function draftFromNotes() {
    if (!notes.trim()) return;
    setDrafting(true);
    setError("");
    setStatus("");
    try {
      const reply = await mailFormalizeReply(notes, {
        accountId: from,
        messageId: header?.id ?? null,
        tone: tone || null,
      });
      // Fill the body with the drafted reply, keeping any quoted original below
      // it. **Never sends** — the user reviews and sends explicitly.
      const tail = quotedBody(
        source,
        mode,
        header
          ? t("mail.quotedIntro", {
              date: formatMailDate(header.date, lang, use24h),
              sender: formatAddress(header.from),
            })
          : "",
        t("mail.forwardedIntro"),
      );
      setText(reply + tail);
      setStatus(t("mailAi.draftDone"));
    } catch (err) {
      const key = mailAiErrorKey(err);
      setError(key ? t(key) : typeof err === "string" ? err : String(err));
    } finally {
      setDrafting(false);
    }
  }

  useEffect(() => {
    void mailPgpAvailable().then(setPgpReady);
  }, []);

  // Which recipients have no key, asked **while the message is being written**
  // rather than on Send. Finding out at Send means either a refused send after
  // the work is done, or — the thing this exists to make impossible — a user who
  // ticked Encrypt and did not notice it could not be honoured.
  const recipientList = [...parseRecipients(to), ...parseRecipients(cc), ...parseRecipients(bcc)];
  const recipientKey = recipientList.join(",");
  useEffect(() => {
    if (!encrypt || !recipientKey) {
      setMissingKeys([]);
      return;
    }
    let live = true;
    void mailPgpRecipientsReady(from, recipientKey.split(","))
      .then((missing) => live && setMissingKeys(missing))
      .catch(() => live && setMissingKeys([]));
    return () => {
      live = false;
    };
  }, [encrypt, recipientKey, from]);

  function buildDraft(): MailDraft {
    return {
      id: draftId,
      account_id: from,
      to: parseRecipients(to),
      cc: parseRecipients(cc),
      bcc: parseRecipients(bcc),
      subject: subject.replace(/[\r\n]/g, " "),
      body_text: text,
      // `in_reply_to` must be the sender's RFC `Message-ID`, never `header.id` —
      // that is Eldrun's own `{folder_id}-{uid}` store key, which no other mail
      // system has ever seen. Sending it would put a fabricated reference on the
      // wire: the reply threads nowhere and claims a message that does not exist.
      // A message that carried no `Message-ID` gets no `In-Reply-To` at all,
      // which is the honest degradation.
      ...(header?.rfc_message_id && mode !== "new" && mode !== "forward"
        ? { in_reply_to: header.rfc_message_id }
        : {}),
      staged,
    };
  }

  /** Persist the draft so it HAS an id — `mail_attach_pick` and `mail_draft_send`
   *  are both keyed by one. Returns the id, or `""` when the save failed. */
  async function ensureDraft(): Promise<string> {
    const saved = await mailDraftSave(buildDraft()).catch((err) => {
      setError(typeof err === "string" ? err : String(err));
      return null;
    });
    if (!saved) return "";
    setDraftId(saved.id);
    setStaged(saved.staged ?? staged);
    return saved.id;
  }

  async function doAttach() {
    setBusy("attach");
    setError("");
    setStatus(t("mail.attaching"));
    const id = draftId || (await ensureDraft());
    if (!id) {
      setBusy("");
      setStatus("");
      return;
    }
    // The BACKEND raises the picker. Nothing here names a path, and a cancelled
    // dialog simply returns an empty list.
    const picked = await mailAttachPick(id).catch((err) => {
      setError(typeof err === "string" ? err : String(err));
      return null;
    });
    setBusy("");
    setStatus("");
    if (picked?.length) setStaged((s) => [...s, ...picked]);
  }

  async function doRemoveAttachment(stagedId: string) {
    if (draftId) await mailAttachRemove(draftId, stagedId).catch(() => {});
    setStaged((s) => s.filter((a) => a.staged_id !== stagedId));
  }

  async function doSaveDraft() {
    setBusy("save");
    setError("");
    const id = await ensureDraft();
    setBusy("");
    if (id) setStatus(t("mail.draftSaved"));
  }

  async function doSend() {
    if (parseRecipients(to).length === 0) {
      setError(t("mail.recipientsRequired"));
      return;
    }
    setBusy("send");
    setError("");
    setStatus("");
    const id = await ensureDraft();
    if (!id) {
      setBusy("");
      return;
    }
    const result = await mailDraftSend(id, { sign, encrypt }).catch((err) => {
      setError(typeof err === "string" ? err : String(err));
      return null;
    });
    setBusy("");
    if (!result) return;
    if (result.error) {
      // Phase 3 sends directly and surfaces the failure — there is no retrying
      // outbox yet, so the message stays on screen rather than vanishing.
      setError(`${t("mail.sendFailed")} ${result.error}`);
      return;
    }
    setStatus(t("mail.sent"));
    onClose();
  }

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="settings-dialog mail-compose-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>
            {mode === "reply"
              ? t("mail.composeReply")
              : mode === "replyAll"
                ? t("mail.composeReplyAll")
                : mode === "forward"
                  ? t("mail.composeForward")
                  : t("mail.composeNew")}{" "}
            <UntestedTag />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-scroll">
          {accounts.length > 1 && (
            <label className="mail-field">
              <span className="mail-field-label">{t("mail.from")}</span>
              <select className="mail-input" value={from} onChange={(e) => setFrom(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label || a.address}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="mail-field">
            <span className="mail-field-label">{t("mail.to")}</span>
            <textarea
              className="mail-input mail-textarea"
              rows={2}
              autoFocus
              spellCheck={false}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <label className="mail-field">
            <span className="mail-field-label">{t("mail.cc")}</span>
            <textarea
              className="mail-input mail-textarea"
              rows={1}
              spellCheck={false}
              value={cc}
              onChange={(e) => setCc(e.target.value)}
            />
          </label>
          <label className="mail-field">
            <span className="mail-field-label">{t("mail.bcc")}</span>
            <textarea
              className="mail-input mail-textarea"
              rows={1}
              spellCheck={false}
              value={bcc}
              onChange={(e) => setBcc(e.target.value)}
            />
          </label>
          <div className="settings-help">{t("mail.composeRecipientsHint")}</div>

          <label className="mail-field">
            <span className="mail-field-label">{t("mail.subject")}</span>
            <input
              className="mail-input"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          {canFormalize && (
            <div className="mail-ai-notes">
              <label className="mail-field">
                <span className="mail-field-label">
                  {t("mailAi.notesLabel")} <UntestedTag />
                </span>
                <textarea
                  className="mail-input mail-textarea"
                  rows={3}
                  spellCheck={false}
                  placeholder={t("mailAi.notesPlaceholder")}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
              <div className="mail-ai-notes-row">
                <label className="mail-field-inline">
                  <span className="mail-field-label">{t("mailAi.toneLabel")}</span>
                  <select
                    className="mail-input"
                    value={tone}
                    onChange={(e) => setTone(e.target.value)}
                  >
                    <option value="">{t("mailAi.toneNeutral")}</option>
                    <option value="formal">{t("mailAi.toneFormal")}</option>
                    <option value="friendly">{t("mailAi.toneFriendly")}</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="mail-btn"
                  disabled={drafting || !notes.trim()}
                  onClick={() => void draftFromNotes()}
                >
                  {drafting ? t("mailAi.drafting") : t("mailAi.draftFromNotes")}
                </button>
              </div>
            </div>
          )}
          <textarea
            className="mail-input mail-compose-body"
            rows={14}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />

          <div className="mail-attach-row">
            <button
              type="button"
              className="mail-btn"
              disabled={busy !== ""}
              onClick={() => void doAttach()}
            >
              {busy === "attach" ? t("mail.attaching") : t("mail.attach")}
            </button>
            <span className="settings-help">{t("mail.attachHint")}</span>
          </div>
          {staged.length > 0 && (
            <div className="mail-staged">
              {staged.map((a) => (
                <span key={a.staged_id} className="mail-staged-chip">
                  {stripFormatControls(a.filename)}
                  <span className="mail-staged-size">{formatSize(a.size)}</span>
                  <button
                    type="button"
                    className="mail-staged-remove"
                    title={t("mail.removeAttachment")}
                    onClick={() => void doRemoveAttachment(a.staged_id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Offered only where it can actually be honoured: the keyring needs
              an encrypted local store, and a checkbox that fails on click is
              worse than one that is not there. */}
          {pgpReady && (
            <div className="mail-compose-crypto">
              <label className="mail-field-row">
                <input type="checkbox" checked={sign} onChange={(e) => setSign(e.target.checked)} />
                <span>{t("mail.crypto.signThis")}</span>
              </label>
              <label className="mail-field-row">
                <input
                  type="checkbox"
                  checked={encrypt}
                  onChange={(e) => setEncrypt(e.target.checked)}
                />
                <span>{t("mail.crypto.encryptThis")}</span>
              </label>
              {encrypt && (
                <p className="mail-note">{t("mail.crypto.encryptSubjectVisible")}</p>
              )}
              {/* Named, before the click. The send would refuse anyway — the
                  backend never downgrades to plaintext — but a refusal after the
                  message is written is a worse way to learn it. */}
              {encrypt && missingKeys.length > 0 && (
                <div className="mail-warning-strip">
                  {t("mail.crypto.missingKeys", { who: missingKeys.join(", ") })}
                </div>
              )}
            </div>
          )}

          {status && <div className="mail-note">{status}</div>}
          {error && <div className="project-dialog-error">{error}</div>}

          <div className="mail-dialog-actions">
            <button type="button" className="mail-btn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="mail-btn"
              disabled={busy !== ""}
              onClick={() => void doSaveDraft()}
            >
              {t("mail.saveDraft")}
            </button>
            <button
              type="button"
              className="mail-btn mail-btn-primary"
              disabled={busy !== ""}
              onClick={() => void doSend()}
            >
              {busy === "send" ? t("mail.sending") : t("mail.send")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
