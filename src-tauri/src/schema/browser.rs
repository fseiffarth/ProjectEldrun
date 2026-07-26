//! Serde structs for the in-app browser (TODO group J #61).
//!
//! Same convention as `schema::mail`: snake_case field names, `rename_all =
//! "lowercase"` on the small closed enums, and every type here serializes to
//! exactly the shape the frontend's typed wrappers declare.
//!
//! **What is deliberately absent from every type in this file: a path.** No
//! command in `commands::browser` accepts one and no result carries one. A
//! download reports the *display name* it was saved under and nothing else —
//! where it went is the OS save dialog's business, and telling the frontend
//! would make the next feature request "let the page pick it".

use serde::{Deserialize, Serialize};

/// What the transport is actually doing, as a word rather than an icon. Users
/// do not read padlocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TlsState {
    /// https, certificate validated against the OS trust store.
    Secure,
    /// Plain http. There is no third "mixed" state in v1 because we have no API
    /// to observe passive mixed content (see `browser_engine`'s gap notes).
    Insecure,
    /// Not determined — a live window before its first load completes, or a
    /// scheme with no transport (`about:blank`).
    #[default]
    Unknown,
}

/// The security readout the chrome renders beside the address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecurityState {
    pub tls: TlsState,
    pub scheme: String,
    /// The host in its **Unicode** form, for display.
    pub host_display: String,
    /// The ASCII/punycode host, present only when it differs from
    /// `host_display`. The chrome must render **both** — the Unicode form alone
    /// is the homograph attack and the ASCII form alone is unreadable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub punycode_warning: Option<String>,
    /// Whether an OpenVPN tunnel Eldrun knows about is up. Browser traffic goes
    /// through it exactly like every other process on the machine; this is here
    /// so that is *visible* rather than surprising.
    pub vpn_active: bool,
}

impl Default for SecurityState {
    fn default() -> Self {
        Self {
            tls: TlsState::Unknown,
            scheme: String::new(),
            host_display: String::new(),
            punycode_warning: None,
            vpn_active: false,
        }
    }
}

/// The result of the pure navigation-policy check.
///
/// Note the three-into-two mapping, because it is the one place this type is
/// subtler than it looks. The gate has **three** outcomes (allow / confirm /
/// block) and this struct has two fields:
///
/// | gate      | `allowed` | `reason`       |
/// |-----------|-----------|----------------|
/// | Allow     | `true`    | `None`         |
/// | Confirm   | `true`    | `Some(token)`  |
/// | Block     | `false`   | `Some(token)`  |
///
/// So `allowed && reason.is_some()` means *"reachable, but this is a loopback
/// or private-network address and the user should be told before you open
/// it"*. `reason` is a stable machine token (`loopback`, `private-network`,
/// `link-local`, `internal-name`, `app-origin`, `scheme:file`, `downgrade`,
/// `redirect-loop`, `unparsable`, `about-internal`, `no-host`) — the wording
/// lives in the frontend's i18n, never here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UrlVerdict {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The URL as it should be shown: userinfo removed, host in Unicode form,
    /// format controls stripped. **Never truncated** — eliding
    /// `https://example.com.evil.tld/…` to `https://example.com…` is the attack.
    pub display_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub punycode_warning: Option<String>,
    pub scheme: String,
    pub is_loopback: bool,
}

/// One fetched-and-sanitized page. `html` is a **fragment** with no `href`, no
/// remote-loading attribute and no script anywhere — the frontend renders it in
/// an `<iframe sandbox="" srcdoc>` with its own `default-src 'none'` CSP, which
/// is a third layer nothing here relies on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReaderPage {
    pub requested_url: String,
    /// Where the redirect chain actually ended. Not the same string as
    /// `requested_url` whenever a hop happened, and the difference is the whole
    /// point of reporting it.
    pub final_url: String,
    pub display_url: String,
    pub title: String,
    pub html: String,
    pub security: SecurityState,
    /// The body hit the element budget and was cut.
    pub truncated: bool,
    /// How many remote references the sanitizer dropped, for the "Eldrun
    /// blocked n remote images" banner.
    pub blocked_remote_assets: u32,
}

/// A live-page window. The label is opaque to the frontend and is the only
/// handle it ever gets — there is no window id, no native handle, no path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveWindowRef {
    pub label: String,
    pub display_url: String,
}

/// `browser:live-state` — pushed whenever a live window loads, retitles, or
/// finishes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveWindowState {
    pub label: String,
    pub display_url: String,
    /// Already stripped of bidi/format controls. A tab titled
    /// `example.com — Secure  \u{2069}` is a real technique.
    pub title: String,
    pub security: SecurityState,
    pub loading: bool,
}

/// `browser:live-closed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveWindowClosed {
    pub label: String,
}

/// `browser:blocked` — a navigation the gate refused. A page state, not an
/// interrupt: the frontend renders an in-app error page, never a native modal.
///
/// `window_label` is what makes the event *attributable*. Every emitter of this
/// event today is a **live-page window** (its `on_navigation` gate, and its
/// download handler refusing an oversized transfer), which has nothing to do
/// with any reader tab — so without the label the frontend's only option was to
/// guess "the tab that most recently asked for a load", and that guess is wrong
/// in exactly the common case: a live window blocked mid-browse would wipe the
/// page an unrelated reader tab was showing. The reader's own refusals never
/// come through this event at all; they are the return value of
/// `browser_check_url`, which the caller already holds.
///
/// It stays `Option` rather than being made mandatory so a future emitter that
/// genuinely has no window (a background policy pass) can say so instead of
/// inventing a label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockedNavigation {
    pub display_url: String,
    pub reason: String,
    /// The `browser-*` label of the live window this happened in, when it
    /// happened in one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_label: Option<String>,
}

/// `browser:download-requested` — bytes are in quarantine and nothing has
/// reached the user's filesystem. `file_name` is a **display name**, already
/// through `web_safety::sanitize_attachment_name`; it is not where anything is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadRequest {
    pub download_id: String,
    pub file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// The bytes are not what the name claims — either the sniffed type
    /// disagrees with the extension, or the content sniffs as an executable
    /// regardless of what it is called. A program download is **labelled, not
    /// refused**: people download installers, and a browser that cannot is
    /// broken.
    pub sniff_mismatch: bool,
}

/// What `browser_download_decide` did. Carries a name for the toast and
/// **never a path** — see the module note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct DownloadOutcome {
    pub saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
}

/// How the frontend learns what this platform will actually do, instead of
/// discovering it from a failed command. Same posture as the Docker sandbox on
/// Windows: refuse clearly rather than silently do something weaker than the
/// user was promised.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserCapabilities {
    pub live_windows_supported: bool,
    pub reader_supported: bool,
    /// A stable token naming *why*, when something is off. The wording lives in
    /// the frontend's i18n.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform_note: Option<String>,
}
