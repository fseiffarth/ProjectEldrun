/**
 * **The** typed invoke surface for the embedded mail client — one wrapper per
 * `mail_*` command, and nothing else in the frontend calls `invoke("mail_*")`
 * directly (the convention `lib/slurm.ts` and `lib/hpcWorkspace.ts` follow).
 *
 * Two properties of this module are load-bearing rather than stylistic:
 *
 *  1. **No wrapper takes a filesystem path**, because no command does. Files
 *     cross the mail sandbox boundary only through `mailAttachPick` (the backend
 *     raises the OS *open* dialog) and `mailAttachmentSave` (the backend raises
 *     the OS *save* dialog). There is deliberately no "open this attachment with
 *     the system app" verb here, and adding one would be the single ambient
 *     write+exec hole the whole design exists to avoid.
 *  2. **The srcdoc is built here, not in the backend.** `buildMessageSrcdoc`
 *     assembles the document the message body renders in, so the CSP that
 *     protects the iframe lives next to the code that fills it, and
 *     `bodyLooksUnsafe` is the tripwire that refuses to render a body the
 *     backend's sanitizer should already have made inert.
 *
 * Design rationale: `docs/mail_client_plan_a.md` §6 (the frozen contract) and
 * `docs/mail_client_plan_b.md` §2 (the render pipeline).
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  MailAccount,
  MailAccountSaved,
  MailBody,
  MailDraft,
  MailFlag,
  MailFolder,
  MailHeaderPage,
  MailNewEvent,
  MailPasswordState,
  MailPreviewBlob,
  MailProbe,
  MailSendResult,
  MailSyncEvent,
  MailSyncSummary,
  StagedAttachment,
} from "../types/mail";

// ── Accounts + credentials ───────────────────────────────────────────────────

/** Every configured account. Never touches the network. */
export function mailAccountsList(): Promise<MailAccount[]> {
  return invoke<MailAccount[]>("mail_accounts_list");
}

/**
 * Create or update an account.
 *
 * `remember` is `true | null` and **never `false`** — `false` would mean *clear
 * the saved credential*, which is how a save silently destroys the password it
 * just authenticated with (see `components/projects/useSavedCredential`'s
 * `rememberArg`, which is the helper every call site here uses). Clearing is
 * only ever the explicit {@link mailForgetPassword}.
 *
 * The result reports **what the keychain actually did** — a ticked box with a
 * refused write behind it is exactly the state that resurfaces at the next
 * launch as an unexplained password prompt.
 */
export function mailAccountUpsert(
  account: MailAccount,
  password: string | null,
  remember: true | null,
): Promise<MailAccountSaved> {
  return invoke<MailAccountSaved>("mail_account_upsert", { account, password, remember });
}

export function mailAccountDelete(accountId: string): Promise<void> {
  return invoke("mail_account_delete", { accountId });
}

/** Probe IMAP + SMTP with the (possibly unsaved) credentials in the dialog. */
export function mailAccountTest(
  account: MailAccount,
  password: string | null,
): Promise<MailProbe> {
  return invoke<MailProbe>("mail_account_test", { account, password });
}

/** Is a password saved for this account, and can the store even be read? */
export function mailPasswordState(accountId: string): Promise<MailPasswordState> {
  return invoke<MailPasswordState>("mail_password_state", { accountId });
}

/** The ONLY path that deletes a saved mail password. */
export function mailForgetPassword(accountId: string): Promise<void> {
  return invoke("mail_forget_password", { accountId });
}

// ── Folders, sync, headers ───────────────────────────────────────────────────

/** Cached folders, or a server refresh when `refresh` is set (network). */
export function mailFolders(accountId: string, refresh: boolean): Promise<MailFolder[]> {
  return invoke<MailFolder[]>("mail_folders", { accountId, refresh });
}

/** Fetch new headers. Emits `mail:sync` progress; cancel with {@link mailSyncCancel}. */
export function mailSync(
  accountId: string,
  folderId: string | null,
): Promise<MailSyncSummary> {
  return invoke<MailSyncSummary>("mail_sync", { accountId, folderId });
}

export function mailSyncCancel(accountId: string): Promise<void> {
  return invoke("mail_sync_cancel", { accountId });
}

/** One page of the local header index. Purely local — no network. */
export function mailHeaders(
  folderId: string,
  offset: number,
  limit: number,
  query: string | null,
): Promise<MailHeaderPage> {
  return invoke<MailHeaderPage>("mail_headers", { folderId, offset, limit, query });
}

/**
 * The sanitized body. `allowRemote` is the per-message, per-click opt-in behind
 * the "Load remote content" banner: the backend re-fetches the remote
 * references itself (no cookies, no auth headers, no `Referer`) and inlines them
 * as `data:` URIs, so the tracker never sees the user's IP unless they asked.
 * The frame's CSP never changes — `img-src data:` forever.
 */
export function mailBody(messageId: string, allowRemote: boolean): Promise<MailBody> {
  return invoke<MailBody>("mail_body", { messageId, allowRemote });
}

export function mailFlag(messageId: string, flag: MailFlag, value: boolean): Promise<void> {
  return invoke("mail_flag", { messageId, flag, value });
}

export function mailMove(messageIds: string[], destFolderId: string): Promise<void> {
  return invoke("mail_move", { messageIds, destFolderId });
}

// ── Drafts + the file boundary ───────────────────────────────────────────────

export function mailDraftSave(draft: MailDraft): Promise<MailDraft> {
  return invoke<MailDraft>("mail_draft_save", { draft });
}

export function mailDraftSend(draftId: string): Promise<MailSendResult> {
  return invoke<MailSendResult>("mail_draft_send", { draftId });
}

/**
 * IN (disk → mail): the **backend** raises the OS open dialog, copies whatever
 * the user picked into the mail sandbox dir, and hands back opaque staged ids.
 * The frontend supplies no path and learns none — the copy is the boundary, so a
 * compose window cannot re-read the original file later either.
 */
export function mailAttachPick(draftId: string): Promise<StagedAttachment[]> {
  return invoke<StagedAttachment[]>("mail_attach_pick", { draftId });
}

export function mailAttachRemove(draftId: string, stagedId: string): Promise<void> {
  return invoke("mail_attach_remove", { draftId, stagedId });
}

/**
 * OUT (mail → disk): the **backend** raises the OS save dialog with the
 * sanitized filename pre-filled and writes the bytes to the single path the user
 * chose. Returns that path for a toast, or `null` when the dialog was cancelled
 * (in which case nothing was written). There is no bulk "save all" — one dialog
 * per file is deliberate friction at the exact point the boundary is crossed.
 */
export function mailAttachmentSave(
  messageId: string,
  partId: string,
): Promise<string | null> {
  return invoke<string | null>("mail_attachment_save", { messageId, partId });
}

/** Bounded bytes for an in-pane preview. Nothing touches the filesystem. */
export function mailAttachmentPreview(
  messageId: string,
  partId: string,
): Promise<MailPreviewBlob> {
  return invoke<MailPreviewBlob>("mail_attachment_preview", { messageId, partId });
}

// ── Events ───────────────────────────────────────────────────────────────────

export function onMailSync(handler: (e: MailSyncEvent) => void): Promise<UnlistenFn> {
  return listen<MailSyncEvent>("mail:sync", (ev) => handler(ev.payload));
}

export function onMailNew(handler: (e: MailNewEvent) => void): Promise<UnlistenFn> {
  return listen<MailNewEvent>("mail:new", (ev) => handler(ev.payload));
}

// ── The render surface (pure; no IPC) ────────────────────────────────────────

/**
 * The frame's Content-Security-Policy, verbatim and constant.
 *
 * It is a single frozen string on purpose: "load remote images" is a *backend*
 * action that inlines `data:` URIs, never a per-message relaxation of this
 * policy, because a relaxed policy is exactly the kind of state that gets left
 * on. `default-src 'none'` is the base — every directive not listed inherits it.
 * `style-src 'unsafe-inline'` is required for our reset and for the surviving
 * `style=` attributes, and is safe **only** because scripts are impossible here.
 * The valueless `sandbox` directive restates the iframe attribute inside the
 * document, so the policy survives even if the attribute is ever edited away.
 */
export const MAIL_FRAME_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; " +
  "object-src 'none'; frame-src 'none'; child-src 'none'; connect-src 'none'; " +
  "font-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'; sandbox";

/** Our own trusted reset inside the frame. The message's own CSS cannot reach
 *  these rules — they are in the document's `<style>`, which the sanitizer strips
 *  from the message itself. `content` on `.mail-link::after` is deliberate: the
 *  CSS property allowlist that bans `content` applies to *message* CSS, not ours. */
const FRAME_STYLE = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 13px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    background: #ffffff;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .mail-body { padding: 12px 14px; max-width: 100%; }
  .mail-body img { max-width: 100%; height: auto; }
  .mail-body table { max-width: 100%; border-collapse: collapse; }
  .mail-body pre, .mail-body code { white-space: pre-wrap; }
  .mail-plain { white-space: pre-wrap; font: 12px/1.6 ui-monospace, Menlo, Consolas, monospace; }
  .mail-link { color: #2563eb; text-decoration: underline; cursor: default; }
  .mail-link::after { content: " \\2197"; font-size: 0.85em; opacity: 0.7; }
  blockquote { margin: 0 0 0 10px; padding-left: 10px; border-left: 2px solid #c8c8c8; color: #555; }
`;

/** Escape text for a text node / attribute value. Used for the plain-text body,
 *  which is never HTML and must never be treated as such. */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * **The tripwire, not a second sanitizer.**
 *
 * The backend sanitizes with `ammonia` before the HTML ever crosses IPC, and
 * Plan B argues at length against a second, differently-parsing sanitizer on
 * this side (two allowlists drift, and mismatched parse semantics are a known
 * mutation-XSS source). What the frontend *does* owe is a cheap assertion of the
 * invariant it depends on: if any of these survive, the backend regressed, and
 * the honest response is an error card — never a render.
 *
 * **It inspects markup, never text.** Scanning the whole string was the obvious
 * spelling and the wrong one: sanitized output escapes its text nodes, so `<` can
 * only introduce a real tag — but `=` cannot be escaped away, and the attribute
 * pattern `\son[a-z]+\s*=` matches the ordinary English " one = two". A tripwire
 * that refuses to render a message *about* HTML, in a mail client shipped inside
 * a developer tool, would fire mostly on legitimate mail — and a false alarm that
 * common is how a real one gets ignored. So the scan runs over start-tags only,
 * and text content is not evidence of anything.
 */
export function bodyLooksUnsafe(html: string): boolean {
  const lowered = html.toLowerCase();
  // Any `<` that opens a tag at all. The sanitizer must not have emitted these
  // regardless of where they sit, so they are checked against the raw string.
  if (
    lowered.includes("<script") ||
    lowered.includes("<iframe") ||
    lowered.includes("<object") ||
    lowered.includes("<embed") ||
    lowered.includes("<form") ||
    lowered.includes("<base") ||
    lowered.includes("<link")
  ) {
    return true;
  }
  // Everything else is an *attribute* claim, so it is only meaningful inside a
  // start tag. `[^>]*` is deliberately naive: a `>` inside a quoted attribute
  // value ends the match early, which can only ever make this check narrower —
  // and a sanitizer that emits such a value has already failed the checks above.
  for (const tag of lowered.match(/<[a-z][a-z0-9-]*[^>]*>/g) ?? []) {
    if (
      /\son[a-z]+\s*=/.test(tag) || // event handler
      /\shref\s*=/.test(tag) || // links must be data-lid markers, never hrefs
      /\ssrcdoc\s*=/.test(tag) ||
      /\ssrcset\s*=/.test(tag) ||
      /\sformaction\s*=/.test(tag) ||
      tag.includes("javascript:") ||
      tag.includes("vbscript:")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Assemble the `srcdoc` document for a message body.
 *
 * The `<meta>` CSP is the **first content in the document**, before any element
 * that could load — a CSP meta placed after the first resource-loading element
 * is ignored for that element. It is an inline `<meta>` rather than the `csp=`
 * iframe attribute because CSP Embedded Enforcement is a Chromium feature that
 * **WebKitGTK does not implement**: relying on it would produce a policy that
 * silently does not exist on Linux, the worst available failure mode. CSP
 * inheritance into `about:srcdoc` is treated as a bonus, never as the mechanism.
 */
export function buildMessageSrcdoc(body: {
  html?: string;
  text?: string;
}): string {
  const fragment = body.html
    ? `<div class="mail-body" dir="auto">${body.html}</div>`
    : `<div class="mail-body"><pre class="mail-plain">${escapeHtml(body.text ?? "")}</pre></div>`;
  return [
    "<!DOCTYPE html>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${MAIL_FRAME_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    `<style>${FRAME_STYLE}</style>`,
    fragment,
  ].join("\n");
}

// ── Small display helpers (pure) ─────────────────────────────────────────────

/**
 * How an address is rendered anywhere in the mail UI: **the addr-spec is always
 * shown**. A display name is attacker-chosen text (`From: "support@bank.example"
 * <a@evil.example>`), so it is never allowed to stand in for identity — and it is
 * stripped of the bidi/format controls that would otherwise let it reorder what
 * the user reads.
 */
export function formatAddress(addr: { name?: string; address: string }): string {
  const name = stripFormatControls(addr.name ?? "").trim();
  return name && name !== addr.address ? `${name} <${addr.address}>` : addr.address;
}

/** Remove bidi overrides, isolates and zero-width characters from display text.
 *  These are what turn a filename with an embedded RLO into something that
 *  reads as a harmless .png. */
export function stripFormatControls(text: string): string {
  return text.replace(
    /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u00AD\u061C\u180E\uFEFF]/g,
    "",
  );
}

/** A byte count for an attachment chip. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** RFC 3339 → a short local stamp; an unparseable date is shown verbatim rather
 *  than as "Invalid Date" (a malformed `Date:` header is itself information). */
export function formatMailDate(iso: string, locale?: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

/** Only `http`/`https` may ever be handed to `open_external_url` (which refuses
 *  everything else itself — a second, independent check). A `mailto:` is handled
 *  internally by the composer; every other scheme is text, not a link. */
export function linkIsOpenable(link: { href: string; scheme_warning?: string }): boolean {
  if (link.scheme_warning) return false;
  const lowered = link.href.trim().toLowerCase();
  return lowered.startsWith("http://") || lowered.startsWith("https://");
}

/** True for a `mailto:` link, which opens the internal composer rather than the
 *  OS handler (T17: `mailto:` is never handed to the system). */
export function linkIsMailto(link: { href: string }): boolean {
  return link.href.trim().toLowerCase().startsWith("mailto:");
}

/** Open a vetted link in the user's browser. The URL comes from the parent's own
 *  `MailBody.links` table keyed by `lid` — never from a string the frame handed
 *  back, which is what preserves the anti-phishing property regardless. */
export function openMailLink(url: string): Promise<void> {
  return invoke("open_external_url", { url });
}
