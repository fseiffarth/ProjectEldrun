use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::Body,
    extract::{ws::WebSocketUpgrade, DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Request, Response, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64ct::{Base64UrlUnpadded, Encoding};
use serde::Deserialize;
use serde_json::json;

use super::{
    admin,
    auth::AuthStore,
    config::{verify_tailscale_serve, HostConfig},
    discovery::{Catalog, CatalogCache},
    limits,
    protocol::{
        CalendarAction, CreateTabRequest, DesktopRequest, DesktopResponse, TodoAction,
        MAX_CONTROL_MESSAGE, MAX_INPUT_FRAME, TERMINAL_PROTOCOL,
    },
    pty_bridge::{self, TerminalRegistry},
};

include!(concat!(env!("OUT_DIR"), "/mobile_assets.rs"));

const MOBILE_PERMISSIONS_POLICY: &str =
    "camera=(), microphone=(self), on-device-speech-recognition=(self), geolocation=(), payment=(), usb=()";

#[derive(Clone)]
struct HostState {
    config: HostConfig,
    auth: Arc<Mutex<AuthStore>>,
    catalog: Arc<Mutex<CatalogCache>>,
    terminal_registry: TerminalRegistry,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairBody {
    code: String,
    device_name: String,
    public_key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChallengeBody {
    device_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionBody {
    device_id: String,
    nonce: String,
    signature: String,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ProjectQuery {
    view: Option<String>,
    q: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct MailQuery {
    offset: Option<u32>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct CalendarQuery {
    month: Option<String>,
}

fn api_error(status: StatusCode, code: &str) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(json!({ "error": code })))
}

fn exact_origin(headers: &HeaderMap, state: &HostState) -> bool {
    headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) == Some(state.config.origin.as_str())
}

fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            (name == "__Host-eldrun_session").then_some(value)
        })
}

fn authenticate(
    headers: &HeaderMap,
    state: &HostState,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let token = cookie_token(headers)
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "authentication_required"))?;
    state
        .auth
        .lock()
        .unwrap()
        .authenticate(token)
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "authentication_required"))
}

fn catalog(state: &HostState) -> Result<Catalog, (StatusCode, Json<serde_json::Value>)> {
    let key = state.auth.lock().unwrap().host_key().to_vec();
    state
        .catalog
        .lock()
        .unwrap()
        .load(&state.config.state_dir, &key)
        .map_err(|_| api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable"))
}

/// The create-tab poll is waiting for a tab the desktop has just been asked to
/// open, so by definition it is not in the cached snapshot yet.
fn catalog_fresh(state: &HostState) -> Result<Catalog, (StatusCode, Json<serde_json::Value>)> {
    let key = state.auth.lock().unwrap().host_key().to_vec();
    state
        .catalog
        .lock()
        .unwrap()
        .load_fresh(&state.config.state_dir, &key)
        .map_err(|_| api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable"))
}

async fn security_headers(request: Request<Body>, next: Next) -> Response<Body> {
    let sensitive = request.uri().path().starts_with("/api/") || request.uri().path() == "/healthz";
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static("max-age=31536000"),
    );
    if sensitive {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static(MOBILE_PERMISSIONS_POLICY),
    );
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"));
    response
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

async fn pair(
    State(state): State<HostState>,
    headers: HeaderMap,
    Json(body): Json<PairBody>,
) -> impl IntoResponse {
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    match state
        .auth
        .lock()
        .unwrap()
        .pair(&body.code, &body.device_name, &body.public_key)
    {
        Ok(device_id) => (StatusCode::CREATED, Json(json!({ "device_id": device_id }))),
        Err(code) => api_error(StatusCode::BAD_REQUEST, &code),
    }
}

async fn challenge(
    State(state): State<HostState>,
    headers: HeaderMap,
    Json(body): Json<ChallengeBody>,
) -> impl IntoResponse {
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    match state.auth.lock().unwrap().challenge(&body.device_id) {
        Ok((nonce, payload, expires_at)) => (
            StatusCode::OK,
            Json(json!({ "nonce": nonce, "payload": payload, "expires_at": expires_at })),
        ),
        Err(code) => api_error(StatusCode::BAD_REQUEST, &code),
    }
}

async fn login(
    State(state): State<HostState>,
    headers: HeaderMap,
    Json(body): Json<SessionBody>,
) -> Response<Body> {
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin").into_response();
    }
    match state
        .auth
        .lock()
        .unwrap()
        .login(&body.device_id, &body.nonce, &body.signature)
    {
        Ok((token, expires_at)) => {
            let mut response =
                Json(json!({ "ok": true, "expires_at": expires_at })).into_response();
            let cookie = format!("__Host-eldrun_session={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200");
            response
                .headers_mut()
                .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
            response
        }
        Err(code) => api_error(StatusCode::UNAUTHORIZED, &code).into_response(),
    }
}

async fn logout(State(state): State<HostState>, headers: HeaderMap) -> Response<Body> {
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin").into_response();
    }
    if let Some(token) = cookie_token(&headers) {
        state.auth.lock().unwrap().logout(token);
    }
    let mut response = Json(json!({ "ok": true })).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "__Host-eldrun_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
        ),
    );
    response
}

async fn status(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let desktop_available = state
        .config
        .control_dir
        .join("desktop-control.sock")
        .exists();
    (
        StatusCode::OK,
        Json(
            json!({ "desktop_available": desktop_available, "host": state.config.host.display_name }),
        ),
    )
}

async fn projects(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(query): Query<ProjectQuery>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let Ok(catalog) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let q = query.q.unwrap_or_default();
    if q.len() > 80 {
        return api_error(StatusCode::BAD_REQUEST, "query_too_long");
    }
    let q = q.to_lowercase();
    let view = query.view.as_deref().unwrap_or("active");
    if view != "active" && view != "search" {
        return api_error(StatusCode::BAD_REQUEST, "invalid_view");
    }
    let mut rows = catalog
        .projects
        .into_iter()
        .filter(|p| {
            if view == "search" {
                !q.is_empty() && p.public.label.to_lowercase().contains(&q)
            } else {
                p.public.live_sessions > 0
                    || p.public.status == "current"
                    || p.public.status == "active"
            }
        })
        .map(|p| p.public)
        .collect::<Vec<_>>();
    rows.sort_by_key(|p| {
        (
            std::cmp::Reverse(p.live_sessions > 0),
            std::cmp::Reverse(p.last_activity.unwrap_or(0)),
            p.label.to_lowercase(),
        )
    });
    (StatusCode::OK, Json(json!({ "projects": rows })))
}

async fn project(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let Ok(catalog_snapshot) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    let mut tabs = project
        .tabs
        .iter()
        .map(|t| {
            let mut row = t.public.clone();
            row.viewer_busy = state.terminal_registry.is_busy(&t.tmux_name);
            row
        })
        .collect::<Vec<_>>();
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let desktop_available = desktop_socket.exists();
    let (agents, statuses) = if desktop_available {
        let request_id = Base64UrlUnpadded::encode_string(&random_16());
        match admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::Catalog {
                request_id,
                project_id: Some(project.raw_id.clone()),
            },
        )
        .await
        {
            Ok(DesktopResponse::Catalog { agents, statuses }) => (agents, statuses),
            _ => (vec![], vec![]),
        }
    } else {
        (vec![], vec![])
    };
    let statuses = statuses
        .into_iter()
        .map(|status| (status.tmux_session, status.status))
        .collect::<HashMap<_, _>>();
    for (tab, resolved) in tabs.iter_mut().zip(&project.tabs) {
        if tab.kind == "agent" {
            tab.agent_status = statuses.get(&resolved.tmux_name).cloned();
        }
    }
    (
        StatusCode::OK,
        Json(
            json!({ "project": project.public, "tabs": tabs, "desktop_available": desktop_available, "agents": agents }),
        ),
    )
}

fn random_16() -> [u8; 16] {
    let mut bytes = [0; 16];
    let _ = getrandom::fill(&mut bytes);
    bytes
}

async fn create_tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(mut request): Json<CreateTabRequest>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    if request.project_id != project_id
        || request.idempotency_key.len() < 16
        || request.idempotency_key.len() > 128
    {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let Ok(catalog_snapshot) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    request.project_id = project.raw_id.clone();
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::Create {
            request_id,
            request,
        },
    )
    .await
    {
        Ok(DesktopResponse::Created { tmux_session }) => {
            for _ in 0..40 {
                if let Ok(next) = catalog_fresh(&state) {
                    if let Some(tab) = next.project(&project_id).and_then(|p| {
                        p.tabs
                            .iter()
                            .find(|t| t.tmux_name == tmux_session && t.public.available)
                    }) {
                        return (StatusCode::CREATED, Json(json!({ "tab": tab.public })));
                    }
                }
                tokio::time::sleep(Duration::from_millis(125)).await;
            }
            api_error(StatusCode::GATEWAY_TIMEOUT, "launch_pending")
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

async fn activate_project(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(catalog_snapshot) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::Activate {
            request_id,
            project_id: project.raw_id.clone(),
        },
    )
    .await
    {
        Ok(DesktopResponse::Activated) => (StatusCode::OK, Json(json!({ "status": "activated" }))),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// The board is intentionally available only through the live desktop bridge:
/// calendar writes also notify the desktop's CalDAV write hook, and the sidecar
/// must not become another writer of calendar.json.
async fn todo(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    match admin::desktop_call(&desktop_socket, &DesktopRequest::Todo { request_id }).await {
        Ok(DesktopResponse::Todo { board }) => (StatusCode::OK, Json(json!({ "board": board }))),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// Alerts stay behind the live desktop bridge, just like the board and mail:
/// the desktop owns the alert setting, source gates, recurrence expansion, and
/// muted rows. The wire snapshot is deliberately display-only.
async fn alerts(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    match admin::desktop_call(&desktop_socket, &DesktopRequest::Alerts { request_id }).await {
        Ok(DesktopResponse::Alerts { alerts }) => {
            (StatusCode::OK, Json(json!({ "alerts": alerts })))
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

fn valid_calendar_month(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..].iter().all(u8::is_ascii_digit)
        && (bytes[5] - b'0') * 10 + (bytes[6] - b'0') >= 1
        && (bytes[5] - b'0') * 10 + (bytes[6] - b'0') <= 12
}

/// Like the board, Mobile's calendar is a live desktop snapshot. This keeps
/// recurrence, checked-calendar visibility, CalDAV state and calendar.json
/// ownership in the existing desktop store.
async fn calendar(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(query): Query<CalendarQuery>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let Some(month) = query.month.filter(|value| valid_calendar_month(value)) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_month");
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::Calendar { request_id, month },
    )
    .await
    {
        Ok(DesktopResponse::Calendar { calendar }) => {
            (StatusCode::OK, Json(json!({ "calendar": calendar })))
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

fn valid_calendar_action(action: &CalendarAction) -> bool {
    match action {
        CalendarAction::CreateEvent { event } | CalendarAction::UpdateEvent { event, .. } => {
            !event.calendar_id.is_empty()
                && event.calendar_id.len() <= 128
                && !event.title.trim().is_empty()
                && event.title.len() <= 300
                && event.start.len() <= 32
                && event.end.len() <= 32
                && event.location.len() <= 1_000
                && event.notes.len() <= 16 * 1024
                && event.conference.len() <= 2_000
                && event.category.len() <= 80
                && event.status.len() <= 32
        }
        CalendarAction::DeleteEvent { event_id } => !event_id.is_empty() && event_id.len() <= 128,
        CalendarAction::CreateCalendar { name, color } => {
            !name.trim().is_empty() && name.len() <= 160 && color.len() <= 64
        }
        CalendarAction::UpdateCalendar {
            calendar_id,
            name,
            color,
            ..
        } => {
            !calendar_id.is_empty()
                && calendar_id.len() <= 128
                && !name.trim().is_empty()
                && name.len() <= 160
                && color.len() <= 64
        }
        CalendarAction::DeleteCalendar { calendar_id } => {
            !calendar_id.is_empty() && calendar_id.len() <= 128
        }
    }
}

/// Calendar writes share the same live desktop bridge as the to-do board. This
/// keeps CalDAV push ordering and the calendar store as the sole writer.
async fn calendar_mutate(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(query): Query<CalendarQuery>,
    Json(action): Json<CalendarAction>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Some(month) = query.month.filter(|value| valid_calendar_month(value)) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_month");
    };
    if !valid_calendar_action(&action) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::CalendarMutate {
            request_id,
            month,
            action,
        },
    )
    .await
    {
        Ok(DesktopResponse::Calendar { calendar }) => {
            (StatusCode::OK, Json(json!({ "calendar": calendar })))
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

async fn todo_mutate(
    State(state): State<HostState>,
    headers: HeaderMap,
    Json(action): Json<TodoAction>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let valid = match &action {
        TodoAction::Create { task } => valid_todo_task(task),
        TodoAction::Move {
            task_id, column, ..
        } => !task_id.is_empty() && task_id.len() <= 128 && column.len() <= 128,
        TodoAction::Update { task_id, task } => {
            !task_id.is_empty() && task_id.len() <= 128 && valid_todo_task(task)
        }
        TodoAction::Delete { task_id } => !task_id.is_empty() && task_id.len() <= 128,
        TodoAction::ColumnCreate { name } => !name.trim().is_empty() && name.len() <= 160,
        TodoAction::ColumnRename { column_id, name } => {
            !column_id.is_empty()
                && column_id.len() <= 128
                && !name.trim().is_empty()
                && name.len() <= 160
        }
        TodoAction::ColumnMove { column_id, delta } => {
            !column_id.is_empty() && column_id.len() <= 128 && matches!(delta, -1 | 1)
        }
        TodoAction::ColumnDelete { column_id } => !column_id.is_empty() && column_id.len() <= 128,
    };
    if !valid {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::TodoMutate { request_id, action },
    )
    .await
    {
        Ok(DesktopResponse::Todo { board }) => (StatusCode::OK, Json(json!({ "board": board }))),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

fn valid_todo_task(task: &crate::services::mobile_control::protocol::TodoTaskInput) -> bool {
    !task.title.trim().is_empty()
        && task.title.len() <= 300
        && task.notes.len() <= 16 * 1024
        && task.due.as_ref().is_none_or(|due| due.len() <= 32)
        && task.priority <= 9
        && task.percent <= 100
        && task.column.len() <= 128
        && task.calendar_id.len() <= 128
        && task.project_id.as_ref().is_none_or(|id| id.len() <= 128)
        && task.tags.len() <= 50
        && task
            .tags
            .iter()
            .all(|tag| !tag.trim().is_empty() && tag.len() <= 80)
        && task.subtasks.len() <= 100
        && task.subtasks.iter().all(|step| {
            step.id.len() <= 128 && !step.title.trim().is_empty() && step.title.len() <= 300
        })
}

fn valid_mail_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn mail_response(
    response: Result<DesktopResponse, String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match response {
        Ok(DesktopResponse::Mail { mail }) => (StatusCode::OK, Json(json!({ "mail": mail }))),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else if code.ends_with("_not_found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// Mail stays behind the live desktop for the same reason the board does: the
/// desktop already owns the unlocked/encrypted MailState. The sidecar receives
/// only the bounded, read-only snapshot defined in `protocol`.
async fn mail_overview(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    mail_response(
        admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::MailOverview { request_id },
        )
        .await,
    )
}

async fn mail_folder(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(folder_id): Path<String>,
    Query(query): Query<MailQuery>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let offset = query.offset.unwrap_or(0);
    if !valid_mail_id(&folder_id) || offset > 100_000 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    mail_response(
        admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::MailFolder {
                request_id,
                folder_id,
                offset,
            },
        )
        .await,
    )
}

async fn mail_message(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((folder_id, message_id)): Path<(String, String)>,
    Query(query): Query<MailQuery>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let offset = query.offset.unwrap_or(0);
    if !valid_mail_id(&folder_id) || !valid_mail_id(&message_id) || offset > 100_000 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    mail_response(
        admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::MailMessage {
                request_id,
                folder_id,
                message_id,
                offset,
            },
        )
        .await,
    )
}

async fn tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let Ok(catalog) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some((_, tab)) = catalog.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    let mut row = tab.public.clone();
    row.viewer_busy = state.terminal_registry.is_busy(&tab.tmux_name);
    (StatusCode::OK, Json(json!({ "tab": row })))
}

async fn terminal(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response<Body> {
    if authenticate(&headers, &state).is_err() {
        return api_error(StatusCode::UNAUTHORIZED, "authentication_required").into_response();
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin").into_response();
    }
    let offered = headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !offered.split(',').any(|v| v.trim() == TERMINAL_PROTOCOL) {
        return api_error(StatusCode::BAD_REQUEST, "terminal_protocol_required").into_response();
    }
    let Ok(catalog) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable").into_response();
    };
    let Some((_, tab)) = catalog.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found").into_response();
    };
    if !tab.public.available {
        return api_error(StatusCode::GONE, "session_gone").into_response();
    }
    // Deliberately no `session_busy` pre-check: the bridge now displaces a
    // stale viewer instead, so a phone that was backgrounded before its
    // `detached` frame flushed does not lock the user out of their own agent
    // until the 60-second idle reaper fires. A genuinely live viewer that
    // refuses to yield still produces `session_busy`, from the bridge.
    let tmux = tab.tmux_name.clone();
    let registry = state.terminal_registry.clone();
    let auth = state.auth.clone();
    let token = cookie_token(&headers).unwrap_or_default().to_string();
    let state_dir = state.config.state_dir.clone();
    let catalog = state.catalog.clone();
    // `DefaultBodyLimit` does not reach WebSocket frames, and tungstenite's
    // default is 64 MiB — so `MAX_INPUT_FRAME` was only checked *after* the
    // server had already buffered a thousandfold more than it allows.
    ws.protocols([TERMINAL_PROTOCOL])
        .max_message_size(MAX_INPUT_FRAME)
        .max_frame_size(MAX_INPUT_FRAME)
        .on_upgrade(move |socket| async move {
            let _ = pty_bridge::attach(
                socket, tmux, registry, auth, token, state_dir, tab_id, catalog,
            )
            .await;
        })
}

async fn static_asset(Path(path): Path<String>) -> Response<Body> {
    asset_response(&format!("/{path}"))
}
async fn index() -> Response<Body> {
    asset_response("/index.html")
}

fn asset_response(path: &str) -> Response<Body> {
    let requested = if path == "/" { "/index.html" } else { path };
    let direct = MOBILE_ASSETS.iter().find(|(name, _, _)| *name == requested);
    // The SPA fallback must not cover hashed build output. Serving index.html
    // for `/assets/index-OLD.js` — with a one-year `immutable` header chosen
    // from the *requested* path — poisoned the service worker's cache with HTML
    // stored under a JavaScript URL after every upgrade.
    let hit = match direct {
        Some(hit) => Some(hit),
        None if requested.starts_with("/assets/") => None,
        None => MOBILE_ASSETS
            .iter()
            .find(|(name, _, _)| *name == "/index.html"),
    };
    let Some((name, bytes, mime)) = hit else {
        return StatusCode::NOT_FOUND.into_response();
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, *mime)
        .header(
            header::CACHE_CONTROL,
            // Keyed off what is actually being served, not what was asked for.
            if name.starts_with("/assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            },
        )
        .body(Body::from(bytes::Bytes::from_static(bytes)))
        .unwrap()
}

pub async fn run(state_dir: PathBuf) -> Result<(), String> {
    let config = HostConfig::load(&state_dir)?;
    verify_tailscale_serve(&config.origin, config.host.port)?;
    let auth = Arc::new(Mutex::new(AuthStore::open(
        &config.control_dir,
        config.origin.clone(),
    )?));
    let state = HostState {
        config: config.clone(),
        auth: auth.clone(),
        catalog: Arc::new(Mutex::new(CatalogCache::default())),
        terminal_registry: TerminalRegistry::default(),
    };
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    // A Serve verification failure must be a real service failure. A clean
    // graceful shutdown would satisfy systemd's `Restart=on-failure` policy,
    // leaving Mobile permanently down after a transient tailscaled restart.
    // Keep the reason separate from an intentional AdminRequest::Shutdown so
    // only the former exits non-zero and is restarted.
    let serve_failure = Arc::new(Mutex::new(None::<String>));
    let admin_path = config.control_dir.join("admin.sock");
    let admin_origin = Some(config.origin.clone());
    let port = config.host.port;
    let admin_shutdown = shutdown_tx.clone();
    tokio::spawn(async move {
        let _ = admin::serve(&admin_path, auth, port, admin_origin, admin_shutdown).await;
    });
    let publisher_shutdown = shutdown_tx.clone();
    let publisher_origin = config.origin.clone();
    let publisher_failure = serve_failure.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(error) = verify_tailscale_serve(&publisher_origin, port) {
                *publisher_failure.lock().unwrap() = Some(error);
                let _ = publisher_shutdown.send(true);
                break;
            }
        }
    });
    let app = Router::new()
        .route("/healthz", get(health))
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/auth/challenge", post(challenge))
        .route("/api/v1/auth/session", post(login).delete(logout))
        .route("/api/v1/status", get(status))
        .route("/api/v1/todo", get(todo).post(todo_mutate))
        .route("/api/v1/alerts", get(alerts))
        .route("/api/v1/calendar", get(calendar).post(calendar_mutate))
        .route("/api/v1/mail", get(mail_overview))
        .route("/api/v1/mail/folders/{folder_id}", get(mail_folder))
        .route(
            "/api/v1/mail/folders/{folder_id}/messages/{message_id}",
            get(mail_message),
        )
        .route("/api/v1/projects", get(projects))
        .route("/api/v1/projects/{project_id}", get(project))
        .route(
            "/api/v1/projects/{project_id}/activate",
            post(activate_project),
        )
        .route("/api/v1/projects/{project_id}/tabs", post(create_tab))
        .route("/api/v1/tabs/{tab_id}", get(tab))
        .route("/api/v1/tabs/{tab_id}/terminal", get(terminal))
        .route("/", get(index))
        .route("/{*path}", get(static_asset))
        .layer(DefaultBodyLimit::max(MAX_CONTROL_MESSAGE))
        .layer(middleware::from_fn(security_headers))
        .with_state(state);
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|e| format!("bind {address}: {e}"))?;
    axum::serve(limits::GuardedListener::new(listener), app)
        .with_graceful_shutdown(async move {
            while !*shutdown_rx.borrow() {
                if shutdown_rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    if let Some(error) = serve_failure.lock().unwrap().take() {
        return Err(format!("Tailscale Serve verification failed: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::MOBILE_PERMISSIONS_POLICY;

    #[test]
    fn mobile_policy_allows_only_same_origin_microphone_capture() {
        assert!(MOBILE_PERMISSIONS_POLICY.contains("microphone=(self)"));
        assert!(MOBILE_PERMISSIONS_POLICY.contains("on-device-speech-recognition=(self)"));
        assert!(MOBILE_PERMISSIONS_POLICY.contains("camera=()"));
        assert!(!MOBILE_PERMISSIONS_POLICY.contains("microphone=()"));
        assert!(!MOBILE_PERMISSIONS_POLICY.contains("microphone=(*"));
    }
}
