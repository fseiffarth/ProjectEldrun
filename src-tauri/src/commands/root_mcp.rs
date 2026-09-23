//! The root console's MCP listener — the `AppHandle` half of
//! `services::root_mcp`, which holds the design and everything testable.
//!
//! One loopback HTTP route, `POST /mcp`, speaking MCP's streamable-HTTP
//! transport in its simplest legal form: one JSON-RPC message in, one JSON
//! reply out (or `202` for a notification). No SSE stream and no session id —
//! every tool is a single read or write of Eldrun's own files, so there is
//! nothing to stream and nothing to remember between calls.

use axum::{
    extract::{State, Request},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::services::root_mcp::{self, Runtime, Stores};
use crate::storage;
use crate::services::root_mcp_security::{self as security, Access, Policy};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use std::pin::Pin;
use std::task::{Context, Poll};
use std::future::Future;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// Bounds sockets as well as requests: idle/slow headers otherwise consume
/// connections before the handler has a chance to authenticate anything.
struct BoundedListener {
    tcp: tokio::net::TcpListener,
    slots: Arc<tokio::sync::Semaphore>,
}
struct BoundedStream {
    tcp: tokio::net::TcpStream,
    _slot: tokio::sync::OwnedSemaphorePermit,
    expires: Pin<Box<tokio::time::Sleep>>,
}
impl axum::serve::Listener for BoundedListener {
    type Io = BoundedStream;
    type Addr = std::net::SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let slot = self.slots.clone().acquire_owned().await.expect("listener semaphore stays open");
            match self.tcp.accept().await {
                Ok((tcp, addr)) => return (BoundedStream { tcp, _slot: slot,
                    expires: Box::pin(tokio::time::sleep(Duration::from_secs(30))) }, addr),
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    }
    fn local_addr(&self) -> std::io::Result<Self::Addr> { self.tcp.local_addr() }
}
impl AsyncRead for BoundedStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        if self.expires.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(std::io::ErrorKind::TimedOut.into()));
        }
        Pin::new(&mut self.tcp).poll_read(cx, buf)
    }
}
impl AsyncWrite for BoundedStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        if self.expires.as_mut().poll(cx).is_ready() { return Poll::Ready(Err(std::io::ErrorKind::TimedOut.into())); }
        Pin::new(&mut self.tcp).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> { Pin::new(&mut self.tcp).poll_flush(cx) }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> { Pin::new(&mut self.tcp).poll_shutdown(cx) }
}

/// The window's cue that a root agent wrote a calendar row. Payload:
/// `services::root_mcp::Change`.
const CHANGED_EVENT: &str = "root-mcp-changed";

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
    port: u16,
}

static REQUESTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
/// How long a request may wait for a worker slot. With the 5 s upload and the
/// 15 s of work it stays inside a socket's 30 s lifetime.
const PERMIT_WAIT: Duration = Duration::from_secs(8);

/// Runs before body collection or JSON parsing. Kept independent of Tauri for
/// adversarial transport tests using real request bodies.
async fn admit(request: Request, port: u16) -> Result<(root_mcp::Session, Value, tokio::sync::OwnedSemaphorePermit, tokio::sync::OwnedSemaphorePermit), StatusCode> {
    if !matches!(request.version(), axum::http::Version::HTTP_10 | axum::http::Version::HTTP_11) {
        return Err(StatusCode::HTTP_VERSION_NOT_SUPPORTED);
    }
    let headers = request.headers();
    if headers.contains_key(header::ORIGIN) { return Err(StatusCode::FORBIDDEN); }
    let authority = headers.get(header::HOST).and_then(|v| v.to_str().ok())
        .or_else(|| request.uri().authority().map(|a| a.as_str()));
    let local = format!("127.0.0.1:{port}");
    let guest = format!("{}:{}", root_mcp::READER_GUEST_HOST, root_mcp::READER_GUEST_PORT);
    if headers.get_all(header::HOST).iter().count() > 1
        || !authority.is_some_and(|a| a == local || a == guest) {
        return Err(StatusCode::FORBIDDEN);
    }
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1 { return Err(StatusCode::UNAUTHORIZED); }
    let session = root_mcp::authenticate(headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !path_serves(request.uri().path(), session.identity.caller) { return Err(StatusCode::UNAUTHORIZED); }
    if authority == Some(guest.as_str()) && session.identity.caller != root_mcp::Caller::Reader {
        return Err(StatusCode::FORBIDDEN);
    }
    if !headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.split(';').next().is_some_and(|s| s.trim().eq_ignore_ascii_case("application/json"))) {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    if !session.admit_rate() { return Err(StatusCode::TOO_MANY_REQUESTS); }
    // Queue briefly rather than refuse: a CLI fires its parallel tool calls at
    // once, and a `429` reads to it as a broken server, not as "one moment".
    // The rate limit above and the socket bound still cap what can queue.
    let permits = async {
        let own = session.permits.clone().acquire_owned().await.ok()?;
        let global = REQUESTS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(8))).clone()
            .acquire_owned().await.ok()?;
        Some((global, own))
    };
    let (global, own) = tokio::time::timeout(PERMIT_WAIT, permits).await
        .ok().flatten().ok_or(StatusCode::TOO_MANY_REQUESTS)?;
    let body = tokio::time::timeout(Duration::from_secs(5), axum::body::to_bytes(request.into_body(), security::MAX_BODY))
        .await.map_err(|_| StatusCode::REQUEST_TIMEOUT)?
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    let message: Value = serde_json::from_slice(&body).map_err(|_| StatusCode::BAD_REQUEST)?;
    if !message.is_object() { return Err(StatusCode::BAD_REQUEST); }
    session.check().map_err(|_| StatusCode::UNAUTHORIZED)?;
    Ok((session, message, global, own))
}

async fn handle(State(state): State<ServerState>, request: Request) -> Response {
    let started = Instant::now();
    let (session, message, global, own) = match admit(request, state.port).await {
        Ok(admitted) => admitted,
        Err(status) => return status.into_response(),
    };
    let tool = message["params"]["name"].as_str().unwrap_or("").to_string();
    let audit_session = session.clone();
    if session.identity.caller == root_mcp::Caller::Scheduler {
        if session.identity.project.as_deref().is_none_or(|p| crate::services::schedule_mcp::level(p).is_err()) || session.check().is_err() {
            security::audit_reason(&session, &tool, "denied", started.elapsed(), Some("policy_disabled"));
            return StatusCode::FORBIDDEN.into_response();
        }
        let reset = if message["method"] == "tools/call" && message["params"]["name"] == "schedule_prompt"
            && message["params"]["arguments"]["when"]["type"] == "after_usage_reset" {
            let agent = session.identity.schedule_target.as_ref().map(|b| b.agent.clone()).unwrap_or_default();
            let report = tokio::time::timeout(Duration::from_secs(8), crate::commands::agents::agent_usage(agent, Some(false))).await.ok();
            report.and_then(|r| r.raw).as_deref().and_then(|raw| crate::services::schedule_usage::next_reset(raw, chrono::Utc::now()))
        } else { None };
        let outcome = tokio::task::spawn_blocking(move || {
            let (_global, _own) = (global, own);
            crate::services::schedule_mcp::handle_message(&session, &message, reset)
        }).await;
        let Ok((reply, changed)) = outcome else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        let failed = reply.as_ref().is_some_and(|r| r.get("error").is_some() || r["result"]["isError"] == true);
        security::audit_reason(&audit_session, &tool, if failed { "refused" } else { "allowed" }, started.elapsed(), reply.as_ref().and_then(crate::services::schedule_mcp::refusal_reason));
        if changed { let _ = state.app.emit("agent-schedules-changed", ()); }
        return match reply { Some(reply) => Json(reply).into_response(), None => StatusCode::ACCEPTED.into_response() };
    }
    let mail = state
        .app
        .try_state::<crate::commands::mail::MailState>()
        .map(|s| crate::commands::mail::AgentMail(s.inner().clone()));
    let outcome = tokio::task::spawn_blocking(move || {
        // Permits live in the worker: an HTTP disconnect cannot free capacity
        // while blocking work is still running.
        let (_global, _own) = (global, own);
        // From admission, not arrival: time spent queued is not time worked.
        let deadline = Instant::now() + Duration::from_secs(15);
        let caller = &session.identity;
        let state = storage::state_dir();
        let calendar = crate::commands::calendar::calendar_path();
        let projects = state.join("projects.json");
        let settings = state.join("settings.json");
        // The switches, read per request: an agent spawned while the tools
        // were on (or not yet local-only) still holds its token, and "off" has
        // to mean off for it too, without closing its tab.
        let policy = Policy::load(&settings).ok()?;
        if !policy.serves(caller.caller) || session.check().is_err() { return None; }
        // A reader is served only while its box is actually narrow, checked
        // per call: widening mid-session refuses the *next* read.
        let reader_refusal = (caller.caller == root_mcp::Caller::Reader)
            .then(|| crate::commands::vm::mail_reader_refusal(caller.project.as_deref()))
            .flatten();
        Some(root_mcp::handle_message(
            &Stores {
                calendar: &calendar,
                projects: &projects,
                settings: &settings,
                state: &state,
                caller: caller.caller,
                mail: mail.as_ref().map(|m| m as &dyn crate::services::root_mcp_mail::MailAccess),
                reader_refusal: reader_refusal.as_deref(),
                policy, access: session.access.clone(), session: Some(&session),
                deadline: Some(deadline),
            },
            &caller.tab,
            &message,
        ))
    })
    .await;
    let Ok(outcome) = outcome else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let Some((reply, effects)) = outcome else {
        security::audit(&audit_session, &tool, "denied", started.elapsed());
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Eldrun's tools are switched off in Eldrun's Settings; the user has to turn them on first",
        )
            .into_response();
    };
    let failed = reply.as_ref().is_some_and(|r| r.get("error").is_some() || r["result"]["isError"] == true);
    security::audit(&audit_session, &tool, if failed { "refused" } else { "allowed" }, started.elapsed());
    // One event per row: a board move can reindex a whole column.
    for change in effects.changes {
        let _ = state.app.emit(CHANGED_EVENT, change);
    }
    if security::tool(&tool).is_some_and(|t| t.write) {
        let _ = state.app.emit("root-mcp-review-changed",
            crate::services::root_mcp_review::pending_count(&storage::state_dir()));
    }
    match reply {
        Some(reply) => Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn close_connection(mut response: Response) -> Response {
    // A new socket per RPC avoids expiring a reused connection in the middle
    // of a later write. Loopback setup is cheap and HTTP clients reconnect.
    response.headers_mut().insert(header::CONNECTION, axum::http::HeaderValue::from_static("close"));
    response
}

/// Bind the listener and publish its runtime. Called once from `setup`; a
/// failure leaves root agents exactly as capable as any other agent, which is
/// the safe direction to fail in.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("[root-mcp] bind failed: {error}");
                return;
            }
        };
        let Ok(addr) = listener.local_addr() else {
            return;
        };
        root_mcp::set_runtime(Runtime { port: addr.port() });
        let router = Router::new()
            .route("/mcp", post(handle))
            .route("/mcp/schedule", post(handle))
            .layer(axum::middleware::map_response(close_connection))
            .with_state(ServerState { app, port: addr.port() });
        let listener = BoundedListener { tcp: listener, slots: Arc::new(tokio::sync::Semaphore::new(32)) };
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("[root-mcp] server stopped: {error}");
        }
    });
}

#[derive(Serialize)]
pub struct RootMcpStatus {
    /// The listener is up, so a root agent opened now gets the tools.
    pub running: bool,
    /// The global switch (`Settings::root_mcp`). Off → no agent gets the tools
    /// and the endpoint refuses the ones that already hold the token.
    pub enabled: bool,
    pub tools: Vec<&'static str>,
    /// Agent CLIs that can call the tools (`root_mcp::WIRED_CLIS`); the rest
    /// get the endpoint's env pair and nothing that uses it.
    pub wired_clis: &'static [&'static str],
    /// The endpoint would serve a contained reader now (`Settings::root_mcp_mail`
    /// on, neither local-only switch on) and at least one mail account is open
    /// to one (`MailAiPrefs::agent_access`) — the badge's mail mark.
    pub mail_open: bool,
    /// A root agent started now would run inside the fence, so the staged-write
    /// review is a gate it cannot walk around. False (fence switched off, or a
    /// platform with none) means the agent shares the user's files and can edit
    /// the calendar store or the review setting itself — the review strip is
    /// then a courtesy, and the badge has to say so rather than imply a gate.
    pub review_enforced: bool,
}

/// What the overlay's rights badge shows. Deliberately carries neither the port
/// nor the token — the renderer has no use for either.
#[tauri::command]
pub fn root_mcp_status() -> RootMcpStatus {
    RootMcpStatus {
        running: root_mcp::runtime().is_some(),
        enabled: root_mcp::enabled(),
        tools: root_mcp::tool_names(),
        wired_clis: root_mcp::WIRED_CLIS,
        mail_open: root_mcp::serves(&storage::state_dir().join("settings.json"), root_mcp::Caller::Reader)
            && crate::commands::mail::any_account_open_to_agents(),
        review_enforced: crate::services::agent_fence::policy_enabled(None)
            && crate::services::agent_fence::platform_fenceable()
            && crate::services::agent_fence::bwrap_available(),
    }
}

fn review_stores<T>(f: impl FnOnce(&Stores) -> Result<T, String>) -> Result<T, String> {
    let state = storage::state_dir();
    f(&Stores {
        calendar: &crate::commands::calendar::calendar_path(),
        projects: &state.join("projects.json"),
        settings: &state.join("settings.json"),
        state: &state,
        // Review decisions are the user's, made in the window: no caller class
        // and no mail are involved in applying a staged calendar row.
        caller: root_mcp::Caller::Agent,
        mail: None,
        reader_refusal: None,
        policy: Policy::load(&state.join("settings.json"))?,
        access: Access::initial(root_mcp::Caller::Agent), session: None, deadline: None,
    })
}
fn emit_review(app: &AppHandle, changes: Vec<root_mcp::Change>) {
    for change in changes {
        let _ = app.emit(CHANGED_EVENT, change);
    }
    let _ = app.emit(
        "root-mcp-review-changed",
        crate::services::root_mcp_review::pending_count(&storage::state_dir()),
    );
}
#[tauri::command]
pub async fn root_mcp_review_list(
    app: AppHandle,
) -> Result<Vec<crate::services::root_mcp_review::ReviewEntry>, String> {
    let (entries, before) = tokio::task::spawn_blocking(|| {
        let before = crate::services::root_mcp_review::pending_count(&storage::state_dir());
        review_stores(crate::services::root_mcp_review::list).map(|entries| (entries, before))
    })
    .await
    .map_err(|e| e.to_string())??;
    let count = entries
        .iter()
        .filter(|p| p.proposal.status == "pending")
        .count();
    if count != before {
        let _ = app.emit("root-mcp-review-changed", count);
    }
    Ok(entries)
}
#[tauri::command]
pub async fn root_mcp_review_apply(
    app: AppHandle,
    id: String,
    digest: String,
) -> Result<(), String> {
    let result = tokio::task::spawn_blocking(move || {
        review_stores(|s| crate::services::root_mcp_review::decide(s, &id, &digest, "apply"))
    })
    .await
    .map_err(|e| e.to_string())?;
    emit_review(&app, result?);
    Ok(())
}
#[tauri::command]
pub async fn root_mcp_review_reject(
    app: AppHandle,
    id: String,
    digest: String,
) -> Result<(), String> {
    let result = tokio::task::spawn_blocking(move || {
        review_stores(|s| crate::services::root_mcp_review::decide(s, &id, &digest, "reject"))
    })
    .await
    .map_err(|e| e.to_string())?;
    emit_review(&app, result?);
    Ok(())
}
#[tauri::command]
pub async fn root_mcp_review_undo(
    app: AppHandle,
    id: String,
    digest: String,
) -> Result<(), String> {
    let result = tokio::task::spawn_blocking(move || {
        review_stores(|s| crate::services::root_mcp_review::decide(s, &id, &digest, "undo"))
    })
    .await
    .map_err(|e| e.to_string())?;
    emit_review(&app, result?);
    Ok(())
}
#[tauri::command]
pub async fn root_mcp_review_apply_all(
    app: AppHandle,
    approvals: Vec<crate::services::root_mcp_review::Approval>,
) -> Result<(), String> {
    let result = tokio::task::spawn_blocking(move || {
        review_stores(|s| crate::services::root_mcp_review::apply_all(s, &approvals))
    })
    .await
    .map_err(|e| e.to_string())?;
    emit_review(&app, result?);
    Ok(())
}

/// The `.ics` files root agents staged (`services::root_mcp_import`), text and
/// all: the window's parser reads them, and its importer runs on the user's ✓.
#[tauri::command]
pub async fn root_mcp_import_list() -> Result<Vec<crate::services::root_mcp_import::StagedImport>, String> {
    tokio::task::spawn_blocking(|| crate::services::root_mcp_import::list(&storage::state_dir()))
        .await
        .map_err(|e| e.to_string())
}
/// Imported or discarded: the staged copy goes either way.
#[tauri::command]
pub async fn root_mcp_import_remove(app: AppHandle, id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::services::root_mcp_import::remove(&storage::state_dir(), &id))
        .await
        .map_err(|e| e.to_string())??;
    emit_review(&app, Vec::new());
    Ok(())
}

#[derive(Serialize)]
pub struct SecurityStatus {
    sessions: Vec<root_mcp::SessionInfo>,
    audit: Vec<security::Audit>,
}
#[tauri::command]
pub fn root_mcp_security_status() -> SecurityStatus {
    SecurityStatus { sessions: root_mcp::sessions(), audit: security::audit_rows() }
}
#[tauri::command]
pub async fn root_mcp_session_access(id: String, access: Access) -> Result<(), String> {
    tokio::task::spawn_blocking(move || root_mcp::set_access(&id, access)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn root_mcp_session_revoke(app: AppHandle, id: String, remove_proposals: Option<bool>) -> Result<(), String> {
    // Invalidate first, before waiting on the review lock to clean the sandbox.
    let tab = root_mcp::revoke_session(&id)?;
    tokio::task::spawn_blocking(move || {
        crate::services::root_mcp_review::cleanup_tab(&storage::state_dir(), &tab);
        crate::services::agent_tasks::drain_mutations();
        if remove_proposals == Some(true) { crate::services::schedule_mcp::remove_proposals(&id)?; }
        let _ = app.emit("agent-schedules-changed", ());
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

fn path_serves(path: &str, caller: root_mcp::Caller) -> bool {
    match path {
        "/mcp" => caller != root_mcp::Caller::Scheduler,
        "/mcp/schedule" => caller == root_mcp::Caller::Scheduler,
        _ => false,
    }
}

#[cfg(test)]
mod security_tests {
    #[tokio::test]
    async fn routes_refuse_wrong_token_class_before_reading_body() {
        for caller in [root_mcp::Caller::Agent, root_mcp::Caller::LocalModel, root_mcp::Caller::Reader, root_mcp::Caller::Scheduler] {
            let (token, session) = root_mcp::test_session(caller);
            let wrong = if caller == root_mcp::Caller::Scheduler { "/mcp" } else { "/mcp/schedule" };
            let req = Request::builder().method("POST").uri(wrong).header("host", "127.0.0.1:8765")
                .header("authorization", format!("Bearer {token}"))
                .body(axum::body::Body::from("not json")).unwrap();
            assert!(matches!(admit(req, 8765).await, Err(StatusCode::UNAUTHORIZED)));
            assert!(path_serves(if caller == root_mcp::Caller::Scheduler { "/mcp/schedule" } else { "/mcp" }, caller));
            root_mcp::revoke_tab(&session.identity.tab);
        }
    }
    use super::*;
    use axum::body::Body;
    fn request(token: &str, body: Body) -> Request {
        Request::builder().method("POST").uri("/mcp")
            .header("host", "127.0.0.1:4321").header("content-type", "application/json")
            .header("authorization", format!("Bearer {token}")).body(body).unwrap()
    }
    fn pending() -> Body {
        Body::from_stream(futures_util::stream::pending::<Result<String, std::io::Error>>())
    }
    #[tokio::test(start_paused = true)]
    async fn transport_rejects_before_reading_unauthorized_bodies_and_bounds_valid_uploads() {
        let (token, session) = root_mcp::test_session(root_mcp::Caller::Agent);
        assert_eq!(admit(request("invalid", pending()), 4321).await.err(), Some(StatusCode::UNAUTHORIZED));
        let mut origin = request(&token, pending());
        origin.headers_mut().insert("origin", "null".parse().unwrap());
        assert_eq!(admit(origin, 4321).await.err(), Some(StatusCode::FORBIDDEN));
        let mut host = request(&token, pending());
        host.headers_mut().insert("host", "attacker.invalid:4321".parse().unwrap());
        assert_eq!(admit(host, 4321).await.err(), Some(StatusCode::FORBIDDEN));
        assert_eq!(admit(request(&token, pending()), 4321).await.err(), Some(StatusCode::REQUEST_TIMEOUT));
        assert_eq!(admit(request(&token, Body::from("x".repeat(security::MAX_BODY + 1))), 4321).await.err(), Some(StatusCode::PAYLOAD_TOO_LARGE));
        let body = || Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
        let first = admit(request(&token, body()), 4321).await.unwrap();
        let second = admit(request(&token, body()), 4321).await.unwrap();
        assert_eq!(admit(request(&token, body()), 4321).await.err(), Some(StatusCode::TOO_MANY_REQUESTS));
        drop((first, second));
        root_mcp::revoke_tab(&session.identity.tab);
        assert_eq!(admit(request(&token, body()), 4321).await.err(), Some(StatusCode::UNAUTHORIZED));
    }
}
