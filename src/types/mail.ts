/**
 * Wire types for the embedded mail client — the FROZEN CONTRACT between the
 * Rust backend (`src-tauri/src/commands/mail.rs`) and the React frontend
 * (`src/lib/mail.ts`, `src/stores/mail.ts`, `src/components/mail/`).
 *
 * Two rules make this file load-bearing rather than decorative:
 *
 * 1. **No command in this contract takes a filesystem path.** That is the whole
 *    statement of the sandbox boundary: files cross it only through
 *    `mail_attach_pick` / `mail_attachment_save`, both of which raise the native
 *    OS dialog *inside Rust*. An attacker who controls a message's bytes, its
 *    HTML, and any script that somehow escaped the render iframe still has no
 *    IPC verb that names a path — there is nothing to traverse.
 * 2. Field names are snake_case because they are serde-serialized Rust structs
 *    verbatim. Do not camelCase them on this side.
 *
 * Design rationale lives in `docs/mail_client_plan_a.md` (integration, store,
 * credentials) and `docs/mail_client_plan_b.md` (threat model, sanitizer,
 * transport, attachment rules).
 */

/** One parsed address. `name` is display text and is NEVER trusted as identity. */
export interface MailAddress {
  name?: string;
  address: string;
}

/** How a connection is secured. `none` exists only to be rejected loudly. */
export type MailSecurity = "tls" | "starttls" | "none";

export interface MailServer {
  host: string;
  port: number;
  user: string;
  security: MailSecurity;
}

/** `oauth2` is stubbed in v1 — the variant exists so the store shape is stable. */
export type MailAuthKind = "password" | "oauth2";

export interface MailAccount {
  id: string;
  label: string;
  address: string;
  display_name?: string;
  imap: MailServer;
  smtp: MailServer;
  auth: MailAuthKind;
  /** Opt-in, DEFAULT FALSE. False means the password lives in memory for the session only. */
  save_password: boolean;
  signature?: string;
  check_interval_min?: number;
}

/**
 * What the keychain actually did. Never collapse this to a bare account —
 * a write that silently failed is how a user loses a password they think is saved.
 */
export interface MailAccountSaved {
  account: MailAccount;
  saved: boolean;
  save_error?: string;
}

export interface MailProbe {
  imap_ok: boolean;
  smtp_ok: boolean;
  error?: string;
}

/** Mirrors the existing remote-credentials keyring state so the UI can reuse its banner. */
export type MailKeyringState = "available" | "locked" | "unavailable" | "unknown";

export interface MailPasswordState {
  has_saved: boolean;
  keyring: MailKeyringState;
}

export type MailFolderKind =
  | "inbox"
  | "sent"
  | "drafts"
  | "trash"
  | "junk"
  | "archive"
  | "other";

export interface MailFolder {
  id: string;
  account_id: string;
  /** Server-side path, e.g. "INBOX/Projects". Display uses `name`. */
  path: string;
  name: string;
  kind: MailFolderKind;
  unread: number;
  total: number;
}

export interface MailHeader {
  id: string;
  account_id: string;
  folder_id: string;
  uid: number;
  /**
   * The sender's RFC 5322 `Message-ID`. Distinct from `id`, which is Eldrun's
   * own `{folder_id}-{uid}` store key and means nothing to any other mail
   * system — a reply that puts the store key in `In-Reply-To` fabricates a
   * reference that threads nowhere. Absent when the message carried none.
   */
  rfc_message_id?: string;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  /** RFC 3339. */
  date: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  has_attachments: boolean;
  size: number;
  /** Short plain-text snippet, already stripped of markup by the backend. */
  preview: string;
  /**
   * Non-empty when the message's headers are malformed in a way the user must see
   * (e.g. DUPLICATE_FROM). The UI shows a warning strip; it never silently picks one.
   */
  malformed_headers?: string[];
}

export interface MailHeaderPage {
  items: MailHeader[];
  total: number;
}

export interface MailAttachmentMeta {
  part_id: string;
  /** Already run through the backend's `sanitize_attachment_name`. */
  filename: string;
  mime: string;
  size: number;
  inline: boolean;
  /** Set when the declared MIME type disagrees with the sniffed bytes or the extension. */
  type_mismatch?: string;
}

/**
 * One link found in the sanitized body. The sanitizer strips every `href` and
 * replaces it with `data-lid`, so the rendered document cannot navigate anywhere;
 * opening a link is a frontend decision made against this table.
 */
export interface MailLink {
  lid: number;
  /** The real target, punycode-decoded for display. */
  href: string;
  /** Host as shown to the user, after IDNA normalization. */
  display_host: string;
  /** True when the anchor's visible text claims a different host than `href`. */
  mismatch: boolean;
  /** Set for anything that is not http/https/mailto — such links must not offer "Open". */
  scheme_warning?: string;
}

export interface MailBody {
  id: string;
  /** Sanitized in Rust before it ever reaches the webview. Rendered in a script-less iframe. */
  html?: string;
  text?: string;
  /** How many remote references were blocked. Drives the "Load images" banner. */
  remote_refs: number;
  links: MailLink[];
  attachments: MailAttachmentMeta[];
  /** Set when the body hit a size/element cap and was truncated. */
  truncated?: boolean;
}

/** A file the user explicitly picked, already copied inside the mail sandbox dir. */
export interface StagedAttachment {
  staged_id: string;
  filename: string;
  mime: string;
  size: number;
}

export interface MailDraft {
  id: string;
  account_id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body_text: string;
  in_reply_to?: string;
  references?: string[];
  staged: StagedAttachment[];
}

export interface MailSendResult {
  sent_id?: string;
  error?: string;
}

export type MailFlag = "seen" | "flagged" | "answered" | "deleted";

export interface MailSyncSummary {
  account_id: string;
  folders: number;
  new_messages: number;
  error?: string;
}

export type MailSyncPhase = "start" | "folder" | "headers" | "done" | "error";

/** Payload of the `mail:sync` event. */
export interface MailSyncEvent {
  account_id: string;
  folder_id?: string;
  phase: MailSyncPhase;
  new_messages?: number;
  error?: string;
}

/** Payload of the `mail:new` event (inbox only). */
export interface MailNewEvent {
  account_id: string;
  folder_id: string;
  count: number;
}

/** Bounded bytes for in-pane preview. Never written to disk by the previewer. */
export interface MailPreviewBlob {
  mime: string;
  bytes_b64: string;
  truncated: boolean;
}
