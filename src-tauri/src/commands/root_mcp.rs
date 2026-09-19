//! The root console's MCP listener — the `AppHandle` half of
//! `services::root_mcp`, which holds the design and everything testable.
//!
//! One loopback HTTP route, `POST /mcp`, speaking MCP's streamable-HTTP
//! transport in its simplest legal form: one JSON-RPC message in, one JSON
//! reply out (or `202` for a notification). No SSE stream and no session id —
//! every tool is a single read or write of Eldrun's own files, so there is
//! nothing to stream and nothing to remember between calls.

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::services::root_mcp::{self, Runtime, Stores};
use crate::storage;

/// The window's cue that a root agent wrote a calendar row. Payload:
/// `services::root_mcp::Change`.
const CHANGED_EVENT: &str = "root-mcp-changed";

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
}

async fn handle(State(state): State<ServerState>, headers: HeaderMap, body: String) -> Response {
    // A browser always sends `Origin` on a cross-origin POST; no agent CLI
    // does. Refusing it keeps a web page from reaching the tools through the
    // user's own browser (DNS rebinding included), token or not.
    if headers.contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let Some(caller) = root_mcp::caller(presented) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(message) = serde_json::from_str::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    // Batches were dropped from the transport this server names; one message.
    if !message.is_object() {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let mail = state
        .app
        .try_state::<crate::commands::mail::MailState>()
        .map(|s| crate::commands::mail::AgentMail(s.inner().clone()));
    let outcome = tokio::task::spawn_blocking(move || {
        let state = storage::state_dir();
        let calendar = crate::commands::calendar::calendar_path();
        let projects = state.join("projects.json");
        let settings = state.join("settings.json");
        // The switches, read per request: an agent spawned while the tools
        // were on (or not yet local-only) still holds its token, and "off" has
        // to mean off for it too, without closing its tab.
        if !root_mcp::serves(&settings, caller.caller) {
            return None;
        }
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
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Eldrun's tools are switched off in Eldrun's Settings; the user has to turn them on first",
        )
            .into_response();
    };
    // One event per row: a board move can reindex a whole column.
    for change in effects.changes {
        let _ = state.app.emit(CHANGED_EVENT, change);
    }
    let _ = state.app.emit(
        "root-mcp-review-changed",
        crate::services::root_mcp_review::pending_count(&storage::state_dir()),
    );
    match reply {
        Some(reply) => Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
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
            .with_state(ServerState { app });
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
    /// The mail tools are switched on (`Settings::root_mcp_mail`, default off)
    /// and at least one mail account is open to a contained reader
    /// (`MailAiPrefs::agent_access`) — the badge's mail mark.
    pub mail_open: bool,
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
        mail_open: root_mcp::mail_enabled_in(&storage::state_dir().join("settings.json"))
            && crate::commands::mail::any_account_open_to_agents(),
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
