//! Serde structs for the embedded mail client.
//!
//! Two jobs in one module:
//!
//! 1. **The wire contract.** Every type below serializes to exactly the shape
//!    `src/types/mail.ts` declares — snake_case, same field names, same
//!    optionality. That file is frozen for the phase; this one must follow it,
//!    not the other way round.
//! 2. **`accounts.json`.** [`MailAccounts`] is the on-disk store under
//!    `~/.local/share/eldrun/mail/accounts.json`. It carries **no secret of any
//!    kind** — passwords live in the OS keychain via
//!    `services::remote_credentials`, keyed by server target (see
//!    `commands::mail::mail_account`). It does carry the things an observer
//!    would like to know — your address, your provider, your login name, your
//!    signature — so once the store is encrypted it moves to
//!    `accounts.json.enc`, one whole-file envelope
//!    (`docs/mail_encryption_plan.md` §3.3).
//!
//! Both the file struct and each account carry a `#[serde(flatten)] extra`
//! catch-all, exactly like `schema::calendar` — that catch-all is what lets a
//! field written by a newer build survive being read and rewritten by an older
//! one instead of being silently dropped.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Accounts ────────────────────────────────────────────────────────────────

/// How a connection is secured. `Starttls`/`None` exist so the stored shape is
/// stable and an imported account round-trips; the transport refuses both (plan
/// B §4.1 — implicit TLS only, so there is no cleartext phase to strip).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MailSecurity {
    #[default]
    Tls,
    Starttls,
    None,
}

/// One protocol endpoint of an account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct MailServer {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub security: MailSecurity,
}

/// `oauth2` is stubbed in v1 (plan B §0.4): the variant exists so the store
/// shape is stable and every `match` on it is a compile error the day XOAUTH2
/// lands. Only `Password` is constructible from the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MailAuthKind {
    #[default]
    Password,
    Oauth2,
}

/// Per-account **Mail AI (local)** feature toggles (Group Q, #203–#208).
///
/// These live on the account rather than in `Settings` because the decision is
/// per mailbox: a work account may want auto-filing and extraction while a
/// personal one wants none of it, and a single global switch could not say so.
/// All are opt-in and **default off/absent**; the whole feature is additionally
/// gated by the one *global* master switch `Settings::mail_ai_allow` and by a
/// resolvable loopback mail-role model (see `src/lib/mail.ts`'s
/// `mailAiResolvable`). `autoclassify` is the only field read in the **backend**
/// (a background sync has no UI in the loop); the rest gate frontend surfaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct MailAiPrefs {
    /// Offer the on-demand "Summarize (local)" control in the message view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summarize: Option<bool>,
    /// Let a sync ask the local model to file **new inbox** messages into
    /// Important/Urgent, after the keyword-filter pass. Read in `sync_inner`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autoclassify: Option<bool>,
    /// Offer the composer's "Draft from notes" control.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formalize: Option<bool>,
    /// Offer "Add to calendar" extraction on a message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar: Option<bool>,
    /// Offer "Add to-do" extraction on a message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todo: Option<bool>,
    /// The "no review step" opt-in for the calendar/to-do extractors.
    /// **Default off** — mail must never quietly write to the user's own data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_create: Option<bool>,
    #[serde(flatten, default)]
    pub extra: HashMap<String, Value>,
}

impl MailAiPrefs {
    /// True when no field is set — used to store `None` rather than an empty
    /// `{}` object, keeping an account that never touched Mail AI clean.
    pub fn is_empty(&self) -> bool {
        self.summarize.is_none()
            && self.autoclassify.is_none()
            && self.formalize.is_none()
            && self.calendar.is_none()
            && self.todo.is_none()
            && self.auto_create.is_none()
            && self.extra.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct MailAccount {
    pub id: String,
    /// The dialog's **Name**, and the *sending* identity: `mail_send` writes it
    /// as the `From:` display name, so of the two names on an account this is
    /// the one that leaves the machine. Empty means send the bare address.
    pub label: String,
    pub address: String,
    /// The dialog's **Display name** — local only, and read by exactly one
    /// surface: the accounts badge. Never written to a header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub imap: MailServer,
    pub smtp: MailServer,
    #[serde(default)]
    pub auth: MailAuthKind,
    /// Opt-in, **default false**. False means the password lives in memory for
    /// the session only (plan A §5, the standing no-password-storage rule).
    #[serde(default)]
    pub save_password: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_interval_min: Option<u32>,
    /// The `authserv-id` this account's own receiving server writes into
    /// `Authentication-Results`. Unset by default, and while it is unset **no
    /// SPF/DKIM/DMARC verdict is ever shown** — an unchecked header is sender
    /// -controlled text, so believing one without knowing whose it is would be
    /// worse than showing nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authserv_id: Option<String>,
    /// Per-account **Mail AI (local)** toggles. Absent for an account that never
    /// opened the feature; see [`MailAiPrefs`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<MailAiPrefs>,
    #[serde(flatten, default)]
    pub extra: HashMap<String, Value>,
}

/// `~/.local/share/eldrun/mail/accounts.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MailAccounts {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub accounts: Vec<MailAccount>,
    #[serde(flatten, default)]
    pub extra: HashMap<String, Value>,
}

/// Current `accounts.json` version. Bumped only for a shape change a reader has
/// to branch on; additive fields ride the `extra` catch-all.
pub const ACCOUNTS_VERSION: u32 = 1;

// ── Command results ─────────────────────────────────────────────────────────

/// What the keychain actually did. Never collapsed to a bare account — a write
/// that silently failed is how a user loses a password they think is saved
/// (`services::remote_credentials::RememberOutcome`, same reasoning).
#[derive(Debug, Clone, Serialize)]
pub struct MailAccountSaved {
    pub account: MailAccount,
    pub saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MailProbe {
    pub imap_ok: bool,
    pub smtp_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Mirrors the remote-credentials keyring state so the mail UI can reuse the
/// existing "Keyring locked — unlock to use the saved password" banner. The
/// extra `Unknown` variant exists because the frozen TS union has it; the
/// backend maps `remote_credentials::KeyringState` onto the first three.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MailKeyringState {
    Available,
    Locked,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct MailPasswordState {
    pub has_saved: bool,
    pub keyring: MailKeyringState,
}

/// Everything the UI needs to say one true sentence about the local store's
/// encryption (`docs/mail_encryption_plan.md`).
///
/// Deliberately more than a bool, because there are four distinguishable
/// situations and collapsing any two of them produces a lie: encryption off;
/// on and open; on but waiting for a passphrase; on but the key is unreachable,
/// so what is on screen is a memory-only stand-in that forgets everything at
/// exit. That last one *looks* exactly like a working mailbox until the next
/// launch, which is precisely why it has to be reported rather than inferred.
#[derive(Debug, Clone, Serialize)]
pub struct MailEncryptionState {
    /// A key file exists: this mailbox is configured to be encrypted.
    pub enabled: bool,
    /// The store that is **actually open right now** seals its values.
    /// `enabled && !active` is the interesting case — it means the store on
    /// screen is not the store on disk.
    pub active: bool,
    /// `"keychain"` or `"passphrase"`, when enabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// The open store is memory-only: nothing is being written down.
    pub ephemeral: bool,
    /// Why, in the user's words. Present only with `ephemeral`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The store is waiting for a passphrase to be typed.
    pub needs_passphrase: bool,
    /// The recorded answer to "should this mailbox be encrypted". `None` means
    /// the user has never been asked, which is the only state in which the UI
    /// should ask.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preference: Option<bool>,
    /// Whether there is already mail on disk, i.e. whether turning encryption on
    /// means a migration rather than a fresh start. Drives which of the two
    /// offers the prompt leads with.
    pub has_existing_mail: bool,
    /// Whether the OS credential store can be reached at all, so the dialog can
    /// grey out the silent option instead of offering one that will fail.
    pub keyring: MailKeyringState,
}

// ── Folders, headers, bodies ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MailFolderKind {
    Inbox,
    Sent,
    Drafts,
    Trash,
    Junk,
    Archive,
    #[default]
    Other,
}

impl MailFolderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MailFolderKind::Inbox => "inbox",
            MailFolderKind::Sent => "sent",
            MailFolderKind::Drafts => "drafts",
            MailFolderKind::Trash => "trash",
            MailFolderKind::Junk => "junk",
            MailFolderKind::Archive => "archive",
            MailFolderKind::Other => "other",
        }
    }

    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "inbox" => MailFolderKind::Inbox,
            "sent" => MailFolderKind::Sent,
            "drafts" => MailFolderKind::Drafts,
            "trash" => MailFolderKind::Trash,
            "junk" => MailFolderKind::Junk,
            "archive" => MailFolderKind::Archive,
            _ => MailFolderKind::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailFolder {
    pub id: String,
    pub account_id: String,
    /// Server-side path, e.g. `INBOX/Projects`. Display uses `name`.
    pub path: String,
    pub name: String,
    pub kind: MailFolderKind,
    pub unread: u32,
    pub total: u32,
}

/// One parsed address. `name` is display text and is **never** trusted as
/// identity — the UI always renders the addr-spec (plan B T7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct MailAddress {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub address: String,
}

// ── Authentication-Results (RFC 8601) ───────────────────────────────────────

/// One method's verdict. The set is RFC 8601 §2.7's, plus `Unknown` for a value
/// a future revision adds — an unrecognized result must degrade to "we don't
/// know", never to a pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailAuthVerdict {
    Pass,
    Fail,
    SoftFail,
    Neutral,
    None,
    TempError,
    PermError,
    Policy,
    Unknown,
}

impl MailAuthVerdict {
    pub fn from_token(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "pass" => MailAuthVerdict::Pass,
            "fail" => MailAuthVerdict::Fail,
            "softfail" => MailAuthVerdict::SoftFail,
            "neutral" => MailAuthVerdict::Neutral,
            "none" => MailAuthVerdict::None,
            "temperror" => MailAuthVerdict::TempError,
            "permerror" => MailAuthVerdict::PermError,
            "policy" => MailAuthVerdict::Policy,
            _ => MailAuthVerdict::Unknown,
        }
    }
}

/// One `method=result` clause with the identity it actually authenticated.
///
/// `identifier` is the load-bearing field and the reason this is not reduced to
/// a single green tick: `dkim=pass header.d=evil.example` on a message claiming
/// to be from a bank is a *genuine* pass of a signature by the wrong domain.
/// The verdict without the domain it applies to is the classic misreading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailAuthMethod {
    /// Lowercased method name (`spf`, `dkim`, `dmarc`, `iprev`, …), version suffix dropped.
    pub method: String,
    pub result: MailAuthVerdict,
    /// The domain the method authenticated — `header.d` for DKIM,
    /// `smtp.mailfrom` (else `smtp.helo`) for SPF, `header.from` for DMARC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    /// Whether `identifier` shares a registrable domain with the visible `From`.
    /// `None` when the clause named no identity to compare.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aligned: Option<bool>,
}

/// Whether the topmost `Authentication-Results` header may be believed at all.
///
/// This is the whole security content of the feature. The header is ordinary
/// message text: anyone can write one. What makes the *topmost* one meaningful
/// is that a receiving MTA prepends its own, so the one at the top is the last
/// hop's — i.e. yours. That argument only holds if you know your own server's
/// `authserv-id` and check it, which is why a verdict is shown for nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailAuthState {
    /// The account names a trusted `authserv-id` and the topmost header carries it.
    Verified,
    /// A trusted id is configured and the topmost header does **not** carry it —
    /// so these results were written by someone else, quite possibly the sender.
    Foreign,
    /// No trusted id configured for the account: nothing here can be believed yet.
    Unconfigured,
}

/// What the receiving server concluded, and whether we may believe it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailAuthResults {
    pub state: MailAuthState,
    /// The topmost header's `authserv-id`, as written. `None` when the header
    /// was malformed or nameless — which can never match a configured id, so it
    /// can only ever land in `Foreign`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authserv_id: Option<String>,
    /// Every `method=result` clause of the **topmost** header only.
    pub methods: Vec<MailAuthMethod>,
    /// How many `Authentication-Results` headers the message carried. More than
    /// one is normal (each hop adds its own); only the topmost is ever read.
    pub header_count: u32,
}

// ── End-to-end encryption and signatures ────────────────────────────────────

/// Which of the two end-to-end formats a message uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailCryptoFormat {
    #[serde(rename = "openpgp")]
    OpenPgp,
    #[serde(rename = "smime")]
    Smime,
}

/// What the panel is allowed to say about a signature.
///
/// The vocabulary is deliberately `mail_authres`'s, because the misreading is
/// the same one: a verdict without the identity it applies to is the classic
/// error, so the states that separate "checked out" from "checked out *as the
/// person this claims to be from*" are distinct rather than folded together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailCryptoState {
    /// No signature to judge.
    None,
    /// Good signature, from a key the user verified out of band, whose identity
    /// matches the visible `From`.
    ///
    /// **The only state that earns positive chrome**, and it needs all three
    /// clauses. Drop the middle one and a padlock is granted to whoever last
    /// emailed you a key; drop the last and it is granted to anyone with *a*
    /// verified key, signing as anyone they like.
    Verified,
    /// Good signature from a verified key, but the signing identity is not the
    /// address the message claims to be from.
    Unaligned,
    /// Good signature from a key we merely happen to hold — attached to a
    /// message, fetched from a keyserver, imported without a fingerprint check.
    /// OpenPGP has no certificate authority, so there is nothing asserting that
    /// this key belongs to anyone; the UI shows a shrug, not a tick.
    Known,
    /// A signature was present and did **not** check out.
    Invalid,
    /// No key for the signer, so nothing could be checked either way. Kept apart
    /// from [`MailCryptoState::Invalid`] because "this is forged" and "I cannot
    /// tell" are different sentences.
    NoKey,
    /// Structurally broken, or an algorithm this build does not implement.
    Unusable,
    /// The format was recognized but this build does not handle it — today, all
    /// of S/MIME. Naming it is the point: a banner beats rendering the ASN.1
    /// blob as if it were the message.
    Unsupported,
}

/// The signature/encryption panel's wire shape, beside `MailAuthResults`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailCryptoInfo {
    pub format: MailCryptoFormat,
    /// The message arrived encrypted.
    pub encrypted: bool,
    /// …and was successfully decrypted for this render. `encrypted && !decrypted`
    /// is what a locked or unopenable message looks like.
    pub decrypted: bool,
    pub signed: bool,
    pub state: MailCryptoState,
    /// The signing identity — an address when the key carries one, else its
    /// fingerprint. Shown *beside* the verdict, never instead of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    /// Whether `identifier` is the same mailbox as the visible `From`. `None`
    /// when there was no identity to compare.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aligned: Option<bool>,
    /// Whether this build can do anything with the format beyond naming it.
    pub supported: bool,
    /// Machine tokens the frontend turns into sentences, so the wording lives in
    /// `i18n` ×5 rather than in Rust. Always includes `headers-not-signed` for a
    /// signed message — the thing users most reliably assume a tick covers, and
    /// which it never does in either format.
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailHeader {
    pub id: String,
    pub account_id: String,
    pub folder_id: String,
    pub uid: u32,
    /// The message's **RFC 5322 `Message-ID`**, as the sender wrote it.
    ///
    /// Distinct from `id`, which is Eldrun's own `{folder_id}-{uid}` store key.
    /// The store key is meaningless to any other mail system, so a reply that
    /// puts it in `In-Reply-To` fabricates a reference that threads nowhere —
    /// which is why this is carried separately rather than derived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rfc_message_id: Option<String>,
    pub subject: String,
    pub from: MailAddress,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    /// RFC 3339.
    pub date: String,
    pub seen: bool,
    pub flagged: bool,
    pub answered: bool,
    pub has_attachments: bool,
    pub size: u64,
    /// Short plain-text snippet, already stripped of markup by the backend.
    pub preview: String,
    /// Non-empty when the headers are malformed in a way the user must see
    /// (e.g. `DUPLICATE_FROM`). The UI shows a warning strip; it never silently
    /// picks one value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub malformed_headers: Option<Vec<String>>,
    /// SPF/DKIM/DMARC as the receiving server reported them, with the trust
    /// state attached. `None` when the message carried no `Authentication-
    /// Results` header at all — which is not a failure, just an absence, and
    /// the UI says so rather than implying anything about the sender.
    ///
    /// The `state` field is recomputed **on every read** against the account's
    /// current `authserv_id`, never persisted, so configuring (or clearing) the
    /// trusted id takes effect on already-synced mail without a re-sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<MailAuthResults>,
    /// The user's local **priority mark** — Important or Urgent — or `None`.
    ///
    /// Local only, and deliberately so; see [`MailPriority`]. It is carried on
    /// the header rather than looked up separately because every surface that
    /// shows a message wants it: the row badge, the context menu's current
    /// state, and the cross-account list itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<MailPriority>,
    /// **Who** set [`Self::priority`] — the user by hand, a keyword filter rule,
    /// or the local model (#205). Sealed at rest; recomputed onto the header on
    /// every read from its own column. `None` when there is no mark, or when the
    /// column predates this feature.
    ///
    /// It exists so the model classifier can never masquerade as a keyword
    /// filter, which `docs/context/mail_encryption.md` makes a hard requirement:
    /// the UI says *"marked Urgent by the local model: '…'"* only because this
    /// field distinguishes it from the filter's *"rule Billing"*.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority_source: Option<MailPrioritySource>,
    /// The one-line reason behind [`Self::priority`] — a filter's rule name, or
    /// the model's own sentence. Sealed at rest (a model's reason quotes the
    /// message, which says as much as the subject). `None`/empty when there is no
    /// mark or the mark carries no stated reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority_reason: Option<String>,
}

/// **Who** applied a message's priority mark. The provenance that keeps the
/// model classifier from being mistaken for a keyword filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailPrioritySource {
    /// The user marked it by hand (the right-click menu / `mail_priority_set`).
    User,
    /// A keyword filter rule marked it (`services::mail_filters`).
    Filter,
    /// The local model marked it (`services::mail_ai`, #205).
    Model,
}

impl MailPrioritySource {
    /// The literal stored in the `priority_source` column — fixed per variant,
    /// never anything caller-supplied.
    pub fn as_str(self) -> &'static str {
        match self {
            MailPrioritySource::User => "user",
            MailPrioritySource::Filter => "filter",
            MailPrioritySource::Model => "model",
        }
    }

    /// Read one back. An unrecognized value reads as `None` (no provenance) for
    /// the same reason [`MailPriority::parse`] does: a wrong guess would be worse
    /// than an honest blank.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "user" => Some(MailPrioritySource::User),
            "filter" => Some(MailPrioritySource::Filter),
            "model" => Some(MailPrioritySource::Model),
            _ => None,
        }
    }
}

/// A message's local priority mark: **Important** or **Urgent**.
///
/// **This is a mark, not a move, and not an IMAP flag.** The message stays in
/// the folder and the account it arrived in; nothing is uploaded, copied or
/// deleted, and no socket opens. That is forced by what the feature is for: the
/// Important and Urgent lists span *every* account, and no IMAP folder can hold
/// mail from two accounts — the moment the list is cross-account, the only thing
/// that can implement it is a local column. Making it a real move would mean N
/// per-account folders, N network round trips per mark, new UIDs (so every
/// cached body, attachment and store key would be invalidated), and a failure
/// mode where half the marks landed.
///
/// It is also not `\Flagged`. The star already means something to the user and
/// round-trips to the server; overloading it would make "important" and
/// "starred" the same bit in two places with different names.
///
/// The consequence to be honest about: a mark is **this machine's**. It is not
/// visible in another mail client, and a mailbox re-synced onto a second Eldrun
/// install starts unmarked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailPriority {
    Important,
    Urgent,
}

impl MailPriority {
    /// The value stored in the `priority` column. A fixed literal per variant,
    /// never anything caller-supplied.
    pub fn as_str(self) -> &'static str {
        match self {
            MailPriority::Important => "important",
            MailPriority::Urgent => "urgent",
        }
    }

    /// Read one back out of a row. An unrecognized value — a column written by a
    /// future version, or corrupted — reads as **no mark** rather than as a
    /// guess: an unmarked message shown as unmarked is right, and a wrong guess
    /// would put mail on a list the user never put it on.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "important" => Some(MailPriority::Important),
            "urgent" => Some(MailPriority::Urgent),
            _ => None,
        }
    }
}

/// How much mail carries each mark, across every account. Drives the two rail
/// badges, which is why it is one read and not two.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct MailPriorityCounts {
    pub important: u32,
    pub urgent: u32,
    /// Of those, how many are unread. The badge counts *everything* marked —
    /// a list you file mail into is not an inbox and does not empty itself as
    /// you read — but the unread half is what the rail tones.
    pub important_unread: u32,
    pub urgent_unread: u32,
}

// ── Filter rules (keyword → priority mark) ──────────────────────────────────

/// Schema version of `filters.json`.
pub const FILTERS_VERSION: u32 = 1;

/// Which part of a message a rule's terms are searched in.
///
/// A closed set rather than a column name, for [`MailSort`]'s reason: these
/// reach a matcher that indexes into a `MailHeader`, and an open string would
/// mean a rule could name a field that does not exist and silently match
/// nothing. An unrecognized value from a newer build fails to deserialize the
/// *rule*, which the reader drops — a rule that cannot be understood must not be
/// half-applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailFilterField {
    Subject,
    /// The `From` — **both** the addr-spec and the display name, because a rule
    /// written as "the newsletter from Acme" is nearly always aimed at the name
    /// and one written as `@acme.example` at the address.
    Sender,
    /// `To` + `Cc`, names and addresses. This is what catches "mail sent to the
    /// alias I actually care about" without a server-side rule.
    Recipients,
    /// The stored body **snippet**, not the body.
    ///
    /// The honest limit, stated here because the UI has to repeat it: a sync
    /// stores a short plain-text preview per message and nothing else — the full
    /// body is fetched only when a message is opened. Searching bodies at sync
    /// time would mean downloading every message of every folder on every check.
    /// So a term matched here is matched against the first part of the message,
    /// and a word buried on page three does not fire the rule.
    Preview,
}

impl MailFilterField {
    pub fn as_str(self) -> &'static str {
        match self {
            MailFilterField::Subject => "subject",
            MailFilterField::Sender => "sender",
            MailFilterField::Recipients => "recipients",
            MailFilterField::Preview => "preview",
        }
    }
}

/// One user-written rule: *when any of these words appears in these parts of a
/// new message, mark it Important or Urgent.*
///
/// **A mark, not a move** — everything [`MailPriority`] says applies unchanged,
/// because that is literally what a rule does: it sets the same local column the
/// right-click menu sets. Nothing is uploaded, no IMAP flag is written, no
/// message leaves the folder it arrived in. The rule is this machine's, exactly
/// as the mark is.
///
/// This is the **manual** half of the feature deliberately: the terms are the
/// user's own words, matched literally, so *why* a message ended up in the alert
/// list is answerable by reading the rule. A model-driven classifier is a
/// separate, later thing and must not be able to masquerade as this one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailFilterRule {
    /// Minted by the backend when the frontend sends an empty one, exactly as an
    /// account's is: the store owns identity.
    #[serde(default)]
    pub id: String,
    /// The user's label for the rule. Purely cosmetic — it is what the report
    /// and the message row name, so a rule can be recognized without re-reading
    /// its terms.
    #[serde(default)]
    pub name: String,
    /// The words (or phrases) to look for. Matched **case-insensitively** and,
    /// unless [`whole_word`](Self::whole_word) is set, as substrings.
    ///
    /// An **empty list never matches**. That is the one degenerate case worth
    /// naming: a rule with no terms searched with `any` semantics would match
    /// every message ever synced and bury the alert list in one tick.
    #[serde(default)]
    pub terms: Vec<String>,
    /// Where to look. **Empty never matches**, for the same reason: a rule that
    /// searches nowhere must not quietly mean "everywhere".
    #[serde(default)]
    pub fields: Vec<MailFilterField>,
    /// Which list a hit lands in.
    pub mark: MailPriority,
    /// Require **every** term rather than any one of them. Off by default — the
    /// mental model of "tags to watch for" is a list of alternatives.
    #[serde(default)]
    pub match_all: bool,
    /// Match only on word boundaries, so `art` stops matching *start*. Off by
    /// default, because the common case is a fragment (`invoice`, `@acme.`) and
    /// a boundary rule would refuse the second of those.
    #[serde(default)]
    pub whole_word: bool,
    /// Restrict the rule to one account. `None` = every account, which is the
    /// default and matches what the Important/Urgent lists themselves are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Off means "keep the rule but stop applying it" — the thing a user reaches
    /// for when a rule is too noisy, and the alternative to deleting the words
    /// they spent time writing.
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(flatten, default)]
    pub extra: HashMap<String, Value>,
}

fn default_true() -> bool {
    true
}

/// `filters.json` — the whole rule list, **in order**.
///
/// The order is load-bearing: the first matching rule wins, so a specific
/// "urgent" rule placed above a broad "important" one behaves the way reading
/// the list top-down suggests. That is also why the save command is wholesale
/// rather than per-rule (`commands::calendar`'s `todo_columns_set` bargain): a
/// reorder is an ordinary edit here, and it is not expressible as an upsert.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MailFilters {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub rules: Vec<MailFilterRule>,
    #[serde(flatten, default)]
    pub extra: HashMap<String, Value>,
}

/// Why one message matched: which rule, which of its words, and where it was
/// found. Carried so the UI can say *"‘invoice’ in the subject — rule Billing"*
/// rather than an unexplained mark, which is the difference between a filter the
/// user can debug and one they end up switching off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MailFilterHit {
    pub rule_id: String,
    pub rule_name: String,
    pub mark: MailPriority,
    pub term: String,
    pub field: MailFilterField,
}

/// One matched message, for the "what would this catch?" preview.
#[derive(Debug, Clone, Serialize)]
pub struct MailFilterSample {
    pub message_id: String,
    pub subject: String,
    pub from: MailAddress,
    pub date: String,
    pub hit: MailFilterHit,
}

/// The outcome of running the rules over mail that is already in the local
/// index.
///
/// `marked` is separate from `matched` because a dry run matches without marking
/// — the same report shape answers "what would this do" and "what did it do",
/// and a preview that reported a mark count it never wrote would be the worst
/// possible confusion in a feature about automatic filing.
#[derive(Debug, Clone, Default, Serialize)]
pub struct MailFilterReport {
    /// Messages examined. Bounded — see `MailStore::unmarked_headers`.
    pub scanned: u32,
    pub matched: u32,
    /// Always 0 when `dry_run`.
    pub marked: u32,
    pub dry_run: bool,
    /// Set when the scan bound was hit, so "12 matches" can be qualified with
    /// *of the most recent N messages* rather than read as the whole mailbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capped: Option<u32>,
    /// A capped list of what matched, newest first.
    #[serde(default)]
    pub samples: Vec<MailFilterSample>,
}

// ── Local-model extraction (Group Q, #205/#207/#208) ────────────────────────

/// A calendar event the local model read out of a message (#207).
///
/// The wire contract's `MailExtractedEvent`. Field-for-field the TS interface:
/// `start` is an ISO-8601 **local** wall-clock string (`2026-08-04T15:00`), and
/// `confidence` is `0..1`. The command returns `null` (not this) when the model
/// gave nothing usable, so every field here is one a caller may trust to be set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MailExtractedEvent {
    pub title: String,
    /// ISO-8601 local, e.g. `2026-08-04T15:00`.
    pub start: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    pub all_day: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// `0.0..=1.0`. Below the command's floor the extraction is discarded.
    pub confidence: f64,
}

/// A to-do card the local model read out of a message (#208). The wire
/// contract's `MailExtractedTask`; `priority` matches the board's vocabulary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MailExtractedTask {
    pub title: String,
    /// ISO date, e.g. `2026-08-04`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

/// The manual "what would the local model file?" report (#205).
///
/// Deliberately a **different shape** from [`MailFilterReport`]: it carries a
/// fixed `source: "model"` tag and its matches name the model's own reason, so a
/// UI can never render a model verdict as though a keyword rule produced it.
#[derive(Debug, Clone, Serialize)]
pub struct MailAiClassifyReport {
    /// Always `"model"`. The tag that makes this visibly distinct from the
    /// filter report; set once, here, and nowhere caller-controlled.
    pub source: String,
    pub scanned: u32,
    pub matched: Vec<MailAiClassifyMatch>,
    pub dry_run: bool,
}

impl MailAiClassifyReport {
    /// A fresh report with the fixed `"model"` source tag.
    pub fn new(dry_run: bool) -> Self {
        MailAiClassifyReport {
            source: "model".to_string(),
            scanned: 0,
            matched: Vec::new(),
            dry_run,
        }
    }
}

/// One message the local model would file, and why.
#[derive(Debug, Clone, Serialize)]
pub struct MailAiClassifyMatch {
    pub message_id: String,
    /// `"important"` or `"urgent"` — [`MailPriority::as_str`].
    pub priority: String,
    /// The model's one-line reason.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MailHeaderPage {
    pub items: Vec<MailHeader>,
    pub total: u32,
    /// How many messages a search actually looked at, set **only** when it
    /// stopped early.
    ///
    /// A search over an encrypted store cannot use `LIKE` — there is nothing to
    /// match against but ciphertext — so it opens rows one by one and stops at a
    /// bound (`MailStore::MAX_SEARCH_SCAN`). When that happens `total` is
    /// "matches among the ones I looked at", which is a different claim from the
    /// one the pager normally makes, and the difference has to be visible: the
    /// UI says *"searched the most recent N messages"*. `None` means the whole
    /// scope was covered and `total` means what it always did.
    ///
    /// A blind index would have avoided the bound and was rejected for it — a
    /// deterministic per-token fingerprint leaks word frequency and answers
    /// "does this mailbox contain word X", which is most of what the encryption
    /// was for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scanned: Option<u32>,
}

/// What the header list is ordered by.
///
/// It is an **enum, not a column name**, and that is the whole point: the sort
/// reaches SQLite as an `ORDER BY` clause, which cannot be a bound parameter —
/// so the only safe shape is a closed set the store matches into fixed literals
/// (`MailStore::order_clause`). A `String` here would be an injection with extra
/// steps, however carefully the frontend spelled it.
///
/// Sorting is the **store's** job rather than the list component's because the
/// list is paged: ordering the 100 rows that happen to be on screen would sort a
/// page, not a folder, and the largest message in a mailbox is almost never on
/// the first page of the newest ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailSort {
    /// Newest first — the default, and what every mail client opens on.
    #[default]
    Date,
    /// Starred (flagged) mail first.
    Flagged,
    /// Mail carrying attachments first.
    Attachments,
    /// Biggest first — the "what is filling my quota" question.
    Size,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailAttachmentMeta {
    pub part_id: String,
    /// Already run through `mail_sanitize::sanitize_attachment_name`.
    pub filename: String,
    pub mime: String,
    pub size: u64,
    pub inline: bool,
    /// Set when the declared MIME type disagrees with the sniffed bytes or the
    /// extension (plan B §3.5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_mismatch: Option<String>,
}

/// One link found in the sanitized body. The sanitizer strips every `href` and
/// replaces it with `data-lid`, so the rendered document cannot navigate
/// anywhere; opening a link is a frontend decision made against this table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailLink {
    pub lid: u32,
    /// The real target, punycode-decoded for display.
    pub href: String,
    /// Host as shown to the user, after IDNA normalization.
    pub display_host: String,
    /// True when the anchor's visible text claims a different host than `href`.
    pub mismatch: bool,
    /// Set for anything that is not http/https/mailto — such links must not
    /// offer "Open".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheme_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailBody {
    pub id: String,
    /// Sanitized in Rust before it ever reaches the webview.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// How many remote references were blocked. Drives the "Load images" banner.
    pub remote_refs: u32,
    pub links: Vec<MailLink>,
    pub attachments: Vec<MailAttachmentMeta>,
    /// Set when the body hit a size/element cap and was truncated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    /// End-to-end signature/encryption, when the message carried any. Absent
    /// for ordinary mail — the panel renders nothing rather than a reassuring
    /// "not encrypted" row on every message in the mailbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crypto: Option<MailCryptoInfo>,
}

// ── Compose ─────────────────────────────────────────────────────────────────

/// A file the user explicitly picked, already copied inside the mail sandbox
/// directory. The draft references `staged_id`s only — never a path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedAttachment {
    pub staged_id: String,
    pub filename: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MailDraft {
    pub id: String,
    pub account_id: String,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub body_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<String>>,
    #[serde(default)]
    pub staged: Vec<StagedAttachment>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MailSendResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailFlag {
    Seen,
    Flagged,
    Answered,
    Deleted,
}

impl MailFlag {
    /// The IMAP system flag this maps to.
    pub fn imap_flag(self) -> &'static str {
        match self {
            MailFlag::Seen => "\\Seen",
            MailFlag::Flagged => "\\Flagged",
            MailFlag::Answered => "\\Answered",
            MailFlag::Deleted => "\\Deleted",
        }
    }

    /// The `messages` column this maps to. A fixed `&'static str` per variant,
    /// so the SQL never interpolates anything caller-controlled.
    pub fn column(self) -> &'static str {
        match self {
            MailFlag::Seen => "seen",
            MailFlag::Flagged => "flagged",
            MailFlag::Answered => "answered",
            MailFlag::Deleted => "deleted",
        }
    }
}

// ── Sync ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Default)]
pub struct MailSyncSummary {
    pub account_id: String,
    pub folders: u32,
    pub new_messages: u32,
    /// Of those, how many a filter rule filed into Important/Urgent. Reported
    /// because a mark the user did not make has to be visible *as it happens* —
    /// mail quietly moving itself is exactly the behaviour that makes people
    /// distrust a filter, and "2 new, 1 marked urgent" is the sentence that
    /// keeps it explainable.
    #[serde(default)]
    pub filtered: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Payload of the `mail:sync` event.
#[derive(Debug, Clone, Serialize)]
pub struct MailSyncEvent {
    pub account_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    /// `start` | `folder` | `headers` | `done` | `error`.
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_messages: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Payload of the `mail:new` event (inbox only).
#[derive(Debug, Clone, Serialize)]
pub struct MailNewEvent {
    pub account_id: String,
    pub folder_id: String,
    pub count: u32,
}

/// Bounded bytes for in-pane preview. Never written to disk by the previewer.
#[derive(Debug, Clone, Serialize)]
pub struct MailPreviewBlob {
    pub mime: String,
    pub bytes_b64: String,
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire contract is snake_case and the enums are lowercase strings.
    /// A rename here silently breaks `src/types/mail.ts`, which is frozen.
    #[test]
    fn enums_serialize_as_the_frozen_lowercase_strings() {
        assert_eq!(
            serde_json::to_string(&MailSecurity::Tls).unwrap(),
            "\"tls\""
        );
        assert_eq!(
            serde_json::to_string(&MailSecurity::Starttls).unwrap(),
            "\"starttls\""
        );
        assert_eq!(
            serde_json::to_string(&MailAuthKind::Oauth2).unwrap(),
            "\"oauth2\""
        );
        assert_eq!(
            serde_json::to_string(&MailFolderKind::Inbox).unwrap(),
            "\"inbox\""
        );
        assert_eq!(serde_json::to_string(&MailFlag::Seen).unwrap(), "\"seen\"");
        assert_eq!(
            serde_json::to_string(&MailKeyringState::Available).unwrap(),
            "\"available\""
        );
    }

    #[test]
    fn an_account_carries_no_secret_field() {
        let acct = MailAccount {
            id: "a1".into(),
            label: "Personal".into(),
            address: "user@example.com".into(),
            imap: MailServer {
                host: "imap.example.com".into(),
                port: 993,
                user: "user@example.com".into(),
                security: MailSecurity::Tls,
            },
            smtp: MailServer {
                host: "smtp.example.com".into(),
                port: 465,
                user: "user@example.com".into(),
                security: MailSecurity::Tls,
            },
            ..Default::default()
        };
        let raw = serde_json::to_string(&acct).unwrap();
        // Field *names* that would mean a secret is on disk. `save_password`
        // and `auth: "password"` are a flag and a mechanism, not a credential.
        for banned in [
            "\"password\":",
            "\"secret\":",
            "\"token\":",
            "\"passphrase\":",
            "\"refresh_token\":",
        ] {
            assert!(
                !raw.contains(banned),
                "accounts.json must carry no secret field, found {banned} in {raw}"
            );
        }
        assert!(
            raw.contains("\"save_password\":false"),
            "opt-in defaults off"
        );
    }

    /// A field a newer build wrote must survive an older build reading and
    /// rewriting the file — that is the whole job of the `extra` catch-all.
    #[test]
    fn unknown_fields_round_trip_through_extra() {
        let raw = r#"{"version":1,"accounts":[{"id":"a","label":"L","address":"a@example.com",
            "imap":{"host":"h","port":993,"user":"u"},"smtp":{"host":"h","port":465,"user":"u"},
            "future_knob":42}],"future_top":"x"}"#;
        let parsed: MailAccounts = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_string(&parsed).unwrap();
        assert!(out.contains("future_knob"), "{out}");
        assert!(out.contains("future_top"), "{out}");
    }

    #[test]
    fn optional_fields_are_omitted_rather_than_null() {
        let acct = MailAccount::default();
        let raw = serde_json::to_string(&acct).unwrap();
        assert!(!raw.contains("display_name"), "{raw}");
        assert!(!raw.contains("signature"), "{raw}");
        assert!(!raw.contains("check_interval_min"), "{raw}");
    }
}

#[cfg(test)]
mod authserv_roundtrip_tests {
    use super::*;

    /// `authserv_id` is the input to a trust decision, and it sits beside a
    /// `#[serde(flatten)]` catch-all — the classic place for a field to be
    /// swallowed and silently become `None`, which reads as "not configured"
    /// and shows no verdict at all. Found missing from `accounts.json` in live
    /// QA, so both directions are pinned here.
    #[test]
    fn authserv_id_survives_a_json_round_trip() {
        let mut account = MailAccount {
            id: "a1".into(),
            authserv_id: Some("mx.google.com".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&account).unwrap();
        assert!(json.contains("authserv_id"), "not serialized: {json}");
        let back: MailAccount = serde_json::from_str(&json).unwrap();
        assert_eq!(back.authserv_id.as_deref(), Some("mx.google.com"));
        assert!(
            !back.extra.contains_key("authserv_id"),
            "swallowed by the catch-all"
        );

        // And the value the frontend actually sends: a camelCase-free object
        // with the field present among unknown extras.
        let wire = r#"{"id":"a1","label":"","address":"","imap":{"host":"","port":993,"user":"","security":"tls"},"smtp":{"host":"","port":465,"user":"","security":"tls"},"auth":"password","save_password":false,"authserv_id":"mx.google.com","somethingNew":1}"#;
        let parsed: MailAccount = serde_json::from_str(wire).unwrap();
        assert_eq!(parsed.authserv_id.as_deref(), Some("mx.google.com"));
        assert!(parsed.extra.contains_key("somethingNew"));

        // Clearing it must round-trip as absent, not as an empty string.
        account.authserv_id = None;
        let json = serde_json::to_string(&account).unwrap();
        assert!(!json.contains("authserv_id"), "{json}");
    }
}
