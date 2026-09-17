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
use tauri::{AppHandle, Emitter};

use crate::services::root_mcp::{self, Runtime, Stores};
use crate::storage;

/// The window's cue that a root agent wrote a calendar row. Payload:
/// `services::root_mcp::Change`.
const CHANGED_EVENT: &str = "root-mcp-changed";

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
    token: String,
}

async fn handle(State(state): State<ServerState>, headers: HeaderMap, body: String) -> Response {
    // A browser always sends `Origin` on a cross-origin POST; no agent CLI
    // does. Refusing it keeps a web page from reaching the tools through the
    // user's own browser (DNS rebinding included), token or not.
    if headers.contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let presented = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    if !root_mcp::authorized(presented, &state.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(message) = serde_json::from_str::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    // Batches were dropped from the transport this server names; one message.
    if !message.is_object() {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let outcome = tokio::task::spawn_blocking(move || {
        let calendar = crate::commands::calendar::calendar_path();
        let projects = storage::state_dir().join("projects.json");
        root_mcp::handle_message(&Stores { calendar: &calendar, projects: &projects }, &message)
    })
    .await;
    let Ok((reply, change)) = outcome else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    if let Some(change) = change {
        let _ = state.app.emit(CHANGED_EVENT, change);
    }
    match reply {
        Some(reply) => Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// Bind the listener and publish its runtime. Called once from `setup`; a
/// failure leaves root agents exactly as capable as any other agent, which is
/// the safe direction to fail in.
pub fn start(app: AppHandle) {
    let Some(token) = root_mcp::mint_token() else {
        eprintln!("[root-mcp] no OS entropy; the root console's tools stay off");
        return;
    };
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("[root-mcp] bind failed: {error}");
                return;
            }
        };
        let Ok(addr) = listener.local_addr() else { return };
        root_mcp::set_runtime(Runtime { port: addr.port(), token: token.clone() });
        let router = Router::new()
            .route("/mcp", post(handle))
            .with_state(ServerState { app, token });
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("[root-mcp] server stopped: {error}");
        }
    });
}

#[derive(Serialize)]
pub struct RootMcpStatus {
    /// The listener is up, so a root agent opened now gets the tools.
    pub running: bool,
    pub tools: Vec<&'static str>,
}

/// What the overlay's rights badge shows. Deliberately carries neither the port
/// nor the token — the renderer has no use for either.
#[tauri::command]
pub fn root_mcp_status() -> RootMcpStatus {
    RootMcpStatus {
        running: root_mcp::runtime().is_some(),
        tools: root_mcp::tool_names(),
    }
}
