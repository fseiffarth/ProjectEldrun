//! CalDAV (RFC 4791 + RFC 6578) — the transport half, hand-rolled on `reqwest`.
//!
//! `docs/caldav_plan.md` §"Dependency decision" is why there is no CalDAV crate
//! here: the whole protocol surface this feature needs is six fixed XML request
//! bodies and one response document shape. The bodies are string templates (the
//! way `src/lib/ics.ts` builds ICS text); the responses go through `roxmltree`,
//! the one new dependency, because a `multistatus` is real XML with namespaces
//! and parsing it by hand is how a client starts believing `<D:href>` and
//! `<d:href>` are different elements.
//!
//! **What this module does not do is understand iCalendar.** A `multistatus`
//! carries `calendar-data` as opaque text; that text is handed to the frontend
//! and parsed by `src/lib/ics.ts`, which is the one parser in this codebase that
//! knows about folding, escaping, `RRULE` and `VALARM`, and the one with tests
//! for all four. This module's entire job is "speak WebDAV, hand back text".
//!
//! **Deliberately not routed through `browser_engine`'s SSRF machinery**
//! (`reader_hop_allowed` / `resolve_hop` / DNS pinning). That machinery exists
//! because a reader-mode or ICS-subscribe URL is content *someone else* handed
//! the user and may point anywhere, including at a metadata endpoint. A CalDAV
//! base URL is the opposite case — the user typed it, for an account they are
//! setting up on purpose — and is exactly the posture `MailServer.host` already
//! has: mail does not run its IMAP host past the reader's hop judge either.
//! Someone pointing this at `https://localhost:5232` for a self-hosted Radicale
//! is not an attack. Redirects are still capped ([`MAX_REDIRECTS`]) so a
//! misconfigured or looping server cannot spin the client forever, and the body
//! is capped so a "calendar" cannot be used to exhaust memory.
//!
//! TLS is the same `rustls` + OS-trust-store stack mail and the browser reader
//! use, with **no cert-ignore escape hatch** — a self-signed cert on a
//! self-hosted server is fixed in the machine's trust store, not by a checkbox.

use std::time::Duration;

use reqwest::{Method, StatusCode, Url};
use roxmltree::Document;

use crate::schema::caldav::{CalDavChanges, CalDavCollection, CalDavResource};

// ── Namespaces ──────────────────────────────────────────────────────────────

pub const NS_DAV: &str = "DAV:";
pub const NS_CALDAV: &str = "urn:ietf:params:xml:ns:caldav";
/// `getctag` — Apple's calendar-server extension. Unstandardized and universal:
/// the cheap "did anything in this collection change" string every server that
/// predates RFC 6578 still answers with.
pub const NS_CALSERVER: &str = "http://calendarserver.org/ns/";
/// `calendar-color` — the other de-facto Apple property.
pub const NS_APPLE: &str = "http://apple.com/ns/ical/";

// ── Limits ──────────────────────────────────────────────────────────────────

/// One request's whole lifetime. Generous because a first `calendar-query` over
/// a decade of events on a slow institutional server is a real wait, bounded
/// because a scheduled sync must not be able to pile up forever.
const CALDAV_TIMEOUT: Duration = Duration::from_secs(45);

/// Largest response body read. A year of a busy calendar is a few hundred KB;
/// this is generous while still bounding what an unattended sync can pull into
/// memory.
const MAX_BODY: usize = 32 * 1024 * 1024;

/// Redirect hops followed. `.well-known/caldav` bouncing to the real base path
/// is normal and expected — a chain longer than this is a misconfiguration.
const MAX_REDIRECTS: usize = 5;

/// `calendar-multiget` batch size, so a collection with thousands of changed
/// resources does not become one enormous request body.
const MULTIGET_CHUNK: usize = 50;

const USER_AGENT: &str = "Eldrun-CalDAV/1.0";

// ── Credentials ─────────────────────────────────────────────────────────────

/// A CalDAV login. Basic Auth over TLS is what nearly every non-SSO CalDAV
/// endpoint speaks; increasingly the password is an app-specific one minted in
/// the provider's own settings rather than the account's primary password (the
/// setup dialog says so without assuming it).
#[derive(Clone)]
pub struct Credentials {
    pub user: String,
    pub password: String,
}

impl std::fmt::Debug for Credentials {
    /// Never print the password. A `{:?}` in an error path is how a secret ends
    /// up in a log file.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("user", &self.user)
            .field("password", &"<redacted>")
            .finish()
    }
}

// ── Multistatus parsing ─────────────────────────────────────────────────────

/// One element child of a property value, with its `name` attribute if it has
/// one. Enough for both shapes that matter: `<d:resourcetype><c:calendar/></…>`
/// (the element's identity is the answer) and
/// `<c:supported-calendar-component-set><c:comp name="VEVENT"/></…>` (the
/// attribute is).
#[derive(Debug, Clone, PartialEq)]
pub struct DavChild {
    pub ns: String,
    pub name: String,
    pub attr_name: Option<String>,
}

/// One `DAV:prop` child that came back with a 2xx propstat.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DavProp {
    pub ns: String,
    pub name: String,
    /// Trimmed text content — empty for a structural property.
    pub text: String,
    /// Every `DAV:href` underneath, in document order.
    pub hrefs: Vec<String>,
    pub children: Vec<DavChild>,
    /// `(ns, name)` of **every** element underneath, at any depth. The one
    /// property that needs it is `current-user-privilege-set`, whose answer is
    /// two levels down (`<d:privilege><d:write-content/></d:privilege>`).
    pub descendants: Vec<(String, String)>,
}

/// One `DAV:response`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DavResponse {
    pub href: String,
    /// The response-level status, when there is one instead of propstats. This
    /// is how RFC 6578 reports a **deletion**: a bare `<d:response>` with the
    /// href and a `404`.
    pub status: Option<u16>,
    /// Properties from **2xx propstats only**. A `404` propstat means "this
    /// server does not have that property", which is a normal answer to asking
    /// for `getctag` and `sync-token` in one request, not an error.
    pub props: Vec<DavProp>,
}

impl DavResponse {
    pub fn prop(&self, ns: &str, name: &str) -> Option<&DavProp> {
        self.props.iter().find(|p| p.ns == ns && p.name == name)
    }

    pub fn text(&self, ns: &str, name: &str) -> Option<&str> {
        self.prop(ns, name)
            .map(|p| p.text.as_str())
            .filter(|t| !t.is_empty())
    }

    /// The first `DAV:href` inside the named property.
    pub fn href_in(&self, ns: &str, name: &str) -> Option<&str> {
        self.prop(ns, name)?.hrefs.first().map(|h| h.as_str())
    }

    /// A `DAV:resourcetype` naming `CALDAV:calendar` — i.e. an actual calendar
    /// collection rather than the home set, a principal, or a subscription.
    pub fn is_calendar(&self) -> bool {
        self.prop(NS_DAV, "resourcetype").is_some_and(|p| {
            p.children
                .iter()
                .any(|c| c.ns == NS_CALDAV && c.name == "calendar")
        })
    }

    /// The resource is gone (RFC 6578's deletion stub).
    pub fn deleted(&self) -> bool {
        matches!(self.status, Some(404) | Some(410))
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Multistatus {
    pub responses: Vec<DavResponse>,
    /// `sync-collection`'s answer: the token to send next time.
    pub sync_token: Option<String>,
}

/// `HTTP/1.1 207 Multi-Status` → the status code alone.
fn status_code(line: &str) -> Option<u16> {
    line.split_whitespace()
        .find_map(|part| part.parse::<u16>().ok().filter(|c| (100..600).contains(c)))
}

fn is(node: &roxmltree::Node, ns: &str, name: &str) -> bool {
    node.tag_name().name() == name && node.tag_name().namespace().unwrap_or("") == ns
}

/// Collect every `DAV:href` text underneath `node`, at any depth.
fn hrefs_under(node: roxmltree::Node) -> Vec<String> {
    node.descendants()
        .filter(|n| n.is_element() && is(n, NS_DAV, "href"))
        .filter_map(|n| n.text().map(|t| t.trim().to_string()))
        .filter(|t| !t.is_empty())
        .collect()
}

/// Parse a WebDAV `multistatus` document.
///
/// Tolerant on purpose: an unknown property, an unknown namespace, a `404`
/// propstat and a response with no propstat at all are all things real servers
/// send, and none of them is a reason to fail the whole sync. What *is* an
/// error is a body that is not a multistatus at all — that is the shape a login
/// page or an error page takes, and importing zero events silently is exactly
/// the failure `fetch_ics`'s own `BEGIN:VCALENDAR` check exists to prevent.
pub fn parse_multistatus(xml: &str) -> Result<Multistatus, String> {
    let doc = Document::parse_with_options(
        xml,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            ..Default::default()
        },
    )
    .map_err(|e| format!("the server's reply is not valid XML: {e}"))?;

    let root = doc.root_element();
    if !is(&root, NS_DAV, "multistatus") {
        return Err(format!(
            "the server answered with <{}>, not a WebDAV multistatus — is this a CalDAV URL?",
            root.tag_name().name()
        ));
    }

    let mut out = Multistatus::default();
    for child in root.children().filter(|n| n.is_element()) {
        if is(&child, NS_DAV, "sync-token") {
            out.sync_token = child.text().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
            continue;
        }
        if !is(&child, NS_DAV, "response") {
            continue;
        }

        let mut resp = DavResponse::default();
        for part in child.children().filter(|n| n.is_element()) {
            if is(&part, NS_DAV, "href") {
                if resp.href.is_empty() {
                    resp.href = part.text().unwrap_or("").trim().to_string();
                }
            } else if is(&part, NS_DAV, "status") {
                resp.status = part.text().and_then(status_code);
            } else if is(&part, NS_DAV, "propstat") {
                let ok = part
                    .children()
                    .filter(|n| n.is_element() && is(n, NS_DAV, "status"))
                    .filter_map(|n| n.text().and_then(status_code))
                    .all(|code| (200..300).contains(&code));
                if !ok {
                    continue;
                }
                for prop in part
                    .children()
                    .filter(|n| n.is_element() && is(n, NS_DAV, "prop"))
                {
                    for value in prop.children().filter(|n| n.is_element()) {
                        resp.props.push(DavProp {
                            ns: value.tag_name().namespace().unwrap_or("").to_string(),
                            name: value.tag_name().name().to_string(),
                            // `text()` is the first text node; a property whose
                            // value is split by a comment or a child element
                            // needs every one of them (`calendar-data` is a
                            // whole iCalendar document and CDATA-splits do
                            // happen), so the descendants are joined.
                            text: value
                                .descendants()
                                .filter(|n| n.is_text())
                                .filter_map(|n| n.text())
                                .collect::<String>()
                                .trim()
                                .to_string(),
                            hrefs: hrefs_under(value),
                            children: value
                                .children()
                                .filter(|n| n.is_element())
                                .map(|c| DavChild {
                                    ns: c.tag_name().namespace().unwrap_or("").to_string(),
                                    name: c.tag_name().name().to_string(),
                                    attr_name: c.attribute("name").map(|a| a.to_string()),
                                })
                                .collect(),
                            descendants: value
                                .descendants()
                                .filter(|n| n.is_element() && *n != value)
                                .map(|c| {
                                    (
                                        c.tag_name().namespace().unwrap_or("").to_string(),
                                        c.tag_name().name().to_string(),
                                    )
                                })
                                .collect(),
                        });
                    }
                }
            }
        }
        if !resp.href.is_empty() || resp.status.is_some() {
            out.responses.push(resp);
        }
    }
    Ok(out)
}

// ── Request bodies ──────────────────────────────────────────────────────────
//
// Six fixed shapes. Everything variable in them is either a URL the server
// itself handed us or a token the server itself minted — both go through
// `xml_escape` anyway, because "the server would never" is not a parser.

/// Escape text for an XML text node. Attributes are never templated here.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

const XML_DECL: &str = r#"<?xml version="1.0" encoding="utf-8"?>"#;

pub fn body_current_user_principal() -> String {
    format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#
    )
}

pub fn body_calendar_home_set() -> String {
    format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:" xmlns:c="{NS_CALDAV}"><d:prop><c:calendar-home-set/></d:prop></d:propfind>"#
    )
}

/// The collection-listing `PROPFIND`.
///
/// One request for everything a collection row needs. A server that does not
/// have `getctag` or `sync-token` answers those in a `404` propstat and the
/// rest in a `200` one, which the parser already handles — that is why they can
/// share a request instead of costing a round trip each.
pub fn body_collection_props() -> String {
    format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:" xmlns:c="{NS_CALDAV}" xmlns:cs="{NS_CALSERVER}" xmlns:ical="{NS_APPLE}">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-privilege-set/>
    <c:supported-calendar-component-set/>
    <ical:calendar-color/>
    <cs:getctag/>
    <d:sync-token/>
  </d:prop>
</d:propfind>"#
    )
}

/// The fallback listing body for a server that refuses the full property set.
///
/// SOGo in particular is known to be picky about exactly which properties a
/// `PROPFIND` names, and a whole discovery that fails because one optional
/// property was asked for is a feature that does not work for a reason nobody
/// can see. Two properties, both required by RFC 4918 itself.
pub fn body_collection_props_minimal() -> String {
    format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>"#
    )
}

/// `getctag` + `sync-token` alone — the cheap "is it worth doing the expensive
/// read" check a scheduled sync makes before every full fetch.
pub fn body_change_tokens() -> String {
    format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:" xmlns:cs="{NS_CALSERVER}"><d:prop><cs:getctag/><d:sync-token/></d:prop></d:propfind>"#
    )
}

/// `calendar-query` for one component type.
///
/// One request per type rather than two `comp-filter` siblings: how a server
/// combines sibling filters is under-specified enough that real clients issue
/// them separately, and a filter silently read as AND returns nothing at all —
/// which looks exactly like an empty calendar.
pub fn body_calendar_query(component: &str) -> String {
    let component = xml_escape(component);
    format!(
        r#"{XML_DECL}
<c:calendar-query xmlns:d="DAV:" xmlns:c="{NS_CALDAV}">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="{component}"/></c:comp-filter></c:filter>
</c:calendar-query>"#
    )
}

pub fn body_multiget(hrefs: &[String]) -> String {
    let hrefs: String = hrefs
        .iter()
        .map(|h| format!("  <d:href>{}</d:href>\n", xml_escape(h)))
        .collect();
    format!(
        r#"{XML_DECL}
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="{NS_CALDAV}">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
{hrefs}</c:calendar-multiget>"#
    )
}

/// RFC 6578's incremental report. An **empty** `sync-token` element is the
/// spec's "I have nothing, send me everything (and a token)".
pub fn body_sync_collection(token: &str) -> String {
    let token = xml_escape(token);
    format!(
        r#"{XML_DECL}
<d:sync-collection xmlns:d="DAV:" xmlns:c="{NS_CALDAV}">
  <d:sync-token>{token}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
</d:sync-collection>"#
    )
}

// ── HTTP ────────────────────────────────────────────────────────────────────

fn method(name: &str) -> Method {
    Method::from_bytes(name.as_bytes()).expect("static WebDAV method name")
}

/// Build the CalDAV client.
///
/// `install_crypto_provider()` for the reason `browser_engine::reader_client`
/// states: `reqwest` is compiled with `rustls-no-provider`, and rustls 0.23
/// **panics** rather than erroring when no process-default provider is
/// installed — which would happen on a user's machine, inside a command, the
/// first time they synced.
///
/// No cookie store, no `Referer`, and **no redirect policy of its own**: hops
/// are followed by [`dav_request`] so the cap is ours and the method survives
/// (reqwest would turn a `PROPFIND` into a `GET` on a 302, which answers a
/// question nobody asked).
fn client() -> Result<reqwest::Client, String> {
    crate::services::mail_engine::install_crypto_provider();
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(CALDAV_TIMEOUT)
        .referer(false)
        .build()
        .map_err(|e| format!("caldav-client: {e}"))
}

/// The URL a user typed, made into something joinable.
///
/// A bare host (`cal.example.org`) gets `https://` — never `http://`: this
/// carries a password on every request, and silently downgrading the one
/// transport protecting it is the kind of "helpful" default that makes a
/// feature worse than not having it. An explicit `http://` the user typed
/// themselves is honoured (that is the self-hosted-on-localhost case) and the
/// dialog warns about it.
pub fn normalize_base_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("no server URL".to_string());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = Url::parse(&with_scheme).map_err(|e| format!("not a usable URL: {e}"))?;
    match url.scheme() {
        "https" | "http" => Ok(url),
        other => Err(format!("unsupported URL scheme '{other}' — CalDAV is HTTP(S)")),
    }
}

/// One WebDAV request, following redirects ourselves up to [`MAX_REDIRECTS`].
///
/// Returns `(status, body, final_url)`. A non-2xx is **not** an error here: a
/// `404` on `.well-known/caldav` is an ordinary step in discovery, and a `403`
/// on `sync-collection` is the documented way a server says "use a full query
/// instead". Callers decide which ones mean failure.
async fn dav_request(
    client: &reqwest::Client,
    method_name: &str,
    url: &Url,
    cred: &Credentials,
    depth: Option<&str>,
    body: Option<String>,
) -> Result<(StatusCode, String, Url), String> {
    let mut url = url.clone();
    for _ in 0..=MAX_REDIRECTS {
        let mut req = client
            .request(method(method_name), url.clone())
            .basic_auth(&cred.user, Some(&cred.password));
        if let Some(depth) = depth {
            req = req.header("Depth", depth);
        }
        if let Some(body) = body.clone() {
            req = req
                .header("Content-Type", "application/xml; charset=utf-8")
                .body(body);
        }

        let resp = req.send().await.map_err(|e| {
            // `reqwest`'s Display walks the source chain and can print the URL,
            // which never carries the password (it is a header) — but the host
            // is enough context on its own.
            format!("could not reach {}: {e}", url.host_str().unwrap_or("the server"))
        })?;
        let status = resp.status();

        if status.is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            match location {
                Some(loc) => {
                    let next = url
                        .join(&loc)
                        .map_err(|e| format!("the server redirected somewhere unusable: {e}"))?;
                    if next == url {
                        return Err("the server redirected to the same URL".to_string());
                    }
                    url = next;
                    continue;
                }
                // A redirect with no Location is a broken server, not a hop.
                None => return Ok((status, String::new(), url)),
            }
        }

        if status == StatusCode::UNAUTHORIZED {
            return Err(
                "the server rejected the username or password (401). Some CalDAV servers want an \
                 app-specific password rather than your normal one — check your provider's \
                 account settings."
                    .to_string(),
            );
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("the reply could not be read: {e}"))?;
        if bytes.len() > MAX_BODY {
            return Err(format!(
                "the server's reply is too large ({} bytes; limit {MAX_BODY})",
                bytes.len()
            ));
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        return Ok((status, text, url));
    }
    Err("too many redirects".to_string())
}

/// A 2xx/207 body, or a described failure. The status text is included because
/// "sync failed" with no number is a bug report nobody can act on.
fn require_ok(status: StatusCode, body: String, what: &str) -> Result<String, String> {
    if status.is_success() {
        return Ok(body);
    }
    Err(format!("{what} failed: HTTP {}", status.as_u16()))
}

/// Resolve an href the server handed back against the URL it came from, and
/// keep it **absolute**.
///
/// The absolute form is the stable key `caldav_href` stores: servers answer
/// with path-only hrefs, and a path alone stops identifying anything the moment
/// a second account on a second host is added.
fn absolute(base: &Url, href: &str) -> Option<String> {
    base.join(href).ok().map(|u| u.to_string())
}

// ── Discovery ───────────────────────────────────────────────────────────────

/// Read one collection response into a [`CalDavCollection`].
fn collection_from(base: &Url, resp: &DavResponse) -> Option<CalDavCollection> {
    let href = absolute(base, &resp.href)?;
    let components: Vec<String> = resp
        .prop(NS_CALDAV, "supported-calendar-component-set")
        .map(|p| {
            p.children
                .iter()
                .filter(|c| c.name == "comp")
                .filter_map(|c| c.attr_name.clone())
                .collect()
        })
        .unwrap_or_default();
    // Privileges are advisory in this phase (every subscribed collection is
    // read-only here regardless) and load-bearing in Phase 3: a collection
    // someone else shared with you is legitimately read-only *to you*, and that
    // is a fact to ask the server for rather than infer from "push shipped".
    //
    // A server that does not report the property at all leaves this `false` — an
    // unasserted unknown rather than a claim in either direction. The write
    // privileges are named at RFC 3744 §3: `write` implies the others, and
    // `write-content`/`bind` are what a calendar collection actually grants.
    let read_only = resp
        .prop(NS_DAV, "current-user-privilege-set")
        .map(|p| {
            !p.descendants
                .iter()
                .any(|(ns, name)| ns == NS_DAV && matches!(name.as_str(), "write" | "write-content" | "bind"))
        })
        .unwrap_or(false);
    Some(CalDavCollection {
        href,
        display_name: resp
            .text(NS_DAV, "displayname")
            .unwrap_or_default()
            .to_string(),
        color: resp
            .text(NS_APPLE, "calendar-color")
            .unwrap_or_default()
            .to_string(),
        ctag: resp
            .text(NS_CALSERVER, "getctag")
            .unwrap_or_default()
            .to_string(),
        sync_token: resp.text(NS_DAV, "sync-token").map(|s| s.to_string()),
        components,
        read_only,
    })
}

/// `PROPFIND Depth: 1` a collection home and keep the calendar collections.
async fn list_collections(
    client: &reqwest::Client,
    url: &Url,
    cred: &Credentials,
) -> Result<Vec<CalDavCollection>, String> {
    let (status, body, final_url) = dav_request(
        client,
        "PROPFIND",
        url,
        cred,
        Some("1"),
        Some(body_collection_props()),
    )
    .await?;

    // A server that refused the full property set gets one more chance with the
    // two properties RFC 4918 requires of everyone.
    let (body, final_url) = if status.is_success() {
        (body, final_url)
    } else {
        let (status, body, final_url) = dav_request(
            client,
            "PROPFIND",
            url,
            cred,
            Some("1"),
            Some(body_collection_props_minimal()),
        )
        .await?;
        (require_ok(status, body, "listing calendars")?, final_url)
    };

    let parsed = parse_multistatus(&body)?;
    Ok(parsed
        .responses
        .iter()
        .filter(|r| r.is_calendar())
        .filter_map(|r| collection_from(&final_url, r))
        .collect())
}

/// The discovery chain: whatever the user pasted → the calendar collections
/// they can subscribe to.
///
/// Ordered by how likely each step is to be the whole answer, because most
/// manual setups paste a collection URL directly (which is what every desktop
/// client's manual path actually does in practice):
///
/// 1. `PROPFIND Depth: 0` on the URL itself. If it *is* a calendar collection,
///    that is the answer and nothing else runs.
/// 2. If that response carries `calendar-home-set`, list it.
/// 3. If it carries `current-user-principal`, `PROPFIND` that for the home set,
///    then list it.
/// 4. Failing all of the above, `PROPFIND /.well-known/caldav` on the origin
///    (a redirect to the real base path is normal) and try 1–3 again there.
pub async fn discover(base_url: &str, cred: &Credentials) -> Result<Vec<CalDavCollection>, String> {
    let url = normalize_base_url(base_url)?;
    let client = client()?;

    if let Some(found) = discover_from(&client, &url, cred).await? {
        return Ok(found);
    }

    // `.well-known` is only meaningful on the origin, and only worth trying
    // when it is not where we already looked.
    let well_known = url
        .join("/.well-known/caldav")
        .map_err(|e| format!("not a usable URL: {e}"))?;
    if well_known != url {
        if let Some(found) = discover_from(&client, &well_known, cred).await? {
            return Ok(found);
        }
    }

    Err("no calendars found there — check the URL, or paste the address of the calendar \
         collection itself (your provider's CalDAV documentation usually gives one)"
        .to_string())
}

/// Steps 1–3 of [`discover`] against one URL. `Ok(None)` means "nothing here",
/// which is a reason to try the next URL rather than to fail.
async fn discover_from(
    client: &reqwest::Client,
    url: &Url,
    cred: &Credentials,
) -> Result<Option<Vec<CalDavCollection>>, String> {
    let (status, body, final_url) = dav_request(
        client,
        "PROPFIND",
        url,
        cred,
        Some("0"),
        Some(body_probe()),
    )
    .await?;
    if !status.is_success() {
        return Ok(None);
    }
    let parsed = parse_multistatus(&body)?;
    let Some(resp) = parsed.responses.first() else {
        return Ok(None);
    };

    // 1. The URL is itself a calendar. Its Depth-0 response already carries
    //    everything the row needs.
    if resp.is_calendar() {
        if let Some(one) = collection_from(&final_url, resp) {
            return Ok(Some(vec![one]));
        }
    }

    // 2. A calendar home set, named right here.
    if let Some(home) = resp.href_in(NS_CALDAV, "calendar-home-set") {
        if let Some(home) = absolute(&final_url, home).and_then(|h| Url::parse(&h).ok()) {
            let found = list_collections(client, &home, cred).await?;
            if !found.is_empty() {
                return Ok(Some(found));
            }
        }
    }

    // 3. A principal, whose home set is one more round trip away.
    if let Some(principal) = resp.href_in(NS_DAV, "current-user-principal") {
        if let Some(principal) = absolute(&final_url, principal).and_then(|h| Url::parse(&h).ok()) {
            let (status, body, principal_url) = dav_request(
                client,
                "PROPFIND",
                &principal,
                cred,
                Some("0"),
                Some(body_calendar_home_set()),
            )
            .await?;
            if status.is_success() {
                let parsed = parse_multistatus(&body)?;
                if let Some(home) = parsed
                    .responses
                    .first()
                    .and_then(|r| r.href_in(NS_CALDAV, "calendar-home-set"))
                    .and_then(|h| absolute(&principal_url, h))
                    .and_then(|h| Url::parse(&h).ok())
                {
                    let found = list_collections(client, &home, cred).await?;
                    if !found.is_empty() {
                        return Ok(Some(found));
                    }
                }
            }
        }
    }

    Ok(None)
}

/// The Depth-0 probe body: "are you a calendar, and if not, where do I go next".
/// One request instead of three, because all three answers are properties.
fn body_probe() -> String {
    format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:" xmlns:c="{NS_CALDAV}" xmlns:cs="{NS_CALSERVER}" xmlns:ical="{NS_APPLE}">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-principal/>
    <c:calendar-home-set/>
    <c:supported-calendar-component-set/>
    <ical:calendar-color/>
    <cs:getctag/>
    <d:sync-token/>
  </d:prop>
</d:propfind>"#
    )
}

// ── Change detection and fetching ───────────────────────────────────────────

/// The collection's current change tokens: `(ctag, sync_token)`.
///
/// The cheap half of a scheduled sync. An unchanged ctag means the expensive
/// `calendar-query` can be skipped entirely — which is the difference between a
/// background timer that costs one small request every few minutes and one that
/// re-downloads a whole calendar.
pub async fn change_tokens(
    href: &str,
    cred: &Credentials,
) -> Result<(String, Option<String>), String> {
    let url = Url::parse(href).map_err(|e| format!("not a usable calendar URL: {e}"))?;
    let client = client()?;
    let (status, body, _) = dav_request(
        &client,
        "PROPFIND",
        &url,
        cred,
        Some("0"),
        Some(body_change_tokens()),
    )
    .await?;
    let body = require_ok(status, body, "checking the calendar for changes")?;
    let parsed = parse_multistatus(&body)?;
    let resp = parsed
        .responses
        .first()
        .ok_or_else(|| "the server answered with an empty multistatus".to_string())?;
    Ok((
        resp.text(NS_CALSERVER, "getctag").unwrap_or_default().to_string(),
        resp.text(NS_DAV, "sync-token").map(|s| s.to_string()),
    ))
}

/// Turn a multistatus into resources and deletions.
fn changes_from(base: &Url, parsed: &Multistatus, incremental: bool) -> CalDavChanges {
    let mut resources = Vec::new();
    let mut removed = Vec::new();
    for resp in &parsed.responses {
        let Some(href) = absolute(base, &resp.href) else {
            continue;
        };
        if resp.deleted() {
            removed.push(href);
            continue;
        }
        // The collection itself comes back in its own report; it is not a
        // resource and has no calendar data.
        let etag = resp.text(NS_DAV, "getetag").unwrap_or_default().to_string();
        let data = resp
            .text(NS_CALDAV, "calendar-data")
            .unwrap_or_default()
            .to_string();
        if etag.is_empty() && data.is_empty() {
            continue;
        }
        resources.push(CalDavResource { href, etag, data });
    }
    CalDavChanges {
        resources,
        removed,
        sync_token: parsed.sync_token.clone(),
        ctag: String::new(),
        incremental,
        unchanged: false,
    }
}

/// Fetch resources whose data did not ride along with their etag.
///
/// `sync-collection` is allowed to answer with etags only, and several servers
/// do. Without this pass those resources would look like "changed, but empty",
/// and an empty `calendar-data` parses to zero events — i.e. a change would
/// quietly blank a row instead of updating it.
async fn fill_missing_data(
    client: &reqwest::Client,
    collection: &Url,
    cred: &Credentials,
    changes: &mut CalDavChanges,
) -> Result<(), String> {
    let missing: Vec<String> = changes
        .resources
        .iter()
        .filter(|r| r.data.trim().is_empty())
        .map(|r| r.href.clone())
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    for chunk in missing.chunks(MULTIGET_CHUNK) {
        let (status, body, _) = dav_request(
            client,
            "REPORT",
            collection,
            cred,
            Some("1"),
            Some(body_multiget(&chunk.to_vec())),
        )
        .await?;
        let body = require_ok(status, body, "fetching changed events")?;
        let parsed = parse_multistatus(&body)?;
        let fetched = changes_from(collection, &parsed, true);
        for got in fetched.resources {
            if let Some(slot) = changes.resources.iter_mut().find(|r| r.href == got.href) {
                if !got.data.trim().is_empty() {
                    slot.data = got.data;
                    if !got.etag.is_empty() {
                        slot.etag = got.etag;
                    }
                }
            }
        }
        // A resource the multiget reports as gone really is gone.
        for href in fetched.removed {
            changes.resources.retain(|r| r.href != href);
            if !changes.removed.contains(&href) {
                changes.removed.push(href);
            }
        }
    }
    Ok(())
}

/// Everything in the collection, via `calendar-query` — one report per
/// component type the collection holds.
///
/// `components` empty means "the server did not say", in which case both are
/// asked for: a collection that holds no VTODOs answers the VTODO query with an
/// empty multistatus, which costs one round trip and never lies.
pub async fn fetch_all(
    href: &str,
    cred: &Credentials,
    components: &[String],
) -> Result<CalDavChanges, String> {
    let url = Url::parse(href).map_err(|e| format!("not a usable calendar URL: {e}"))?;
    let client = client()?;

    let wanted: Vec<&str> = if components.is_empty() {
        vec!["VEVENT", "VTODO"]
    } else {
        components
            .iter()
            .map(|c| c.as_str())
            .filter(|c| matches!(*c, "VEVENT" | "VTODO"))
            .collect()
    };

    let mut out = CalDavChanges {
        incremental: false,
        ..Default::default()
    };
    for component in wanted {
        let (status, body, final_url) = dav_request(
            &client,
            "REPORT",
            &url,
            cred,
            Some("1"),
            Some(body_calendar_query(component)),
        )
        .await?;
        let body = require_ok(status, body, "reading the calendar")?;
        let parsed = parse_multistatus(&body)?;
        let mut got = changes_from(&final_url, &parsed, false);
        out.resources.append(&mut got.resources);
    }

    fill_missing_data(&client, &url, cred, &mut out).await?;
    // The token to hand back next time comes from the collection itself: a
    // `calendar-query` does not mint one.
    let (ctag, sync_token) = change_tokens(href, cred).await.unwrap_or_default();
    out.ctag = ctag;
    out.sync_token = sync_token;
    Ok(out)
}

/// RFC 6578's incremental report: only what changed since `token`, plus
/// deletions as `404` stubs.
///
/// A server that does not implement it, or one that has expired the token,
/// answers `403`/`409` with a `valid-sync-token` precondition — both are
/// reported as `Err`, and the caller's answer to that is a full [`fetch_all`],
/// which is the fallback every pre-RFC-6578 server has always been on.
pub async fn fetch_changes(
    href: &str,
    cred: &Credentials,
    token: &str,
) -> Result<CalDavChanges, String> {
    let url = Url::parse(href).map_err(|e| format!("not a usable calendar URL: {e}"))?;
    let client = client()?;
    let (status, body, final_url) = dav_request(
        &client,
        "REPORT",
        &url,
        cred,
        Some("1"),
        Some(body_sync_collection(token)),
    )
    .await?;
    let body = require_ok(status, body, "reading the calendar's changes")?;
    let parsed = parse_multistatus(&body)?;
    let mut out = changes_from(&final_url, &parsed, true);
    if out.sync_token.is_none() {
        return Err("the server's incremental sync reply carried no token".to_string());
    }
    fill_missing_data(&client, &url, cred, &mut out).await?;
    let (ctag, _) = change_tokens(href, cred).await.unwrap_or_default();
    out.ctag = ctag;
    Ok(out)
}

// ── Tests ───────────────────────────────────────────────────────────────────
//
// Fixtures, no live server — the posture `mail_authres`/`mail_engine`'s parsers
// already take, and the only honest one for a protocol whose real-world
// counterparties are an institutional groupware server and a self-hosted
// Radicale. Bodies below are RFC 4791/6578's own worked examples, trimmed, plus
// the shapes real servers add (Apple's `getctag`, SOGo's namespace-prefix
// choices, a Radicale-style path-only href).

#[cfg(test)]
mod tests {
    use super::*;

    const HOME_LISTING: &str = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"
               xmlns:CS="http://calendarserver.org/ns/"
               xmlns:IC="http://apple.com/ns/ical/">
  <D:response>
    <D:href>/calendars/user/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype><D:displayname>Home</D:displayname></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/calendars/user/personal/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Personal</D:displayname>
        <IC:calendar-color>#4aa3dfff</IC:calendar-color>
        <CS:getctag>ctag-42</CS:getctag>
        <C:supported-calendar-component-set>
          <C:comp name="VEVENT"/><C:comp name="VTODO"/>
        </C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop><D:sync-token/></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    #[test]
    fn parses_a_home_listing_and_keeps_only_calendars() {
        let base = Url::parse("https://dav.example.org/calendars/user/").unwrap();
        let parsed = parse_multistatus(HOME_LISTING).unwrap();
        assert_eq!(parsed.responses.len(), 2);

        let calendars: Vec<CalDavCollection> = parsed
            .responses
            .iter()
            .filter(|r| r.is_calendar())
            .filter_map(|r| collection_from(&base, r))
            .collect();
        assert_eq!(calendars.len(), 1, "the home collection itself is not a calendar");
        let cal = &calendars[0];
        assert_eq!(cal.href, "https://dav.example.org/calendars/user/personal/");
        assert_eq!(cal.display_name, "Personal");
        assert_eq!(cal.color, "#4aa3dfff");
        assert_eq!(cal.ctag, "ctag-42");
        assert_eq!(cal.components, vec!["VEVENT", "VTODO"]);
    }

    #[test]
    fn a_404_propstat_is_an_absent_property_not_a_failure() {
        let parsed = parse_multistatus(HOME_LISTING).unwrap();
        let cal = parsed.responses.iter().find(|r| r.is_calendar()).unwrap();
        assert!(
            cal.text(NS_DAV, "sync-token").is_none(),
            "a property answered 404 must not be read as present-and-empty"
        );
        assert_eq!(cal.text(NS_CALSERVER, "getctag"), Some("ctag-42"));
    }

    #[test]
    fn privileges_decide_read_only_and_silence_asserts_nothing() {
        let shared = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/calendars/other/shared/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:current-user-privilege-set>
          <D:privilege><D:read/></D:privilege>
        </D:current-user-privilege-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let base = Url::parse("https://dav.example.org/").unwrap();
        let parsed = parse_multistatus(shared).unwrap();
        let cal = collection_from(&base, &parsed.responses[0]).unwrap();
        assert!(cal.read_only, "read-only privileges are a fact the server stated");

        // A server that reports no privileges at all asserts nothing — the
        // field stays false rather than claiming writability either way.
        let silent = parse_multistatus(HOME_LISTING).unwrap();
        let cal = silent
            .responses
            .iter()
            .find(|r| r.is_calendar())
            .and_then(|r| collection_from(&base, r))
            .unwrap();
        assert!(!cal.read_only);
    }

    #[test]
    fn a_writable_collection_is_not_flagged_read_only() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/calendars/me/personal/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:current-user-privilege-set>
          <D:privilege><D:read/></D:privilege>
          <D:privilege><D:write-content/></D:privilege>
          <D:privilege><D:bind/></D:privilege>
        </D:current-user-privilege-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let base = Url::parse("https://dav.example.org/").unwrap();
        let parsed = parse_multistatus(xml).unwrap();
        assert!(!collection_from(&base, &parsed.responses[0]).unwrap().read_only);
    }

    #[test]
    fn parses_a_calendar_query_report_with_inline_data() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/user/personal/abc.ics</href>
    <propstat>
      <prop>
        <getetag>"etag-1"</getetag>
        <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:abc
DTSTART:20260708T090000Z
SUMMARY:standup
END:VEVENT
END:VCALENDAR
</c:calendar-data>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>"#;
        let base = Url::parse("https://dav.example.org/calendars/user/personal/").unwrap();
        let parsed = parse_multistatus(xml).unwrap();
        let changes = changes_from(&base, &parsed, false);
        assert_eq!(changes.resources.len(), 1);
        let res = &changes.resources[0];
        assert_eq!(
            res.href,
            "https://dav.example.org/calendars/user/personal/abc.ics"
        );
        assert_eq!(res.etag, "\"etag-1\"");
        assert!(res.data.starts_with("BEGIN:VCALENDAR"));
        assert!(res.data.contains("SUMMARY:standup"));
        assert!(changes.removed.is_empty());
    }

    #[test]
    fn sync_collection_reports_deletions_as_404_stubs() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/cal/kept.ics</D:href>
    <D:propstat>
      <D:prop><D:getetag>"e2"</D:getetag><C:calendar-data>BEGIN:VCALENDAR
END:VCALENDAR</C:calendar-data></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/cal/gone.ics</D:href>
    <D:status>HTTP/1.1 404 Not Found</D:status>
  </D:response>
  <D:sync-token>http://example.com/sync/2</D:sync-token>
</D:multistatus>"#;
        let base = Url::parse("https://dav.example.org/cal/").unwrap();
        let parsed = parse_multistatus(xml).unwrap();
        assert_eq!(parsed.sync_token.as_deref(), Some("http://example.com/sync/2"));
        let changes = changes_from(&base, &parsed, true);
        assert_eq!(changes.resources.len(), 1);
        assert_eq!(changes.resources[0].href, "https://dav.example.org/cal/kept.ics");
        assert_eq!(changes.removed, vec!["https://dav.example.org/cal/gone.ics"]);
        assert!(changes.incremental);
    }

    #[test]
    fn an_etag_without_data_is_kept_for_the_multiget_pass() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/cal/one.ics</D:href>
    <D:propstat><D:prop><D:getetag>"e"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>"#;
        let base = Url::parse("https://dav.example.org/cal/").unwrap();
        let changes = changes_from(&base, &parse_multistatus(xml).unwrap(), true);
        assert_eq!(changes.resources.len(), 1);
        assert!(
            changes.resources[0].data.is_empty(),
            "an empty body must survive to the multiget pass, not be dropped"
        );
    }

    #[test]
    fn the_principal_and_home_set_chain_reads_hrefs() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/</d:href>
    <d:propstat>
      <d:prop><d:current-user-principal><d:href>/principals/users/me/</d:href></d:current-user-principal></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>"#;
        let parsed = parse_multistatus(xml).unwrap();
        let resp = parsed.responses.first().unwrap();
        assert_eq!(
            resp.href_in(NS_DAV, "current-user-principal"),
            Some("/principals/users/me/")
        );
        let base = Url::parse("https://dav.example.org/").unwrap();
        assert_eq!(
            absolute(&base, resp.href_in(NS_DAV, "current-user-principal").unwrap()).as_deref(),
            Some("https://dav.example.org/principals/users/me/")
        );
    }

    #[test]
    fn a_login_page_is_an_error_not_an_empty_calendar() {
        // The failure this check exists for: an expired session or an SSO
        // redirect answers 200 with HTML, and "parsed zero events" is
        // indistinguishable from a calendar that is genuinely empty.
        let err = parse_multistatus("<html><body>Please log in</body></html>").unwrap_err();
        assert!(err.contains("multistatus"), "{err}");
    }

    #[test]
    fn a_non_xml_body_fails_loudly() {
        assert!(parse_multistatus("not xml at all").is_err());
    }

    #[test]
    fn request_bodies_are_well_formed_xml() {
        for body in [
            body_current_user_principal(),
            body_calendar_home_set(),
            body_collection_props(),
            body_collection_props_minimal(),
            body_change_tokens(),
            body_probe(),
            body_calendar_query("VEVENT"),
            body_multiget(&["/cal/a.ics".to_string(), "/cal/b&c.ics".to_string()]),
            body_sync_collection("http://example.com/sync/1"),
        ] {
            Document::parse(&body).unwrap_or_else(|e| panic!("body is not valid XML: {e}\n{body}"));
        }
    }

    #[test]
    fn a_token_with_xml_syntax_in_it_is_escaped() {
        let body = body_sync_collection("tok&<en>");
        assert!(body.contains("tok&amp;&lt;en&gt;"));
        Document::parse(&body).unwrap();
    }

    #[test]
    fn a_bare_host_gets_https_never_http() {
        assert_eq!(
            normalize_base_url("cal.example.org/dav").unwrap().as_str(),
            "https://cal.example.org/dav"
        );
        // An explicit http:// the user typed is honoured — that is the
        // self-hosted-on-localhost case.
        assert_eq!(
            normalize_base_url("http://localhost:5232/").unwrap().as_str(),
            "http://localhost:5232/"
        );
        assert!(normalize_base_url("ftp://example.org").is_err());
        assert!(normalize_base_url("   ").is_err());
    }

    #[test]
    fn status_lines_yield_their_code() {
        assert_eq!(status_code("HTTP/1.1 200 OK"), Some(200));
        assert_eq!(status_code("HTTP/1.1 404 Not Found"), Some(404));
        assert_eq!(status_code("nonsense"), None);
    }

    #[test]
    fn credentials_never_print_the_password() {
        let cred = Credentials {
            user: "someone".into(),
            password: "hunter2".into(),
        };
        let shown = format!("{cred:?}");
        assert!(!shown.contains("hunter2"), "{shown}");
    }

    #[test]
    fn the_client_builds() {
        // Proves the crypto provider is installed before rustls is first used:
        // rustls 0.23 panics rather than erroring when none is, and that panic
        // would happen on a user's machine at their first sync.
        client().unwrap();
    }
}
