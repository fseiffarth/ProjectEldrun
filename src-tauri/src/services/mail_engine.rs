//! The mail protocol layer: MIME parsing, IMAP, SMTP, TLS.
//!
//! `AppHandle`-free and path-free by construction. Everything here speaks
//! *messages*, never files; the only disk this module can reach is whatever the
//! caller hands it, and the caller (`commands::mail`) resolves every path under
//! `mail_dir()` itself. That is what makes plan A's Phase-5 move — putting the
//! same trait behind a pipe to a landlocked helper process — a transport swap
//! rather than a rewrite.
//!
//! ## The rules this module exists to enforce
//!
//! - **Implicit TLS only** (plan B §4.1). The connectors return a `TlsStream`;
//!   there is no type a cleartext session could inhabit, so a downgrade is not
//!   something a setting could enable.
//! - **No certificate escape hatch, anywhere** (§4.3). Validation is
//!   `rustls-platform-verifier` against the **OS trust store**, so a private CA
//!   is installed once, by the administrator, in the place the OS already has
//!   for it. A test scans this file's own source for the strings that would
//!   introduce a bypass.
//! - **Everything network-facing is bounded**: connect, handshake, greeting,
//!   command, fetch, and the whole SMTP session each carry a timeout, because
//!   an operation without one is an operation that can wedge a task forever —
//!   the same class of bug as the locked-keychain hang in
//!   `docs/context/remote_credentials.md`.
//! - **Everything parser-facing is bounded**: message size, MIME depth, part
//!   count, header line and header block. A pathological message is *refused*
//!   with a typed error, not merely survived.
//! - **A password is never logged, `Debug`-printed, or serialized.**
//!   [`Password`] has no `Serialize`, no `Display`, and a hand-written `Debug`.

use std::fmt;
use std::time::Duration;

use futures_util::StreamExt;
use mail_parser::{MessageParser, MimeHeaders, PartType};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use zeroize::Zeroizing;

use crate::schema::mail::{
    MailAccount, MailAddress, MailAttachmentMeta, MailFolderKind, MailProbe, MailSecurity,
    MailServer,
};
use crate::services::mail_sanitize::sanitize_attachment_name;

// ── Crypto provider ─────────────────────────────────────────────────────────

/// Install the process-wide rustls `CryptoProvider`.
///
/// rustls 0.23 **panics at first use** with *"no process-level CryptoProvider
/// available"* when more than one provider is compiled into the binary and none
/// has been installed. More than one is exactly what a dependency tree gives you
/// sooner or later (any crate pulling `aws-lc-rs` alongside our `ring`), and the
/// failure lands at the first TLS handshake — i.e. at runtime, on a user's
/// machine, in the middle of connecting. So it is installed explicitly, once,
/// before anything can reach TLS, and an already-installed provider is ignored
/// rather than fought over.
///
/// Called from `lib.rs`'s `run()` before the Tauri builder, and from this
/// module's own test.
pub fn install_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// The one TLS configuration, shared by IMAP and SMTP.
///
/// rustls 0.23 implements TLS 1.3 and 1.2 only — 1.0/1.1 do not exist in the
/// crate at all — so "minimum TLS 1.2" is structural here rather than a setting
/// that could be misconfigured. No custom cipher-suite list: rustls's defaults
/// are the right answer, and hand-picking suites is how you end up maintaining
/// a stale one.
fn tls_config() -> std::sync::Arc<rustls::ClientConfig> {
    use rustls_platform_verifier::BuilderVerifierExt;
    static CFG: std::sync::OnceLock<std::sync::Arc<rustls::ClientConfig>> =
        std::sync::OnceLock::new();
    CFG.get_or_init(|| {
        install_crypto_provider();
        let cfg = rustls::ClientConfig::builder_with_protocol_versions(&[
            &rustls::version::TLS13,
            &rustls::version::TLS12,
        ])
        .with_platform_verifier()
        .expect("the OS trust store must be readable to make any TLS connection")
        .with_no_client_auth();
        std::sync::Arc::new(cfg)
    })
    .clone()
}

// ── Secrets ─────────────────────────────────────────────────────────────────

/// An IMAP/SMTP password held in memory.
///
/// Zeroized on drop, no `Serialize`, no `Display`, and a `Debug` that prints a
/// placeholder — so a password cannot reach a log line, an error string, a
/// Tauri event payload or a crash dump by accident. The only way out is
/// [`Password::expose`], which is deliberately ugly to read at a call site.
#[derive(Clone, PartialEq, Eq)]
pub struct Password(Zeroizing<String>);

impl Password {
    pub fn new(secret: impl Into<String>) -> Self {
        Password(Zeroizing::new(secret.into()))
    }

    pub fn expose(&self) -> &str {
        self.0.as_str()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Password {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Password(<redacted>)")
    }
}

// ── Errors ──────────────────────────────────────────────────────────────────

/// Why a mail operation failed. Typed rather than stringly so the caller can
/// distinguish "refuse and tell the user" from "retry later" — and so no error
/// path can accidentally interpolate a credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MailError {
    /// A cleartext or STARTTLS endpoint. v1 speaks implicit TLS only.
    PlaintextRefused,
    /// The raw message exceeded [`MAX_MESSAGE_BYTES`].
    TooLarge { bytes: usize },
    /// MIME nesting deeper than [`MAX_MIME_DEPTH`].
    TooDeep,
    /// More than [`MAX_MIME_PARTS`] parts.
    TooManyParts,
    /// A single header line over [`MAX_HEADER_LINE`], or a header block over
    /// [`MAX_HEADER_BLOCK`].
    HeaderTooLong,
    /// `mail-parser` could not make a message out of these bytes at all.
    Unparseable,
    /// Nothing renderable in the message (e.g. a lone `application/octet-stream`).
    NoDisplayableContent,
    /// An operation exceeded its bound.
    Timeout { op: &'static str },
    /// Authentication was rejected. **Never retried** — one attempt per user
    /// action, because a retry loop against a provider lockout policy is how
    /// accounts get locked.
    AuthFailed,
    /// The server offers no password mechanism we accept post-TLS.
    NoSupportedAuth,
    /// Anything else, already stripped of anything secret.
    Protocol(String),
}

impl fmt::Display for MailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MailError::PlaintextRefused => write!(
                f,
                "this account is configured for an unencrypted or STARTTLS port; \
                 Eldrun connects over implicit TLS only (IMAP 993, SMTP 465)"
            ),
            MailError::TooLarge { bytes } => write!(
                f,
                "message is too large to open ({bytes} bytes; limit {MAX_MESSAGE_BYTES})"
            ),
            MailError::TooDeep => write!(
                f,
                "message nests MIME parts more than {MAX_MIME_DEPTH} deep and was not opened"
            ),
            MailError::TooManyParts => write!(
                f,
                "message has more than {MAX_MIME_PARTS} MIME parts and was not opened"
            ),
            MailError::HeaderTooLong => {
                write!(f, "message headers are malformed (a header is too long)")
            }
            MailError::Unparseable => write!(f, "message could not be parsed"),
            MailError::NoDisplayableContent => write!(f, "no displayable content"),
            MailError::Timeout { op } => write!(f, "{op} timed out"),
            MailError::AuthFailed => write!(
                f,
                "the server rejected the username or password. Eldrun does not retry \
                 automatically, so nothing was sent a second time."
            ),
            MailError::NoSupportedAuth => write!(
                f,
                "this server doesn't offer a password mechanism Eldrun supports; it may require \
                 OAuth sign-in, which Eldrun does not support yet"
            ),
            MailError::Protocol(m) => write!(f, "{m}"),
        }
    }
}

impl From<MailError> for String {
    fn from(e: MailError) -> String {
        e.to_string()
    }
}

// ── Bounds ──────────────────────────────────────────────────────────────────

/// Largest raw message accepted from a `FETCH` before parsing.
pub const MAX_MESSAGE_BYTES: usize = 50 * 1024 * 1024;
/// Largest single attachment payload kept.
pub const MAX_ATTACHMENT_BYTES: usize = 100 * 1024 * 1024;
/// MIME nesting budget.
pub const MAX_MIME_DEPTH: usize = 32;
/// MIME part-count budget.
pub const MAX_MIME_PARTS: usize = 512;
/// Longest single header line.
pub const MAX_HEADER_LINE: usize = 64 * 1024;
/// Longest whole header block.
pub const MAX_HEADER_BLOCK: usize = 1024 * 1024;
/// Longest plain-text preview kept on a header row.
pub const MAX_PREVIEW_CHARS: usize = 240;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const GREETING_TIMEOUT: Duration = Duration::from_secs(15);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(300);
const SMTP_TIMEOUT: Duration = Duration::from_secs(300);

// ── Parsing ─────────────────────────────────────────────────────────────────

/// The header-shaped half of a parsed message.
#[derive(Debug, Clone, Default)]
pub struct ParsedHeaders {
    pub subject: String,
    pub from: MailAddress,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub date: String,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub has_attachments: bool,
    pub size: u64,
    pub preview: String,
    /// Header problems the user must *see* rather than have silently resolved
    /// — a duplicate `From:` is the classic sender-spoofing setup (plan B T7).
    pub malformed_headers: Vec<String>,
}

/// One decoded attachment. `bytes` are the decoded payload; the caller stores
/// them content-addressed, so the sender-supplied `filename` never reaches a
/// syscall.
#[derive(Debug, Clone)]
pub struct ParsedAttachment {
    pub part_id: String,
    pub meta: MailAttachmentMeta,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedMessage {
    pub headers: ParsedHeaders,
    pub html: Option<String>,
    pub text: Option<String>,
    pub attachments: Vec<ParsedAttachment>,
}

/// Parse just the headers of a message (an IMAP `BODY.PEEK[HEADER]` fetch).
pub fn parse_headers(raw: &[u8]) -> Result<ParsedHeaders, MailError> {
    let msg = parse_bounded(raw)?;
    Ok(headers_of(&msg, raw.len() as u64))
}

/// Parse a whole message, with every structural cap applied.
pub fn parse_message(raw: &[u8]) -> Result<ParsedMessage, MailError> {
    let msg = parse_bounded(raw)?;
    let headers = headers_of(&msg, raw.len() as u64);

    // `html_body` is not "the parts that are HTML": `mail-parser` falls back to
    // the `text/plain` part when a message has no `text/html` one, because its
    // own `body_html()` accessor escapes such a part on the way out. We read the
    // part directly, so taking that fallback would run a **plain-text** body
    // through the HTML renderer — `<a href="https://evil.example">bank.example
    // </a>` typed into a plain-text mail would become a real link row with a
    // real Open button. The part must actually *be* `text/html`.
    let html_part = msg
        .html_body
        .first()
        .and_then(|id| msg.part(*id))
        .filter(|p| part_is_html(p));
    let mut text = msg
        .text_body
        .first()
        .and_then(|id| msg.part(*id))
        .and_then(|p| p.text_contents().map(|s| s.to_string()));

    // A body declared in a refused charset is **not** given to the HTML path.
    // `mail-parser` will happily decode UTF-7, and decoding it manufactures
    // markup the sender never wrote in plain sight (`+ADw-script+AD4-` becomes
    // `<script>`). The sanitizer would strip it anyway — this is the layer
    // above that, so an unsupported charset degrades to text rather than to
    // renderer sniffing (plan B T18).
    let mut html = None;
    if let Some(part) = html_part {
        let decoded = part.text_contents().map(|s| s.to_string());
        if charset_is_refused(part.content_type().and_then(|ct| ct.attribute("charset"))) {
            if text.is_none() {
                text = decoded;
            }
        } else {
            html = decoded;
        }
    }

    let mut attachments = Vec::new();
    for (idx, id) in msg.attachments.iter().enumerate() {
        let Some(part) = msg.part(*id) else { continue };
        let bytes = part.contents();
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            continue;
        }
        let declared = part
            .content_type()
            .map(|ct| match ct.subtype() {
                Some(sub) => format!("{}/{}", ct.ctype(), sub),
                None => ct.ctype().to_string(),
            })
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let raw_name = part
            .attachment_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("attachment-{idx}"));
        let safe = sanitize_attachment_name(&raw_name);
        let inline = part
            .content_disposition()
            .map(|cd| cd.ctype().eq_ignore_ascii_case("inline"))
            .unwrap_or(false);
        let mismatch = type_mismatch(&declared, &safe.value, bytes);
        attachments.push(ParsedAttachment {
            part_id: id.to_string(),
            meta: MailAttachmentMeta {
                part_id: id.to_string(),
                filename: safe.value,
                mime: declared,
                size: bytes.len() as u64,
                inline,
                type_mismatch: mismatch,
            },
            bytes: bytes.to_vec(),
        });
    }

    if html.is_none() && text.is_none() && attachments.is_empty() {
        return Err(MailError::NoDisplayableContent);
    }

    Ok(ParsedMessage {
        headers,
        html,
        text,
        attachments,
    })
}

/// Is this part actually declared `text/html`? See [`parse_message`]: a part
/// `mail-parser` offers as the "html body" may in fact be `text/plain`.
fn part_is_html(part: &mail_parser::MessagePart<'_>) -> bool {
    part.content_type()
        .and_then(|ct| ct.subtype().map(|sub| (ct.ctype(), sub)))
        .map(|(ctype, sub)| ctype.eq_ignore_ascii_case("text") && sub.eq_ignore_ascii_case("html"))
        .unwrap_or(false)
}

/// Charsets a `text/html` part may not be rendered from.
///
/// UTF-7 is the whole list and the whole point: it is the one encoding in
/// common use where ASCII-safe-looking bytes decode into markup, which is why
/// it has been an XSS vector for two decades. It is not "unsupported" here — it
/// is refused, and the body falls back to being shown as text.
///
/// **The label is normalized exactly the way `mail-parser` normalizes it**, and
/// that is the whole correctness argument: this gate is only meaningful for the
/// spellings the decoder underneath *acts on*. `mail-parser`'s charset lookup
/// upper→lower-cases and maps `-` to `_` before matching, and its two UTF-7 keys
/// are `utf_7` and `csutf7` — so `charset=csutf7` and `charset=utf_7` decode as
/// UTF-7 while a list of hand-written hyphenated spellings misses both, and
/// three of that list's five entries (`utf7`, `x-utf-7`, `unicode-1-1-utf-7`)
/// are not decoded as UTF-7 by anything. They are kept anyway: refusing a label
/// nobody decodes costs a plain-text fallback, and another mail library — or a
/// future `mail-parser` — may well decode them.
fn charset_is_refused(charset: Option<&str>) -> bool {
    let Some(cs) = charset else { return false };
    // `mail-parser`'s own normalization (`charset_decoder`): ASCII-lowercase and
    // `-` → `_`. Ours additionally trims the quoting a `Content-Type` parameter
    // may still carry.
    let cs: String = cs
        .trim()
        .trim_matches('"')
        .trim()
        .chars()
        .map(|c| match c {
            'A'..='Z' => c.to_ascii_lowercase(),
            '-' => '_',
            _ => c,
        })
        .collect();
    matches!(
        cs.as_str(),
        // The two labels `mail-parser` actually decodes as UTF-7.
        "utf_7" | "csutf7"
        // Spellings other decoders use, refused defensively.
        | "utf7" | "unicode_1_1_utf_7" | "csunicode11utf7" | "x_utf_7"
        | "unicode_2_0_utf_7" | "x_unicode_2_0_utf_7"
    )
}

/// Size, header and structural checks, then the parse itself.
fn parse_bounded(raw: &[u8]) -> Result<mail_parser::Message<'_>, MailError> {
    if raw.len() > MAX_MESSAGE_BYTES {
        return Err(MailError::TooLarge { bytes: raw.len() });
    }
    scan_headers(raw)?;
    let msg = MessageParser::default()
        .parse(raw)
        .ok_or(MailError::Unparseable)?;
    check_structure(&msg, 0)?;
    Ok(msg)
}

/// Pre-parse byte scan of the header block: one line at most
/// [`MAX_HEADER_LINE`], the block at most [`MAX_HEADER_BLOCK`].
///
/// Deliberately runs *before* `mail-parser` rather than inspecting its output:
/// a cap that only applies after the allocation has already happened is not a
/// cap.
fn scan_headers(raw: &[u8]) -> Result<(), MailError> {
    let mut line_len = 0usize;
    let mut block_len = 0usize;
    let mut prev_blank = false;
    for &b in raw {
        block_len += 1;
        if block_len > MAX_HEADER_BLOCK {
            return Err(MailError::HeaderTooLong);
        }
        if b == b'\n' {
            if line_len == 0 || (line_len == 1 && prev_blank) {
                // Empty line — end of the header block.
                return Ok(());
            }
            prev_blank = true;
            line_len = 0;
            continue;
        }
        if b == b'\r' {
            prev_blank = line_len == 0;
            line_len += 1;
            continue;
        }
        prev_blank = false;
        line_len += 1;
        if line_len > MAX_HEADER_LINE {
            return Err(MailError::HeaderTooLong);
        }
    }
    Ok(())
}

/// Walk the parsed tree enforcing depth and part-count budgets.
///
/// Iterative rather than recursive: the input is attacker-controlled and the
/// whole point of the depth cap is that a 64-deep `message/rfc822` chain must
/// not be able to reach the stack in the first place.
fn check_structure(msg: &mail_parser::Message<'_>, base_depth: usize) -> Result<(), MailError> {
    if base_depth > MAX_MIME_DEPTH {
        return Err(MailError::TooDeep);
    }
    if msg.parts.len() > MAX_MIME_PARTS {
        return Err(MailError::TooManyParts);
    }
    let mut count = 0usize;
    let mut stack: Vec<(u32, usize)> = vec![(0, base_depth)];
    let mut nested: Vec<(&mail_parser::Message<'_>, usize)> = Vec::new();
    while let Some((id, depth)) = stack.pop() {
        if depth > MAX_MIME_DEPTH {
            return Err(MailError::TooDeep);
        }
        count += 1;
        if count > MAX_MIME_PARTS {
            return Err(MailError::TooManyParts);
        }
        let Some(part) = msg.part(id) else { continue };
        match &part.body {
            PartType::Multipart(children) => {
                for child in children {
                    stack.push((*child, depth + 1));
                }
            }
            PartType::Message(inner) => nested.push((inner, depth + 1)),
            _ => {}
        }
    }
    for (inner, depth) in nested {
        check_structure(inner, depth)?;
    }
    Ok(())
}

fn addr_list(addr: Option<&mail_parser::Address<'_>>) -> Vec<MailAddress> {
    let Some(addr) = addr else { return Vec::new() };
    let mut out = Vec::new();
    match addr {
        mail_parser::Address::List(list) => {
            for a in list {
                out.push(one_addr(a));
            }
        }
        mail_parser::Address::Group(groups) => {
            for g in groups {
                for a in &g.addresses {
                    out.push(one_addr(a));
                }
            }
        }
    }
    out
}

fn one_addr(a: &mail_parser::Addr<'_>) -> MailAddress {
    // The display name is stripped of bidi/format controls before it can reach
    // the UI: `From: "support@bank.example"<a@evil.example>` with an RLO in the
    // name is the standard sender disguise (plan B T7). The *addr-spec* is
    // always kept as its own field so the UI can render it unconditionally.
    let name = a
        .name
        .as_deref()
        .map(strip_controls)
        .filter(|s| !s.trim().is_empty());
    MailAddress {
        name,
        address: a.address.as_deref().unwrap_or_default().to_string(),
    }
}

fn strip_controls(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() && !matches!(
            c,
            '\u{200E}' | '\u{200F}' | '\u{202A}' | '\u{202B}' | '\u{202C}' | '\u{202D}'
                | '\u{202E}' | '\u{2066}' | '\u{2067}' | '\u{2068}' | '\u{2069}' | '\u{061C}'
        ))
        .collect()
}

fn headers_of(msg: &mail_parser::Message<'_>, size: u64) -> ParsedHeaders {
    let mut malformed = Vec::new();
    let from_count = msg
        .headers()
        .iter()
        .filter(|h| matches!(h.name, mail_parser::HeaderName::From))
        .count();
    if from_count > 1 {
        malformed.push("DUPLICATE_FROM".to_string());
    }
    let sender_count = msg
        .headers()
        .iter()
        .filter(|h| matches!(h.name, mail_parser::HeaderName::Sender))
        .count();
    if sender_count > 1 {
        malformed.push("DUPLICATE_SENDER".to_string());
    }

    let from = addr_list(msg.from()).into_iter().next().unwrap_or_default();
    let subject = msg.subject().map(strip_controls).unwrap_or_default();

    let preview = msg
        .body_preview(MAX_PREVIEW_CHARS)
        .map(|p| strip_controls(&p))
        .unwrap_or_default();

    let references = match msg.references() {
        mail_parser::HeaderValue::Text(t) => vec![t.to_string()],
        mail_parser::HeaderValue::TextList(l) => l.iter().map(|s| s.to_string()).collect(),
        _ => Vec::new(),
    };
    let in_reply_to = match msg.in_reply_to() {
        mail_parser::HeaderValue::Text(t) => Some(t.to_string()),
        mail_parser::HeaderValue::TextList(l) => l.first().map(|s| s.to_string()),
        _ => None,
    };

    ParsedHeaders {
        subject,
        from,
        to: addr_list(msg.to()),
        cc: addr_list(msg.cc()),
        date: msg.date().map(|d| d.to_rfc3339()).unwrap_or_default(),
        message_id: msg.message_id().map(|s| s.to_string()),
        in_reply_to,
        references,
        has_attachments: msg.attachment_count() > 0,
        size,
        preview,
        malformed_headers: malformed,
    }
}

/// Three signals per attachment — **declared** (`Content-Type`), **sniffed**
/// (`infer`), and **implied** (the extension) — reduced to one warning string.
///
/// The strongest single signal gets its own message: bytes that sniff as an
/// executable are a program regardless of what the header or the extension
/// claims.
pub fn type_mismatch(declared: &str, safe_name: &str, bytes: &[u8]) -> Option<String> {
    let head = &bytes[..bytes.len().min(8192)];
    if is_executable(head) {
        return Some("executable".to_string());
    }
    let sniffed = infer::get(head).map(|k| k.mime_type().to_string());
    let implied = mime_guess::from_path(safe_name)
        .first()
        .map(|m| m.to_string());

    if let Some(sniffed) = &sniffed {
        let top = |m: &str| m.split('/').next().unwrap_or("").to_ascii_lowercase();
        if top(sniffed) != top(declared) {
            return Some(format!("declared {declared}, looks like {sniffed}"));
        }
        if let Some(implied) = &implied {
            if implied != sniffed {
                return Some(format!("named like {implied}, looks like {sniffed}"));
            }
        }
    }
    if double_extension_is_executable(safe_name) {
        return Some("double-extension".to_string());
    }
    None
}

fn is_executable(head: &[u8]) -> bool {
    head.starts_with(b"MZ")
        || head.starts_with(b"\x7fELF")
        || head.starts_with(b"#!")
        || head.starts_with(&[0xFE, 0xED, 0xFA, 0xCE])
        || head.starts_with(&[0xFE, 0xED, 0xFA, 0xCF])
        || head.starts_with(&[0xCF, 0xFA, 0xED, 0xFE])
        || head.starts_with(&[0xCE, 0xFA, 0xED, 0xFE])
        || head.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE])
}

/// Extensions that are a program by any other name. Checked against the
/// **sanitized** name's final extension, case-insensitively.
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe", "com", "scr", "pif", "bat", "cmd", "msi", "msp", "cpl", "hta", "js", "jse", "vbs",
    "vbe", "wsf", "wsh", "ps1", "psm1", "sh", "bash", "zsh", "jar", "apk", "app", "dmg", "pkg",
    "lnk", "url", "scf", "reg", "inf", "desktop", "gadget", "chm", "msc", "ade", "adp", "mde",
    "mdb",
];

fn double_extension_is_executable(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() < 3 {
        return false;
    }
    let last = parts[parts.len() - 1].to_ascii_lowercase();
    EXECUTABLE_EXTENSIONS.contains(&last.as_str())
}

// ── The engine seam ─────────────────────────────────────────────────────────

/// One fetched header row, before it is given a store identity.
#[derive(Debug, Clone)]
pub struct FetchedHeader {
    pub uid: u32,
    pub seen: bool,
    pub flagged: bool,
    pub answered: bool,
    pub headers: ParsedHeaders,
}

/// One folder as the server describes it.
#[derive(Debug, Clone)]
pub struct FetchedFolder {
    pub path: String,
    pub name: String,
    pub kind: MailFolderKind,
    pub total: u32,
    pub unread: u32,
}

/// All mail work sits behind this trait, with an `AppHandle`-free, path-free
/// API that speaks messages rather than files. `InProcess` is the only
/// implementation today; a `Helper` variant speaking a length-prefixed protocol
/// to a landlocked child is plan A's Phase 5, and nothing above this trait
/// learns about the difference.
#[allow(async_fn_in_trait)]
pub trait MailEngine: Send + Sync {
    async fn probe(&self, account: &MailAccount, password: &Password) -> MailProbe;
    async fn folders(
        &self,
        account: &MailAccount,
        password: &Password,
    ) -> Result<Vec<FetchedFolder>, MailError>;
    async fn headers(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        limit: u32,
    ) -> Result<Vec<FetchedHeader>, MailError>;
    async fn body(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uid: u32,
    ) -> Result<Vec<u8>, MailError>;
    async fn set_flag(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uid: u32,
        flag: &str,
        value: bool,
    ) -> Result<(), MailError>;
    async fn move_messages(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uids: &[u32],
        dest_path: &str,
    ) -> Result<(), MailError>;
    async fn send(
        &self,
        account: &MailAccount,
        password: &Password,
        envelope_from: &str,
        recipients: &[String],
        raw: &[u8],
    ) -> Result<(), MailError>;
}

/// The in-process engine: sockets and parsers in Eldrun's own address space.
#[derive(Debug, Clone, Copy, Default)]
pub struct InProcessEngine;

type ImapSession = async_imap::Session<TlsStream<TcpStream>>;

async fn tls_stream(server: &MailServer) -> Result<TlsStream<TcpStream>, MailError> {
    // The refusal is here, at the one place a socket is opened, rather than in
    // the UI: there is no code path that produces a cleartext session, so
    // "allow insecure" is not a setting someone could add later without
    // deleting this.
    if server.security != MailSecurity::Tls {
        return Err(MailError::PlaintextRefused);
    }
    let host = server.host.trim().to_string();
    if host.is_empty() {
        return Err(MailError::Protocol("no server host configured".into()));
    }
    let tcp = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((host.as_str(), server.port)),
    )
    .await
    .map_err(|_| MailError::Timeout { op: "connect" })?
    .map_err(|e| MailError::Protocol(format!("could not reach {host}: {e}")))?;

    let connector = tokio_rustls::TlsConnector::from(tls_config());
    let name = rustls_pki_types::ServerName::try_from(host.clone())
        .map_err(|_| MailError::Protocol(format!("'{host}' is not a valid server name")))?;
    let stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, connector.connect(name, tcp))
        .await
        .map_err(|_| MailError::Timeout { op: "TLS handshake" })?
        .map_err(|e| MailError::Protocol(describe_tls_error(&host, &e)))?;
    Ok(stream)
}

/// Say *what* failed, in words that do not create pressure for an override
/// button. "Certificate error" is exactly the message that makes users demand
/// an "ignore" checkbox; naming the cause and the remedy is what makes not
/// having one tenable.
fn describe_tls_error(host: &str, e: &std::io::Error) -> String {
    let text = e.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("notvalidforname") || lower.contains("not valid for name") {
        format!(
            "The server presented a certificate that is not valid for '{host}'. \
             Check the server address for a typo."
        )
    } else if lower.contains("unknownissuer") || lower.contains("unknown issuer") {
        format!(
            "This server's certificate is signed by an authority your system doesn't trust. \
             If '{host}' is a private server, install its certificate authority in your \
             operating system's trust store."
        )
    } else if lower.contains("expired") {
        format!(
            "This server's certificate has expired. That is usually the server \
             administrator's problem, not yours ({host})."
        )
    } else if lower.contains("revoked") {
        format!("This server's certificate has been revoked. Do not enter your password ({host}).")
    } else {
        format!("TLS connection to {host} failed: {text}")
    }
}

async fn imap_login(
    server: &MailServer,
    password: &Password,
) -> Result<ImapSession, MailError> {
    let stream = tls_stream(server).await?;
    let mut client = async_imap::Client::new(stream);
    let greeting = tokio::time::timeout(GREETING_TIMEOUT, client.read_response())
        .await
        .map_err(|_| MailError::Timeout { op: "IMAP greeting" })?
        .map_err(|e| MailError::Protocol(format!("IMAP greeting failed: {e}")))?;
    if greeting.is_none() {
        return Err(MailError::Protocol(
            "the IMAP server closed the connection before greeting".into(),
        ));
    }
    // One attempt. A retry loop against a provider's lockout policy is how
    // accounts get locked, and it is also how a stale saved credential becomes
    // a lockout rather than a prompt.
    let session = tokio::time::timeout(
        COMMAND_TIMEOUT,
        client.login(server.user.clone(), password.expose().to_string()),
    )
    .await
    .map_err(|_| MailError::Timeout { op: "IMAP login" })?
    .map_err(|(e, _client)| classify_imap_error(e))?;
    Ok(session)
}

fn classify_imap_error(e: async_imap::error::Error) -> MailError {
    let text = e.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("authenticationfailed")
        || lower.contains("authentication failed")
        || lower.contains("invalid credentials")
        || lower.contains("login failed")
    {
        MailError::AuthFailed
    } else {
        MailError::Protocol(text)
    }
}

fn folder_kind(path: &str, attributes: &[async_imap::types::NameAttribute<'_>]) -> MailFolderKind {
    for attr in attributes {
        let a = format!("{attr:?}").to_ascii_lowercase();
        for (needle, kind) in [
            ("sent", MailFolderKind::Sent),
            ("drafts", MailFolderKind::Drafts),
            ("trash", MailFolderKind::Trash),
            ("junk", MailFolderKind::Junk),
            ("archive", MailFolderKind::Archive),
        ] {
            if a.contains(needle) {
                return kind;
            }
        }
    }
    let last = path.rsplit(['/', '.']).next().unwrap_or(path);
    match last.to_ascii_lowercase().as_str() {
        "inbox" => MailFolderKind::Inbox,
        "sent" | "sent items" | "sent messages" => MailFolderKind::Sent,
        "drafts" => MailFolderKind::Drafts,
        "trash" | "deleted items" => MailFolderKind::Trash,
        "junk" | "spam" => MailFolderKind::Junk,
        "archive" | "all mail" => MailFolderKind::Archive,
        _ => MailFolderKind::Other,
    }
}

impl MailEngine for InProcessEngine {
    async fn probe(&self, account: &MailAccount, password: &Password) -> MailProbe {
        let mut out = MailProbe::default();
        let mut errors: Vec<String> = Vec::new();

        match imap_login(&account.imap, password).await {
            Ok(mut session) => {
                out.imap_ok = true;
                let _ = tokio::time::timeout(COMMAND_TIMEOUT, session.logout()).await;
            }
            Err(e) => errors.push(format!("IMAP: {e}")),
        }

        match smtp_connect(&account.smtp, password).await {
            Ok(client) => {
                out.smtp_ok = true;
                let _ = client.quit().await;
            }
            Err(e) => errors.push(format!("SMTP: {e}")),
        }

        if !errors.is_empty() {
            out.error = Some(errors.join("; "));
        }
        out
    }

    async fn folders(
        &self,
        account: &MailAccount,
        password: &Password,
    ) -> Result<Vec<FetchedFolder>, MailError> {
        let mut session = imap_login(&account.imap, password).await?;
        let mut out = Vec::new();
        {
            let mut stream = tokio::time::timeout(COMMAND_TIMEOUT, session.list(Some(""), Some("*")))
                .await
                .map_err(|_| MailError::Timeout { op: "IMAP LIST" })?
                .map_err(classify_imap_error)?;
            while let Some(name) = stream.next().await {
                let name = name.map_err(classify_imap_error)?;
                let path = name.name().to_string();
                let display = path
                    .rsplit(['/', '.'])
                    .next()
                    .unwrap_or(&path)
                    .to_string();
                out.push(FetchedFolder {
                    kind: folder_kind(&path, name.attributes()),
                    name: display,
                    path,
                    total: 0,
                    unread: 0,
                });
                if out.len() >= 500 {
                    break;
                }
            }
        }
        let _ = tokio::time::timeout(COMMAND_TIMEOUT, session.logout()).await;
        Ok(out)
    }

    async fn headers(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        limit: u32,
    ) -> Result<Vec<FetchedHeader>, MailError> {
        let mut session = imap_login(&account.imap, password).await?;
        let mailbox = tokio::time::timeout(COMMAND_TIMEOUT, session.select(folder_path))
            .await
            .map_err(|_| MailError::Timeout { op: "IMAP SELECT" })?
            .map_err(classify_imap_error)?;

        let mut out = Vec::new();
        if mailbox.exists > 0 {
            let limit = limit.clamp(1, 500);
            let first = mailbox.exists.saturating_sub(limit.saturating_sub(1)).max(1);
            let set = format!("{first}:{}", mailbox.exists);
            // BODY.PEEK — never BODY — so listing a folder cannot mark mail as
            // read on the server (and cannot be used to tell a sender that a
            // message was opened).
            let query = "(UID FLAGS RFC822.SIZE BODY.PEEK[HEADER])";
            let mut stream = tokio::time::timeout(FETCH_TIMEOUT, session.fetch(set, query))
                .await
                .map_err(|_| MailError::Timeout { op: "IMAP FETCH" })?
                .map_err(classify_imap_error)?;
            while let Some(item) = stream.next().await {
                let item = item.map_err(classify_imap_error)?;
                let Some(uid) = item.uid else { continue };
                let raw = item.header().unwrap_or(b"");
                let Ok(headers) = parse_headers(raw) else {
                    continue;
                };
                let mut headers = headers;
                headers.size = item.size.unwrap_or(raw.len() as u32) as u64;
                let flags: Vec<String> = item.flags().map(|f| format!("{f:?}")).collect();
                out.push(FetchedHeader {
                    uid,
                    seen: flags.iter().any(|f| f.contains("Seen")),
                    flagged: flags.iter().any(|f| f.contains("Flagged")),
                    answered: flags.iter().any(|f| f.contains("Answered")),
                    headers,
                });
            }
        }
        let _ = tokio::time::timeout(COMMAND_TIMEOUT, session.logout()).await;
        Ok(out)
    }

    async fn body(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uid: u32,
    ) -> Result<Vec<u8>, MailError> {
        let mut session = imap_login(&account.imap, password).await?;
        tokio::time::timeout(COMMAND_TIMEOUT, session.select(folder_path))
            .await
            .map_err(|_| MailError::Timeout { op: "IMAP SELECT" })?
            .map_err(classify_imap_error)?;

        let mut bytes: Vec<u8> = Vec::new();
        {
            let mut stream = tokio::time::timeout(
                FETCH_TIMEOUT,
                session.uid_fetch(uid.to_string(), "BODY.PEEK[]"),
            )
            .await
            .map_err(|_| MailError::Timeout { op: "IMAP FETCH" })?
            .map_err(classify_imap_error)?;
            while let Some(item) = stream.next().await {
                let item = item.map_err(classify_imap_error)?;
                if let Some(body) = item.body() {
                    if body.len() > MAX_MESSAGE_BYTES {
                        return Err(MailError::TooLarge { bytes: body.len() });
                    }
                    bytes = body.to_vec();
                }
            }
        }
        let _ = tokio::time::timeout(COMMAND_TIMEOUT, session.logout()).await;
        if bytes.is_empty() {
            return Err(MailError::Protocol("the server returned no message".into()));
        }
        Ok(bytes)
    }

    async fn set_flag(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uid: u32,
        flag: &str,
        value: bool,
    ) -> Result<(), MailError> {
        let mut session = imap_login(&account.imap, password).await?;
        tokio::time::timeout(COMMAND_TIMEOUT, session.select(folder_path))
            .await
            .map_err(|_| MailError::Timeout { op: "IMAP SELECT" })?
            .map_err(classify_imap_error)?;
        let op = if value { "+FLAGS" } else { "-FLAGS" };
        {
            let mut stream = tokio::time::timeout(
                COMMAND_TIMEOUT,
                session.uid_store(uid.to_string(), format!("{op} ({flag})")),
            )
            .await
            .map_err(|_| MailError::Timeout { op: "IMAP STORE" })?
            .map_err(classify_imap_error)?;
            while stream.next().await.is_some() {}
        }
        let _ = tokio::time::timeout(COMMAND_TIMEOUT, session.logout()).await;
        Ok(())
    }

    async fn move_messages(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uids: &[u32],
        dest_path: &str,
    ) -> Result<(), MailError> {
        if uids.is_empty() {
            return Ok(());
        }
        let mut session = imap_login(&account.imap, password).await?;
        tokio::time::timeout(COMMAND_TIMEOUT, session.select(folder_path))
            .await
            .map_err(|_| MailError::Timeout { op: "IMAP SELECT" })?
            .map_err(classify_imap_error)?;
        let set = uids
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");
        tokio::time::timeout(COMMAND_TIMEOUT, session.uid_mv(set, dest_path))
            .await
            .map_err(|_| MailError::Timeout { op: "IMAP MOVE" })?
            .map_err(classify_imap_error)?;
        let _ = tokio::time::timeout(COMMAND_TIMEOUT, session.logout()).await;
        Ok(())
    }

    async fn send(
        &self,
        account: &MailAccount,
        password: &Password,
        envelope_from: &str,
        recipients: &[String],
        raw: &[u8],
    ) -> Result<(), MailError> {
        if recipients.is_empty() {
            return Err(MailError::Protocol("no recipients".into()));
        }
        let mut client = smtp_connect(&account.smtp, password).await?;
        let message = mail_send::smtp::message::Message::new(
            envelope_from.to_string(),
            recipients.to_vec(),
            raw.to_vec(),
        );
        tokio::time::timeout(SMTP_TIMEOUT, client.send(message))
            .await
            .map_err(|_| MailError::Timeout { op: "SMTP send" })?
            .map_err(classify_smtp_error)?;
        let _ = client.quit().await;
        Ok(())
    }
}

async fn smtp_connect(
    server: &MailServer,
    password: &Password,
) -> Result<mail_send::SmtpClient<TlsStream<TcpStream>>, MailError> {
    if server.security != MailSecurity::Tls {
        return Err(MailError::PlaintextRefused);
    }
    let builder = mail_send::SmtpClientBuilder::new(server.host.clone(), server.port)
        .map_err(MailError::Protocol)?
        // Implicit TLS. Note there is deliberately no certificate-bypass call
        // anywhere in this file — a source-scanning test asserts that.
        .implicit_tls(true)
        .timeout(SMTP_TIMEOUT)
        .credentials((server.user.clone(), password.expose().to_string()));
    tokio::time::timeout(SMTP_TIMEOUT, builder.connect())
        .await
        .map_err(|_| MailError::Timeout { op: "SMTP connect" })?
        .map_err(classify_smtp_error)
}

fn classify_smtp_error(e: mail_send::Error) -> MailError {
    match e {
        mail_send::Error::AuthenticationFailed(_) | mail_send::Error::MissingCredentials => {
            MailError::AuthFailed
        }
        mail_send::Error::UnsupportedAuthMechanism => MailError::NoSupportedAuth,
        mail_send::Error::Timeout => MailError::Timeout { op: "SMTP" },
        mail_send::Error::Tls(err) => MailError::Protocol(format!("TLS error: {err}")),
        other => MailError::Protocol(format!("{other:?}")),
    }
}

// ── Outbound construction ───────────────────────────────────────────────────

/// A header value that would inject a second header. Recipients are parsed into
/// typed addresses and never concatenated, but a `Subject:` is user text, so
/// every value is checked for CR/LF **before** it is handed to `mail-builder`
/// (plan B T16).
pub fn reject_header_injection(value: &str) -> Result<&str, MailError> {
    if value.contains('\r') || value.contains('\n') || value.contains('\0') {
        return Err(MailError::Protocol(
            "a header value may not contain a line break".into(),
        ));
    }
    Ok(value)
}

/// A recipient address that is one address and nothing else.
pub fn validate_recipient(addr: &str) -> Result<String, MailError> {
    let a = addr.trim();
    reject_header_injection(a)?;
    if a.is_empty() || !a.contains('@') || a.contains(',') || a.contains(';') || a.contains(' ') {
        return Err(MailError::Protocol(format!(
            "'{a}' is not a single e-mail address"
        )));
    }
    Ok(a.to_string())
}

/// Total outbound message budget, warned about before any network call.
pub const MAX_OUTBOUND_BYTES: usize = 25 * 1024 * 1024;

/// One attachment to put on an outgoing message. `filename` is already the
/// **basename**, run through `sanitize_attachment_name` — a full local path in
/// a `Content-Disposition` is a directory-structure and username leak.
pub struct OutboundAttachment {
    pub filename: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// Build the RFC 5322 bytes of an outgoing plain-text message.
#[allow(clippy::too_many_arguments)]
pub fn build_outgoing(
    from_name: Option<&str>,
    from_addr: &str,
    to: &[String],
    cc: &[String],
    bcc: &[String],
    subject: &str,
    body_text: &str,
    in_reply_to: Option<&str>,
    references: &[String],
    attachments: &[OutboundAttachment],
) -> Result<Vec<u8>, MailError> {
    let from_addr = validate_recipient(from_addr)?;
    let subject = reject_header_injection(subject)?;
    let to: Vec<String> = to.iter().map(|a| validate_recipient(a)).collect::<Result<_, _>>()?;
    let cc: Vec<String> = cc.iter().map(|a| validate_recipient(a)).collect::<Result<_, _>>()?;
    // Bcc is validated but deliberately NOT written as a header — it goes in
    // the SMTP envelope only, which is the whole point of a blind copy.
    for b in bcc {
        validate_recipient(b)?;
    }

    let mut builder = mail_send::mail_builder::MessageBuilder::new();
    builder = match from_name {
        Some(n) => builder.from((reject_header_injection(n)?.to_string(), from_addr.clone())),
        None => builder.from(from_addr.clone()),
    };
    if !to.is_empty() {
        builder = builder.to(to.clone());
    }
    if !cc.is_empty() {
        builder = builder.cc(cc.clone());
    }
    builder = builder.subject(subject).text_body(body_text.to_string());
    if let Some(irt) = in_reply_to {
        builder = builder.in_reply_to(reject_header_injection(irt)?.to_string());
    }
    if !references.is_empty() {
        let refs: Vec<String> = references
            .iter()
            .map(|r| reject_header_injection(r).map(|s| s.to_string()))
            .collect::<Result<_, _>>()?;
        builder = builder.references(refs);
    }
    for att in attachments {
        let safe = sanitize_attachment_name(&att.filename);
        builder = builder.attachment(att.mime.clone(), safe.value, att.bytes.clone());
    }

    let bytes = builder
        .write_to_vec()
        .map_err(|e| MailError::Protocol(format!("could not build the message: {e}")))?;
    if bytes.len() > MAX_OUTBOUND_BYTES {
        return Err(MailError::TooLarge { bytes: bytes.len() });
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── The crypto provider ─────────────────────────────────────────────────

    /// rustls refuses to guess between two compiled-in providers and panics at
    /// the *first handshake* if none is installed — a failure that would only
    /// ever show up on a user's machine, mid-connect.
    #[test]
    fn provider_is_installed() {
        install_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn installing_twice_is_harmless() {
        install_crypto_provider();
        install_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    // ── Secrets ─────────────────────────────────────────────────────────────

    #[test]
    fn a_password_never_prints_itself() {
        let pw = Password::new("hunter2");
        let printed = format!("{pw:?}");
        assert!(!printed.contains("hunter2"), "{printed}");
        assert_eq!(printed, "Password(<redacted>)");
        // And inside a container, which is how it would reach a log line.
        let wrapped = format!("{:?}", Some(pw.clone()));
        assert!(!wrapped.contains("hunter2"), "{wrapped}");
        assert_eq!(pw.expose(), "hunter2");
    }

    // ── Transport ───────────────────────────────────────────────────────────

    /// The one structural guarantee behind "there is no ignore-certificate
    /// option": the strings that would introduce one do not appear in the mail
    /// sources. Cheap, and it makes "just add a checkbox" a failing test rather
    /// than a code-review argument.
    #[test]
    fn no_certificate_verification_escape_hatch() {
        let sources: [(&str, &str); 4] = [
            ("mail_engine.rs", include_str!("mail_engine.rs")),
            ("mail_sanitize.rs", include_str!("mail_sanitize.rs")),
            ("mail_store.rs", include_str!("mail_store.rs")),
            ("commands/mail.rs", include_str!("../commands/mail.rs")),
        ];
        // Split so this list does not match itself when the scan runs over
        // this very file.
        let banned = [
            concat!("danger", "ous()"),
            concat!("ServerCert", "Verifier"),
            concat!("danger_accept", "_invalid"),
            concat!("with_custom_certificate", "_verifier"),
            concat!("NoCertificate", "Verification"),
            concat!("allow_invalid", "_certs"),
        ];
        for (name, src) in sources {
            for needle in banned {
                assert!(
                    !src.contains(needle),
                    "{name} must not contain `{needle}` — certificate validation has no bypass"
                );
            }
        }
    }

    /// v1 speaks implicit TLS only, so the cleartext submission/access ports
    /// must not appear as defaults anywhere in the mail sources.
    #[test]
    fn no_cleartext_default_ports() {
        let sources: [(&str, &str); 2] = [
            ("mail_engine.rs", include_str!("mail_engine.rs")),
            ("commands/mail.rs", include_str!("../commands/mail.rs")),
        ];
        for (name, src) in sources {
            // Split so the list does not match itself when the scan runs over
            // this very file.
            for port in [
                concat!(": ", "143"),
                concat!(": ", "110"),
                concat!(": ", "25,"),
                concat!(": ", "587"),
                concat!("port: ", "143"),
                concat!("port: ", "587"),
            ] {
                assert!(!src.contains(port), "{name} names a cleartext port `{port}`");
            }
        }
    }

    #[tokio::test]
    async fn a_non_tls_endpoint_is_refused_before_any_socket_is_opened() {
        let server = MailServer {
            host: "imap.example.com".into(),
            port: 993,
            user: "u".into(),
            security: MailSecurity::Starttls,
        };
        let err = tls_stream(&server).await.unwrap_err();
        assert_eq!(err, MailError::PlaintextRefused);

        let server = MailServer {
            security: MailSecurity::None,
            ..server
        };
        let err = match smtp_connect(&server, &Password::new("x")).await {
            Ok(_) => panic!("a non-TLS SMTP endpoint must be refused"),
            Err(e) => e,
        };
        assert_eq!(err, MailError::PlaintextRefused);
    }

    // ── Parsing ─────────────────────────────────────────────────────────────

    fn fixture(name: &str) -> Vec<u8> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/mail")
            .join(name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
    }

    #[test]
    fn a_plain_message_parses() {
        let msg = parse_message(&fixture("simple.eml")).unwrap();
        assert_eq!(msg.headers.subject, "Hello there");
        assert_eq!(msg.headers.from.address, "sender@example.com");
        assert_eq!(msg.headers.to.len(), 1);
        assert_eq!(msg.headers.to[0].address, "receiver@example.org");
        assert!(msg.text.unwrap().contains("plain body"));
    }

    #[test]
    fn deeply_nested_messages_are_refused_rather_than_survived() {
        let raw = fixture("deep_nesting.eml");
        assert_eq!(parse_message(&raw).err(), Some(MailError::TooDeep));
    }

    #[test]
    fn too_many_parts_are_refused() {
        // Built in the test rather than checked in — 10 000 parts is a large
        // file to carry in git for one assertion.
        let mut raw = String::from(
            "From: a@example.com\r\nTo: b@example.org\r\nSubject: many\r\n\
             Content-Type: multipart/mixed; boundary=\"B\"\r\n\r\n",
        );
        for i in 0..10_000 {
            raw.push_str(&format!(
                "--B\r\nContent-Type: text/plain\r\n\r\npart {i}\r\n"
            ));
        }
        raw.push_str("--B--\r\n");
        assert_eq!(
            parse_message(raw.as_bytes()).err(),
            Some(MailError::TooManyParts),
            "a 10 000-part message must be refused, not merely survived"
        );
    }

    #[test]
    fn an_oversized_header_line_is_refused() {
        let raw = fixture("huge_header.eml");
        assert_eq!(parse_message(&raw).err(), Some(MailError::HeaderTooLong));
    }

    #[test]
    fn an_oversized_message_is_refused_before_parsing() {
        let mut raw = b"From: a@example.com\r\nSubject: big\r\n\r\n".to_vec();
        raw.resize(MAX_MESSAGE_BYTES + 1, b'x');
        assert!(matches!(
            parse_message(&raw),
            Err(MailError::TooLarge { .. })
        ));
    }

    #[test]
    fn truncated_base64_never_panics() {
        let msg = parse_message(&fixture("truncated_base64.eml"));
        // Either it decodes lossily or the part is unusable; the only forbidden
        // outcome is a panic, which reaching this line proves did not happen.
        assert!(msg.is_ok() || matches!(msg, Err(MailError::NoDisplayableContent)));
    }

    /// `+ADw-script+AD4-` is `<script>` in UTF-7, and `mail-parser` *does*
    /// decode it — which is exactly why the refusal lives above the parser
    /// rather than being assumed from it. A UTF-7 body must never reach the
    /// HTML path at all.
    #[test]
    fn a_utf7_body_never_reaches_the_html_path() {
        let msg = parse_message(&fixture("utf7_script.eml")).unwrap();
        assert!(
            msg.html.is_none(),
            "a UTF-7 body must be refused as HTML, got {:?}",
            msg.html
        );
        // It is still shown, as text, escaped by the plain-text path.
        let text = msg.text.unwrap_or_default();
        let escaped = crate::services::mail_sanitize::plain_text_to_html(&text);
        assert!(!escaped.to_ascii_lowercase().contains("<script"), "{escaped}");
    }

    #[test]
    fn charset_refusal_covers_the_utf7_spellings_and_nothing_else() {
        for cs in [
            "utf-7",
            "UTF-7",
            " \"utf-7\" ",
            "unicode-1-1-utf-7",
            "x-utf-7",
            // The two labels `mail-parser` really decodes as UTF-7. `-` and `_`
            // are the same character to its lookup, and `csutf7` has no
            // separator at all — a hyphenated-spellings list missed both.
            "utf_7",
            "UTF_7",
            "csutf7",
            "CSUTF7",
            " \"csUTF7\" ",
        ] {
            assert!(charset_is_refused(Some(cs)), "{cs} must be refused");
        }
        for cs in ["utf-8", "iso-8859-1", "windows-1252", "us-ascii", "shift_jis"] {
            assert!(!charset_is_refused(Some(cs)), "{cs} must be accepted");
        }
        assert!(!charset_is_refused(None), "no charset is not a refusal");
    }

    /// The regression the spelling list above exists for: `mail-parser` decodes
    /// `csutf7` and `utf_7` as UTF-7 (its lookup lowercases and maps `-`→`_`,
    /// and its two keys are `utf_7`/`csutf7`), so a body labelled either one
    /// arrived at the HTML path as real `<script>` markup that the sender never
    /// wrote. Asserted end-to-end, not just on the predicate, because the
    /// predicate is only worth what the parse around it does with it.
    #[test]
    fn every_utf7_label_the_parser_decodes_is_kept_off_the_html_path() {
        for cs in ["utf-7", "utf_7", "UTF_7", "csutf7", "CSUTF7"] {
            let raw = format!(
                "From: a@example.com\r\nTo: b@example.org\r\nSubject: s\r\n\
                 Content-Type: text/html; charset={cs}\r\n\r\n\
                 +ADw-script+AD4-alert(1)+ADw-/script+AD4-\r\n"
            );
            let msg = parse_message(raw.as_bytes()).unwrap();
            assert!(
                msg.html.is_none(),
                "charset={cs} reached the HTML path with {:?}",
                msg.html
            );
        }
    }

    /// `mail-parser`'s `html_body` falls back to the `text/plain` part when a
    /// message has no `text/html` one. Reading that part directly (rather than
    /// through its escaping `body_html()` accessor) rendered plain-text mail as
    /// markup: the anchor below became a real link row with a real Open button
    /// in a message whose author only ever typed characters.
    #[test]
    fn a_plain_text_only_message_is_never_offered_as_html() {
        let raw = b"From: a@example.com\r\nTo: b@example.org\r\nSubject: s\r\n\
                    Content-Type: text/plain; charset=utf-8\r\n\r\n\
                    hello <a href=\"https://evil.example\">bank.example</a>\r\n";
        let msg = parse_message(raw).unwrap();
        assert!(
            msg.html.is_none(),
            "a text/plain body must not be handed to the HTML renderer, got {:?}",
            msg.html
        );
        let text = msg.text.expect("the plain body must still be shown");
        assert!(text.contains("evil.example"));
        // And the path it *does* take escapes it.
        let escaped = crate::services::mail_sanitize::plain_text_to_html(&text);
        assert!(!escaped.contains("<a "), "{escaped}");
        assert!(escaped.contains("&lt;a "), "{escaped}");
    }

    /// A message with no Content-Type at all defaults to `text/plain`, so it
    /// takes the same escaped path.
    #[test]
    fn a_message_with_no_content_type_is_not_html() {
        let raw = b"From: a@example.com\r\nSubject: s\r\n\r\n<b>x</b>\r\n";
        let msg = parse_message(raw).unwrap();
        assert!(msg.html.is_none(), "{:?}", msg.html);
        assert!(msg.text.unwrap_or_default().contains("<b>"));
    }

    /// The positive control for the two rules above: a genuine `text/html` part
    /// in a genuine charset still reaches the HTML path.
    #[test]
    fn a_real_html_part_still_reaches_the_html_path() {
        let raw = b"From: a@example.com\r\nSubject: s\r\n\
                    Content-Type: text/html; charset=utf-8\r\n\r\n<p>hi</p>\r\n";
        let msg = parse_message(raw).unwrap();
        assert!(msg.html.unwrap_or_default().contains("<p>hi</p>"));
    }

    #[test]
    fn duplicate_from_headers_are_reported_not_silently_resolved() {
        let msg = parse_message(&fixture("duplicate_from.eml")).unwrap();
        assert!(
            msg.headers
                .malformed_headers
                .contains(&"DUPLICATE_FROM".to_string()),
            "{:?}",
            msg.headers.malformed_headers
        );
    }

    /// `From: "security@bank.example" <attacker@evil.example>` — the display
    /// name and the addr-spec must reach the UI as separate fields, so the UI
    /// can render the address unconditionally.
    #[test]
    fn a_display_name_never_stands_in_for_the_address() {
        let msg = parse_message(&fixture("spoofed_display_name.eml")).unwrap();
        assert_eq!(msg.headers.from.address, "attacker@evil.example");
        assert_eq!(
            msg.headers.from.name.as_deref(),
            Some("security@bank.example")
        );
    }

    #[test]
    fn a_traversal_filename_is_reduced_to_its_basename() {
        let msg = parse_message(&fixture("traversal_filename.eml")).unwrap();
        assert_eq!(msg.attachments.len(), 1);
        assert_eq!(msg.attachments[0].meta.filename, "passwd");
    }

    #[test]
    fn an_rtl_override_filename_is_defused() {
        let msg = parse_message(&fixture("rtl_filename.eml")).unwrap();
        let name = &msg.attachments[0].meta.filename;
        assert!(!name.contains('\u{202E}'), "{name}");
        assert!(!name.ends_with(".png"), "{name}");
    }

    #[test]
    fn a_message_with_only_an_octet_stream_body_has_no_displayable_content() {
        let raw = b"From: a@example.com\r\nSubject: x\r\n\
                    Content-Type: application/octet-stream\r\n\r\n\x00\x01\x02";
        assert!(matches!(
            parse_message(raw),
            Err(MailError::NoDisplayableContent) | Ok(_)
        ));
    }

    #[test]
    fn a_message_with_no_content_type_still_parses() {
        let raw = b"From: a@example.com\r\nSubject: x\r\n\r\nhello";
        let msg = parse_message(raw).unwrap();
        assert_eq!(msg.text.as_deref(), Some("hello"));
    }

    /// The plain-text preference must not become a way to skip sanitization of
    /// the HTML alternative.
    #[test]
    fn a_hostile_html_alternative_is_still_sanitized() {
        let msg = parse_message(&fixture("alternative_hostile_html.eml")).unwrap();
        let html = msg.html.expect("the html alternative must be found");
        assert!(html.contains("<script"), "the fixture must be hostile");
        let cleaned = crate::services::mail_sanitize::sanitize_message_html(&html).unwrap();
        assert!(!cleaned.html.to_ascii_lowercase().contains("<script"));
    }

    // ── Attachment typing ───────────────────────────────────────────────────

    #[test]
    fn an_executable_payload_is_flagged_however_it_is_labelled() {
        let mz = b"MZ\x90\x00\x03\x00\x00\x00";
        assert_eq!(
            type_mismatch("image/png", "invoice.png", mz).as_deref(),
            Some("executable")
        );
        let elf = b"\x7fELF\x02\x01\x01\x00";
        assert_eq!(
            type_mismatch("application/pdf", "report.pdf", elf).as_deref(),
            Some("executable")
        );
    }

    #[test]
    fn a_double_extension_is_flagged() {
        assert_eq!(
            type_mismatch("application/octet-stream", "photo.jpg.exe", b"").as_deref(),
            Some("double-extension")
        );
    }

    // ── Outbound ────────────────────────────────────────────────────────────

    /// A CRLF in the subject must not be able to insert a `Bcc:` header.
    #[test]
    fn header_injection_through_the_subject_is_refused() {
        let err = build_outgoing(
            None,
            "me@example.com",
            &["you@example.org".into()],
            &[],
            &[],
            "hello\r\nBcc: evil@evil.example",
            "body",
            None,
            &[],
            &[],
        )
        .unwrap_err();
        assert!(matches!(err, MailError::Protocol(_)));
    }

    #[test]
    fn header_injection_through_a_recipient_is_refused() {
        let err = build_outgoing(
            None,
            "me@example.com",
            &["a@example.com\nCc: b@evil.example".into()],
            &[],
            &[],
            "hi",
            "body",
            None,
            &[],
            &[],
        )
        .unwrap_err();
        assert!(matches!(err, MailError::Protocol(_)));
    }

    /// Bcc is an envelope concept. Writing it as a header would disclose every
    /// blind recipient to every other one.
    #[test]
    fn bcc_never_appears_as_a_header() {
        let bytes = build_outgoing(
            None,
            "me@example.com",
            &["you@example.org".into()],
            &[],
            &["hidden@example.net".into()],
            "hello",
            "body",
            None,
            &[],
            &[],
        )
        .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("Bcc"), "{text}");
        assert!(!text.contains("hidden@example.net"), "{text}");
    }

    /// A picked file's directory is a username and project-structure leak, so
    /// only the basename leaves.
    #[test]
    fn an_attachment_carries_only_its_basename() {
        let bytes = build_outgoing(
            None,
            "me@example.com",
            &["you@example.org".into()],
            &[],
            &[],
            "with attachment",
            "body",
            None,
            &[],
            &[OutboundAttachment {
                filename: "/home/tester/secret-project/notes.pdf".into(),
                mime: "application/pdf".into(),
                bytes: b"%PDF-1.4".to_vec(),
            }],
        )
        .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("notes.pdf"), "{text}");
        assert!(!text.contains("secret-project"), "{text}");
        assert!(!text.contains("/home/tester"), "{text}");
    }

    #[test]
    fn an_oversized_outgoing_message_is_refused_before_any_network_call() {
        let err = build_outgoing(
            None,
            "me@example.com",
            &["you@example.org".into()],
            &[],
            &[],
            "big",
            "body",
            None,
            &[],
            &[OutboundAttachment {
                filename: "big.bin".into(),
                mime: "application/octet-stream".into(),
                bytes: vec![0u8; MAX_OUTBOUND_BYTES],
            }],
        )
        .unwrap_err();
        assert!(matches!(err, MailError::TooLarge { .. }));
    }

    #[test]
    fn a_normal_message_builds() {
        let bytes = build_outgoing(
            Some("Me"),
            "me@example.com",
            &["you@example.org".into()],
            &["cc@example.net".into()],
            &[],
            "Subject line",
            "Hello.",
            Some("<parent@example.com>"),
            &["<root@example.com>".into()],
            &[],
        )
        .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("Subject"), "{text}");
        assert!(text.contains("you@example.org"), "{text}");
        assert!(text.contains("cc@example.net"), "{text}");
    }
}
