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
//!    `commands::mail::mail_account`).
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct MailAccount {
    pub id: String,
    pub label: String,
    pub address: String,
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
}

#[derive(Debug, Clone, Serialize)]
pub struct MailHeaderPage {
    pub items: Vec<MailHeader>,
    pub total: u32,
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
        assert_eq!(serde_json::to_string(&MailSecurity::Tls).unwrap(), "\"tls\"");
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
        assert!(raw.contains("\"save_password\":false"), "opt-in defaults off");
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
