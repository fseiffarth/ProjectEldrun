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
  /**
   * The `authserv-id` this account's receiving server writes into
   * `Authentication-Results`. While unset, **no SPF/DKIM/DMARC verdict is shown
   * at all** — an unchecked header is sender-controlled text.
   */
  authserv_id?: string;
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

/**
 * The local store's encryption, as one read (`docs/mail_encryption_plan.md`).
 *
 * More than a bool because four situations are distinguishable and collapsing
 * any two produces a lie — in particular `enabled && !active && ephemeral`,
 * which looks exactly like a working mailbox right up until the next launch
 * throws away everything it downloaded.
 */
export interface MailEncryptionState {
  /** A key file exists: this mailbox is configured to be encrypted. */
  enabled: boolean;
  /** The store actually open right now seals its values. */
  active: boolean;
  mode?: "keychain" | "passphrase";
  /** The open store is memory-only: nothing is being written down. */
  ephemeral: boolean;
  /** Why, in the user's words. Present only with `ephemeral`. */
  reason?: string;
  needs_passphrase: boolean;
  /** `undefined` means the user has never been asked — the only state in which to ask. */
  preference?: boolean;
  /** Whether turning encryption on means migrating existing mail. */
  has_existing_mail: boolean;
  keyring: MailKeyringState;
}

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
  /**
   * SPF/DKIM/DMARC as the **receiving server** reported them in
   * `Authentication-Results`, with the trust state the backend decided.
   * Absent when the message carried no such header — an absence, not a failure.
   */
  auth?: MailAuthResults;
  /** The user's local **priority mark** — see {@link MailPriority}. Absent means
   *  unmarked, and an unrecognized value from a newer backend arrives absent too
   *  (the Rust side degrades it rather than guessing). */
  priority?: MailPriority;
}

/**
 * A message's local priority mark: **Important** or **Urgent**.
 *
 * **A mark, not a move, and not an IMAP flag.** The message stays in the folder
 * and the account it arrived in; nothing is uploaded, copied or deleted, and
 * `mail_priority_set` is one of only three commands in this contract that opens
 * no socket at all.
 *
 * That is forced by the feature rather than chosen for convenience: the
 * Important and Urgent lists span *every account*, and no IMAP folder can hold
 * mail from two accounts — so the moment the list is cross-account, a local
 * column is the only thing that can implement it. A real server-side move would
 * mean one folder per account, a round trip per mark, new UIDs (invalidating
 * every cached body, attachment and store key for the message), and a failure
 * mode where some accounts took the move and others refused it.
 *
 * It is deliberately not the star (`flagged`): that one already means something
 * to the user and round-trips to the server, and overloading it would make
 * "starred" and "important" one bit wearing two names.
 *
 * The honest cost, stated here because the UI has to say it too: a mark is
 * **this machine's**. No other mail client sees it, and a mailbox re-synced onto
 * another Eldrun install starts unmarked.
 */
export type MailPriority = "important" | "urgent";

/** How much marked mail there is, across every account — the rail's two badges.
 *  Read as one value so the two numbers cannot disagree on screen. */
export interface MailPriorityCounts {
  important: number;
  urgent: number;
  /** Of those, how many are unread. The badge shows the *total* — a list you
   *  file mail into is not an inbox and does not empty as you read it — and the
   *  unread half is only what the rail tones with. */
  important_unread: number;
  urgent_unread: number;
}

/** RFC 8601 §2.7 result tokens. `unknown` is anything a later revision adds — an
 *  unrecognized result degrades to "we don't know", never to a pass. */
export type MailAuthVerdict =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "temperror"
  | "permerror"
  | "policy"
  | "unknown";

/**
 * One `method=result` clause.
 *
 * `identifier` is why this is not one green tick: `dkim=pass header.d=evil.example`
 * on a mail claiming to be from a bank is a genuine pass **by the wrong domain**.
 * `aligned` is that comparison against the visible `From`, already made in Rust.
 */
export interface MailAuthMethod {
  /** `spf`, `dkim`, `dmarc`, … lowercased, version suffix dropped. */
  method: string;
  result: MailAuthVerdict;
  /** The domain the method actually authenticated. */
  identifier?: string;
  /** Whether `identifier` shares a registrable domain with the visible `From`. */
  aligned?: boolean;
}

/**
 * Whether the topmost `Authentication-Results` header may be believed.
 *
 * - `verified` — the account names a trusted `authserv-id` and the topmost
 *   header carries it. **The only state in which `methods` is ever non-empty.**
 * - `foreign` — a trusted id is configured and the topmost header does not carry
 *   it, so these results were written by someone else — quite possibly the sender.
 * - `unconfigured` — no trusted id set for the account; nothing can be believed yet.
 */
export type MailAuthState = "verified" | "foreign" | "unconfigured";

export interface MailAuthResults {
  state: MailAuthState;
  /** The topmost header's `authserv-id`, as written. Absent when malformed. */
  authserv_id?: string;
  /** Clauses of the topmost header only — empty unless `state` is `verified`. */
  methods: MailAuthMethod[];
  /** How many such headers the message carried; only the topmost is ever read. */
  header_count: number;
}

/**
 * What the header list is ordered by.
 *
 * A closed set, not a column name: the backend turns it into an `ORDER BY`,
 * which SQLite cannot take as a bound parameter, so the safety of that one
 * interpolated clause rests on this union having no other members.
 *
 * The sort is applied by the **store**, over the whole folder, because the list
 * is paged — ordering the hundred rows on screen would sort a page, and the
 * biggest message in a mailbox is rarely among the newest.
 */
export type MailSort = "date" | "flagged" | "attachments" | "size";

export interface MailHeaderPage {
  items: MailHeader[];
  total: number;
  /**
   * How many messages a search actually looked at, present **only** when it
   * stopped early.
   *
   * A search over an encrypted store cannot use SQL `LIKE` — there is nothing
   * to match but ciphertext — so the backend opens rows one at a time and stops
   * at a bound. When that happens `total` means "matches among the ones I
   * looked at", which is a weaker claim than usual, and the list says so rather
   * than presenting a truncated answer as a complete one.
   */
  scanned?: number;
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
