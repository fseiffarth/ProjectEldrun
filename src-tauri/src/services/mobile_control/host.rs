use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::{Body, Bytes},
    extract::{ws::WebSocketUpgrade, DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Request, Response, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use base64ct::{Base64UrlUnpadded, Encoding};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::services::desktop_images;

use super::{
    admin,
    auth::AuthStore,
    config::{verify_tailscale_serve, HostConfig},
    discovery::{Catalog, CatalogCache, PublicTab, TabSchedules},
    inbox,
    limits,
    protocol::{
        CalendarAction, CreateTabRequest, DesktopRequest, DesktopResponse, MailMarkAction,
        MobilePromptInput, MobileScheduleInput, PromptMutation, ScheduleMutation, TodoAction,
        MAX_CONTROL_MESSAGE, MAX_INPUT_FRAME, MAX_MAIL_REPLY_BYTES, MAX_TAB_LABEL,
        TERMINAL_PROTOCOL,
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

/// Body of a mail flag write. `offset` names the folder page that issued the
/// opaque message id, exactly as the read routes take it in the query.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MailMarkBody {
    action: MailMarkAction,
    #[serde(default)]
    offset: u32,
}

/// Body of a phone reply: the text and nothing else. Recipient, subject and
/// threading are the desktop's to derive from the original message.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MailReplyBody {
    body: String,
    #[serde(default)]
    offset: u32,
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
    // A live probe, not a file check: the socket file outlives a desktop exit
    // (and every crash), and on Windows the nominal path is never a file.
    let desktop_available =
        admin::desktop_reachable(&state.config.control_dir.join("desktop-control.sock")).await;
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

/// One agent tab of any project, the way the phone's cross-project activity
/// list needs it: the ordinary tab row, plus the project it lives in. The list
/// is flat by design — a label on its own would not say where a session is —
/// and both project fields are the same opaque id and display label the project
/// list already publishes.
#[derive(Serialize)]
struct ActivityRow {
    #[serde(flatten)]
    tab: PublicTab,
    project_id: String,
    project_label: String,
}

/// Where a status sorts in the activity list. A session waiting on a decision is
/// blocked on the reader and comes first; a finished one is the least urgent of
/// the three. Anything else never reaches this list.
fn activity_rank(status: &str) -> u8 {
    match status {
        "question" => 0,
        "working" => 1,
        _ => 2,
    }
}

/// `GET /api/v1/activity` — every agent tab the desktop reports as working,
/// waiting on a decision, or done, across every project this phone may reach,
/// in one flat list. One desktop round trip serves the whole list: a per-project
/// `Catalog` call would be one round trip per project on every poll.
async fn activity(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let Ok(catalog_snapshot) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let (desktop_available, statuses) = match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::Activity { request_id },
    )
    .await
    {
        Ok(DesktopResponse::Activity { statuses }) => (true, statuses),
        _ => (false, vec![]),
    };
    // Tmux session names are unique across the whole server, so one map covers
    // every project's tabs.
    let statuses = statuses
        .into_iter()
        .map(|status| (status.tmux_session.clone(), status))
        .collect::<HashMap<_, _>>();
    let mut rows = Vec::new();
    for project in &catalog_snapshot.projects {
        for resolved in &project.tabs {
            if resolved.public.kind != "agent" {
                continue;
            }
            let Some(status) = statuses.get(&resolved.tmux_name) else {
                continue;
            };
            let mut tab = resolved.public.clone();
            tab.agent_status = Some(status.status.clone());
            tab.agent_model = status.model.clone();
            tab.working_at = status.working_at;
            tab.done_at = status.done_at;
            tab.viewer_busy = state.terminal_registry.is_busy(&resolved.tmux_name);
            rows.push(ActivityRow {
                tab,
                project_id: project.public.id.clone(),
                project_label: project.public.label.clone(),
            });
        }
    }
    rows.sort_by(|a, b| {
        activity_rank(a.tab.agent_status.as_deref().unwrap_or_default())
            .cmp(&activity_rank(
                b.tab.agent_status.as_deref().unwrap_or_default(),
            ))
            .then(b.tab.last_activity.cmp(&a.tab.last_activity))
            .then(a.tab.label.to_lowercase().cmp(&b.tab.label.to_lowercase()))
    });
    (
        StatusCode::OK,
        Json(json!({ "tabs": rows, "desktop_available": desktop_available })),
    )
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
    // `desktop_available` is whether the desktop *answered*, not whether its
    // socket file exists: that file outlives an exit (and every crash), so the
    // phone was told the desktop was there for as long as it stayed closed —
    // and on Windows the nominal path is never a file, so it was never told.
    // A closed desktop refuses the connect at once, on both.
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let (desktop_available, agents, statuses, schedules) = match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::Catalog {
            request_id,
            project_id: Some(project.raw_id.clone()),
        },
    )
    .await
    {
        Ok(DesktopResponse::Catalog {
            agents,
            statuses,
            schedules,
        }) => (true, agents, statuses, schedules),
        _ => (false, vec![], vec![], vec![]),
    };
    let statuses = statuses
        .into_iter()
        .map(|status| (status.tmux_session.clone(), status))
        .collect::<HashMap<_, _>>();
    let mut schedules = schedules
        .into_iter()
        .map(|row| {
            (
                row.tmux_session,
                TabSchedules {
                    total: row.total,
                    enabled: row.enabled,
                    next: row.next,
                },
            )
        })
        .collect::<HashMap<_, _>>();
    for (tab, resolved) in tabs.iter_mut().zip(&project.tabs) {
        if tab.kind == "agent" {
            if let Some(status) = statuses.get(&resolved.tmux_name) {
                tab.agent_status = Some(status.status.clone());
                tab.agent_model = status.model.clone();
                tab.working_at = status.working_at;
                tab.done_at = status.done_at;
            }
            tab.schedules = schedules.remove(&resolved.tmux_name);
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
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    // Parsed only after the request is authenticated and same-origin: as a
    // `Json<T>` extractor this ran first, so an unauthenticated caller got a
    // 422 naming the fields of the desktop-bridge protocol.
    let Ok(mut request) = serde_json::from_slice::<CreateTabRequest>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
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
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(action) = serde_json::from_slice::<CalendarAction>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
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
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(action) = serde_json::from_slice::<TodoAction>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
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
            } else if code.ends_with("_disabled") {
                // The desktop setting is off: a refusal the phone should read
                // as "not allowed here", not as a malformed request.
                StatusCode::FORBIDDEN
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

/// The two mail mutations. Both are origin-checked like every other write,
/// validated here only for shape, and gated **on the desktop**: the sidecar
/// cannot read mail settings and must not start to. The desktop answers with
/// the refreshed folder page so the phone's list is right without a second
/// round trip.
async fn mail_mark(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((folder_id, message_id)): Path<(String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(mark) = serde_json::from_slice::<MailMarkBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if !valid_mail_id(&folder_id) || !valid_mail_id(&message_id) || mark.offset > 100_000 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    mail_response(
        admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::MailMark {
                request_id,
                folder_id,
                message_id,
                offset: mark.offset,
                action: mark.action,
            },
        )
        .await,
    )
}

async fn mail_reply(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((folder_id, message_id)): Path<(String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(reply) = serde_json::from_slice::<MailReplyBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if !valid_mail_id(&folder_id) || !valid_mail_id(&message_id) || reply.offset > 100_000 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    if reply.body.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "empty_reply");
    }
    if reply.body.len() > MAX_MAIL_REPLY_BYTES {
        return api_error(StatusCode::PAYLOAD_TOO_LARGE, "reply_too_long");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    mail_response(
        admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::MailReply {
                request_id,
                folder_id,
                message_id,
                offset: reply.offset,
                body: reply.body,
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

/// A phone-supplied tab label. Anything the catalog would later truncate, or
/// that would smuggle control characters into a terminal title, is refused here
/// rather than stored and quietly re-rendered as something else.
fn clean_tab_label(raw: &str) -> Option<String> {
    let label = raw.trim();
    if label.is_empty()
        || label.chars().count() > MAX_TAB_LABEL
        || label.chars().any(char::is_control)
    {
        return None;
    }
    Some(label.to_string())
}

/// `PUT /api/v1/tabs/{id}` — rename one agent tab. The desktop owns the write
/// (the tab layout is its state, not the sidecar's), so this is a bridge call;
/// the fresh catalog read afterwards is what makes the new label visible to the
/// caller in the same response instead of one poll later.
async fn rename_tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RenameBody {
        label: String,
    }
    let Ok(request) = serde_json::from_slice::<RenameBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let Some(label) = clean_tab_label(&request.label) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_label");
    };
    let (project_id, tmux_session) = match agent_tab_target(&state, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::RenameTab {
            request_id,
            project_id,
            tmux_session: tmux_session.clone(),
            label,
        },
    )
    .await
    {
        Ok(DesktopResponse::Renamed { label }) => {
            let row = catalog_fresh(&state)
                .ok()
                .and_then(|next| next.tab(&tab_id).map(|(_, tab)| tab.public.clone()));
            match row {
                Some(mut row) => {
                    row.viewer_busy = state.terminal_registry.is_busy(&tmux_session);
                    (StatusCode::OK, Json(json!({ "tab": row })))
                }
                // The desktop persists asynchronously, so a catalog that has not
                // caught up yet is not a failed rename; answer with what the
                // desktop stored and let the screen's poll bring the rest.
                None => (StatusCode::OK, Json(json!({ "label": label }))),
            }
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            match code.as_str() {
                "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                "tab_not_found" => StatusCode::NOT_FOUND,
                _ => StatusCode::BAD_REQUEST,
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

fn schedule_desktop_error(
    response: Result<DesktopResponse, String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match response {
        Ok(DesktopResponse::Schedules {
            schedules,
            time_zone,
            next_runs,
        }) => (
            StatusCode::OK,
            Json(json!({
                "schedules": schedules,
                "time_zone": time_zone,
                "next_runs": next_runs,
            })),
        ),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "tab_not_found" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// Resolve an opaque tab id to the (raw project id, tmux name) pair the
/// desktop bridge addresses an agent tab by. Shared by the schedule routes and
/// the rename route; neither value is ever serialized back to the phone.
fn agent_tab_target(
    state: &HostState,
    tab_id: &str,
) -> Result<(String, String), (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state)?;
    let Some((project, tab)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    if tab.public.kind != "agent" {
        return Err(api_error(StatusCode::BAD_REQUEST, "agent_tab_required"));
    }
    Ok((project.raw_id.clone(), tab.tmux_name.clone()))
}

async fn schedules(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let (project_id, tmux_session) = match agent_tab_target(&state, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    schedule_desktop_error(
        admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::Schedules {
                request_id,
                project_id,
                tmux_session,
            },
        )
        .await,
    )
}

/// `?refresh=1` — ask the desktop to run the agent's CLI again rather than
/// answering from its own short-lived cache. Anything else reads as "no".
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct AgentStatusQuery {
    refresh: Option<String>,
}

/// `GET /api/v1/tabs/{tab_id}/status` — the phone's status button on an agent
/// tab. The desktop answers with what the session is doing plus the panel its
/// CLI prints for `/usage`; reading that panel may spawn the CLI once in print
/// mode, which is why this request carries a longer deadline than the other
/// control calls (`DesktopRequest::response_timeout`).
async fn agent_status(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    Query(query): Query<AgentStatusQuery>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let (project_id, tmux_session) = match agent_tab_target(&state, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let refresh = matches!(query.refresh.as_deref(), Some("1" | "true"));
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::AgentStatus {
            request_id,
            project_id,
            tmux_session,
            refresh,
        },
    )
    .await
    {
        Ok(DesktopResponse::AgentStatus { report }) => (
            StatusCode::OK,
            Json(json!({ "report": report })),
        ),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "tab_not_found" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

async fn schedule_mutation(
    state: &HostState,
    tab_id: &str,
    action: ScheduleMutation,
) -> (StatusCode, Json<serde_json::Value>) {
    let (project_id, tmux_session) = match agent_tab_target(state, tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    schedule_desktop_error(
        admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::ScheduleMutate {
                request_id,
                project_id,
                tmux_session,
                action,
            },
        )
        .await,
    )
}

async fn schedule_create(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(schedule) = serde_json::from_slice::<MobileScheduleInput>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let (status, body) =
        schedule_mutation(&state, &tab_id, ScheduleMutation::Create { schedule }).await;
    (
        if status == StatusCode::OK {
            StatusCode::CREATED
        } else {
            status
        },
        body,
    )
}

async fn schedule_update(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((tab_id, schedule_id)): Path<(String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(schedule) = serde_json::from_slice::<MobileScheduleInput>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    schedule_mutation(
        &state,
        &tab_id,
        ScheduleMutation::Update {
            schedule_id,
            schedule,
        },
    )
    .await
}

async fn schedule_delete(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((tab_id, schedule_id)): Path<(String, String)>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    schedule_mutation(&state, &tab_id, ScheduleMutation::Delete { schedule_id }).await
}

// ── Project prompt collection ────────────────────────────────────────────────
// Prompts are project-scoped and tab-free, so the routes hang off the opaque
// project id; only `send` names a tab, and that tab must be an agent tab of
// the same project. The desktop owns ids, timestamps and "now".

fn prompt_desktop_error(
    response: Result<DesktopResponse, String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match response {
        Ok(DesktopResponse::Prompts { prompts }) => {
            (StatusCode::OK, Json(json!({ "prompts": prompts })))
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            match code.as_str() {
                "tab_not_found" | "prompt_not_found" => StatusCode::NOT_FOUND,
                "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                _ => StatusCode::BAD_REQUEST,
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

fn prompt_project(
    state: &HostState,
    project_id: &str,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state)?;
    let Some(project) = catalog.project(project_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "project_not_found"));
    };
    Ok(project.raw_id.clone())
}

async fn prompts_call(
    state: &HostState,
    request: DesktopRequest,
) -> (StatusCode, Json<serde_json::Value>) {
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    prompt_desktop_error(admin::desktop_call(&desktop_socket, &request).await)
}

async fn prompts(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let project_id = match prompt_project(&state, &project_id) {
        Ok(raw) => raw,
        Err(error) => return error,
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    prompts_call(
        &state,
        DesktopRequest::Prompts {
            request_id,
            project_id,
        },
    )
    .await
}

/// Authentication and origin come before the body is even parsed, so an
/// anonymous or cross-origin request learns nothing from a validation error.
fn mutation_guard(
    headers: &HeaderMap,
    state: &HostState,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    authenticate(headers, state)?;
    if !exact_origin(headers, state) {
        return Err(api_error(StatusCode::FORBIDDEN, "invalid_origin"));
    }
    Ok(())
}

async fn prompt_mutation(
    state: &HostState,
    project_id: &str,
    action: PromptMutation,
) -> (StatusCode, Json<serde_json::Value>) {
    let project_id = match prompt_project(state, project_id) {
        Ok(raw) => raw,
        Err(error) => return error,
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    prompts_call(
        state,
        DesktopRequest::PromptMutate {
            request_id,
            project_id,
            action,
        },
    )
    .await
}

async fn prompt_create(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    let Ok(prompt) = serde_json::from_slice::<MobilePromptInput>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let (status, body) =
        prompt_mutation(&state, &project_id, PromptMutation::Create { prompt }).await;
    (
        if status == StatusCode::OK {
            StatusCode::CREATED
        } else {
            status
        },
        body,
    )
}

async fn prompt_update(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((project_id, prompt_id)): Path<(String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    let Ok(prompt) = serde_json::from_slice::<MobilePromptInput>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    prompt_mutation(
        &state,
        &project_id,
        PromptMutation::Update { prompt_id, prompt },
    )
    .await
}

async fn prompt_delete(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((project_id, prompt_id)): Path<(String, String)>,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    prompt_mutation(&state, &project_id, PromptMutation::Delete { prompt_id }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PromptSendBody {
    tab_id: String,
}

async fn prompt_send(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((project_id, prompt_id)): Path<(String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    let Ok(send) = serde_json::from_slice::<PromptSendBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    // The tab is resolved here, before the generic mutation path, so a tab id
    // from another project can never aim a prompt across projects.
    let tmux_session = {
        let catalog = match catalog(&state) {
            Ok(catalog) => catalog,
            Err(error) => return error,
        };
        let Some((tab_project, tab)) = catalog.tab(&send.tab_id) else {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        };
        if tab.public.kind != "agent" {
            return api_error(StatusCode::BAD_REQUEST, "agent_tab_required");
        }
        if catalog.project(&project_id).map(|project| project.raw_id.as_str())
            != Some(tab_project.raw_id.as_str())
        {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        }
        tab.tmux_name.clone()
    };
    prompt_mutation(
        &state,
        &project_id,
        PromptMutation::Send {
            prompt_id,
            tmux_session,
        },
    )
    .await
}

/// Tell the desktop a phone had this agent tab on screen, so its activity
/// store marks the tab's output read (see `clearAttention`). Fire-and-forget:
/// nothing in the terminal path may wait on the desktop, which is why this
/// spawns rather than awaits — a wedged bridge would otherwise hold the
/// WebSocket attach for the full control-call deadline.
fn mark_tab_seen(socket: &std::path::Path, project_id: Option<String>, tmux_session: String) {
    let Some(project_id) = project_id else {
        return;
    };
    let socket = socket.to_path_buf();
    tokio::spawn(async move {
        // No `exists()` pre-check: a closed desktop refuses the connect at
        // once, and on Windows the nominal socket path is never a file, so the
        // check silently dropped every report there.
        let request_id = Base64UrlUnpadded::encode_string(&random_16());
        let _ = admin::desktop_call(
            &socket,
            &DesktopRequest::TabSeen {
                request_id,
                project_id,
                tmux_session,
            },
        )
        .await;
    });
}

/// Tell the desktop a phone typed into this agent tab, so its activity store
/// counts the session as commanded and classifies what follows (see
/// `noteUserInput`). Fire-and-forget for the same reason `mark_tab_seen` is:
/// nothing in the terminal path may wait on the desktop.
fn mark_tab_input(socket: &std::path::Path, project_id: Option<String>, tmux_session: String) {
    let Some(project_id) = project_id else {
        return;
    };
    let socket = socket.to_path_buf();
    tokio::spawn(async move {
        let request_id = Base64UrlUnpadded::encode_string(&random_16());
        let _ = admin::desktop_call(
            &socket,
            &DesktopRequest::TabInput {
                request_id,
                project_id,
                tmux_session,
            },
        )
        .await;
    });
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
    let Some((tab_project, tab)) = catalog.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found").into_response();
    };
    if !tab.public.available {
        return api_error(StatusCode::GONE, "session_gone").into_response();
    }
    // Only an agent tab carries a status the phone can retire; a shell raises
    // none, so it never needs the desktop told about it.
    let seen_project = (tab.public.kind == "agent").then(|| tab_project.raw_id.clone());
    // Deliberately no `session_busy` pre-check: the bridge now displaces a
    // stale viewer instead, so a phone that was backgrounded before its
    // `detached` frame flushed does not lock the user out of their own agent
    // until the idle reaper (`pty_bridge::IDLE_TIMEOUT`) fires. A genuinely live viewer that
    // refuses to yield still produces `session_busy`, from the bridge.
    let tmux = tab.tmux_name.clone();
    let registry = state.terminal_registry.clone();
    let auth = state.auth.clone();
    let token = cookie_token(&headers).unwrap_or_default().to_string();
    let state_dir = state.config.state_dir.clone();
    let catalog = state.catalog.clone();
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let seen_tmux = tmux.clone();
    let input_socket = desktop_socket.clone();
    let input_project = seen_project.clone();
    let input_tmux = tmux.clone();
    // `DefaultBodyLimit` does not reach WebSocket frames, and tungstenite's
    // default is 64 MiB — so `MAX_INPUT_FRAME` was only checked *after* the
    // server had already buffered a thousandfold more than it allows.
    ws.protocols([TERMINAL_PROTOCOL])
        .max_message_size(MAX_INPUT_FRAME)
        .max_frame_size(MAX_INPUT_FRAME)
        .on_upgrade(move |socket| async move {
            // Opening the tab on the phone reads its output, exactly as
            // switching to it on the desktop does — and closing it again is the
            // last moment the screen was in front of somebody. Both edges are
            // stamped, so a turn that finished while the phone was watching
            // does not come back as an unread `done` the moment it detaches.
            mark_tab_seen(&desktop_socket, seen_project.clone(), seen_tmux.clone());
            let _ = pty_bridge::attach(
                socket,
                tmux,
                registry,
                auth,
                token,
                state_dir,
                tab_id,
                catalog,
                move || {
                    mark_tab_input(&input_socket, input_project.clone(), input_tmux.clone());
                },
            )
            .await;
            mark_tab_seen(&desktop_socket, seen_project, seen_tmux);
        })
}

#[derive(Deserialize)]
struct InboxQuery {
    /// The phone's file name — a query parameter because a header cannot
    /// carry a non-Latin-1 name and the phone's photo library is not ASCII.
    #[serde(default)]
    name: String,
}

/// `POST /api/v1/tabs/{tab_id}/inbox` — the composer's **+ → From this phone**.
/// The raw body is the file; it lands in the tab's project under
/// `.eldrun/inbox/` and the phone gets the project-relative reference back to
/// put after an `@`. The tab names the project and nothing else: a session
/// that has ended can still receive a file for the next one. See
/// `inbox.rs` for why a relative reference may cross the boundary.
async fn inbox_upload(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    Query(query): Query<InboxQuery>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(catalog) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some((project, _)) = catalog.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    let root = project.root.clone();
    drop(catalog);
    // The write is synchronous filesystem work of up to MAX_INBOX_FILE bytes;
    // keep it off the connection executor.
    let stored = tokio::task::spawn_blocking(move || inbox::store(&root, &query.name, &body))
        .await
        .unwrap_or_else(|error| Err(inbox::InboxError::Io(error.to_string())));
    match stored {
        Ok(stored) => (
            StatusCode::CREATED,
            Json(json!({ "attachment": {
                "name": stored.name,
                "reference": stored.reference,
                "size": stored.size,
            } })),
        ),
        Err(error) => api_error(
            match error {
                inbox::InboxError::Empty => StatusCode::BAD_REQUEST,
                inbox::InboxError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
                inbox::InboxError::Full => StatusCode::INSUFFICIENT_STORAGE,
                inbox::InboxError::Unavailable => StatusCode::CONFLICT,
                inbox::InboxError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
            },
            error.code(),
        ),
    }
}

/// The project an inbox-bound request is for, by its tab — the tab names the
/// project and nothing else, exactly as `inbox_upload` reads it.
fn inbox_project(
    state: &HostState,
    tab_id: &str,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state)?;
    let Some((project, _)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    Ok(project.raw_id.clone())
}

/// The desktop's refusal of a desktop-image request, as the phone's status.
/// The inbox codes map exactly as `inbox_upload` maps them, so the phone
/// reads one vocabulary for both ways of filling the inbox.
fn desktop_image_error(code: &str) -> (StatusCode, Json<serde_json::Value>) {
    api_error(
        match code {
            "tab_not_found" | "project_ineligible" | "image_not_found" => StatusCode::NOT_FOUND,
            "no_clipboard_image" | "project_unavailable" => StatusCode::CONFLICT,
            "file_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
            "inbox_full" => StatusCode::INSUFFICIENT_STORAGE,
            "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::BAD_REQUEST,
        },
        code,
    )
}

/// `GET /api/v1/tabs/{tab_id}/desktop-images` — the composer's **+ → From the
/// desktop**: what the desktop would copy into this tab's project inbox (its
/// clipboard image, recent screenshots and pictures). Opaque ids and folder
/// labels only; the desktop keeps every path.
async fn desktop_images(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let project_id = match inbox_project(&state, &tab_id) {
        Ok(raw) => raw,
        Err(error) => return error,
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::DesktopImages {
            request_id,
            project_id,
        },
    )
    .await
    {
        Ok(DesktopResponse::DesktopImages { images }) => {
            (StatusCode::OK, Json(json!({ "images": images })))
        }
        Ok(DesktopResponse::Error { code, .. }) => desktop_image_error(&code),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

#[derive(Deserialize)]
struct AttachDesktopImageBody {
    image_id: String,
}

/// `POST /api/v1/tabs/{tab_id}/desktop-images` — copy one listed image into
/// the tab's project inbox. Answers like `inbox_upload`: the stored name, the
/// project-relative `.eldrun/inbox/<file>` reference, the size.
async fn attach_desktop_image(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    let Ok(request) = serde_json::from_slice::<AttachDesktopImageBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if !desktop_images::valid_id(&request.image_id) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let project_id = match inbox_project(&state, &tab_id) {
        Ok(raw) => raw,
        Err(error) => return error,
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::AttachDesktopImage {
            request_id,
            project_id,
            image_id: request.image_id,
        },
    )
    .await
    {
        Ok(DesktopResponse::Attached { attachment }) => (
            StatusCode::CREATED,
            Json(json!({ "attachment": attachment })),
        ),
        Ok(DesktopResponse::Error { code, .. }) => desktop_image_error(&code),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
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
        // The SPA fallback covers app routes only. A miss under `/assets/` or
        // `/api/` must be a plain 404: serving the shell for an unknown
        // endpoint turned a removed or mistyped route into a 200 full of HTML
        // that the client then tried to parse as JSON.
        None if requested.starts_with("/assets/") || requested.starts_with("/api/") => None,
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

/// The whole HTTP surface in one place, so tests can drive every route
/// through the same middleware stack the sidecar serves.
fn router(state: HostState) -> Router {
    Router::new()
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
        .route(
            "/api/v1/mail/folders/{folder_id}/messages/{message_id}/mark",
            post(mail_mark),
        )
        .route(
            "/api/v1/mail/folders/{folder_id}/messages/{message_id}/reply",
            post(mail_reply),
        )
        .route("/api/v1/activity", get(activity))
        .route("/api/v1/projects", get(projects))
        .route("/api/v1/projects/{project_id}", get(project))
        .route(
            "/api/v1/projects/{project_id}/activate",
            post(activate_project),
        )
        .route("/api/v1/projects/{project_id}/tabs", post(create_tab))
        .route(
            "/api/v1/projects/{project_id}/prompts",
            get(prompts).post(prompt_create),
        )
        .route(
            "/api/v1/projects/{project_id}/prompts/{prompt_id}",
            put(prompt_update).delete(prompt_delete),
        )
        .route(
            "/api/v1/projects/{project_id}/prompts/{prompt_id}/send",
            post(prompt_send),
        )
        .route("/api/v1/tabs/{tab_id}", get(tab).put(rename_tab))
        .route(
            "/api/v1/tabs/{tab_id}/schedules",
            get(schedules).post(schedule_create),
        )
        .route(
            "/api/v1/tabs/{tab_id}/schedules/{schedule_id}",
            put(schedule_update).delete(schedule_delete),
        )
        .route("/api/v1/tabs/{tab_id}/status", get(agent_status))
        .route("/api/v1/tabs/{tab_id}/terminal", get(terminal))
        // The phone's drop box takes a whole photo; every other body stays at
        // the control-message limit below (the inner layer wins).
        .route(
            "/api/v1/tabs/{tab_id}/inbox",
            post(inbox_upload).layer(DefaultBodyLimit::max(inbox::MAX_INBOX_FILE)),
        )
        .route(
            "/api/v1/tabs/{tab_id}/desktop-images",
            get(desktop_images).post(attach_desktop_image),
        )
        .route("/", get(index))
        .route("/{*path}", get(static_asset))
        .layer(DefaultBodyLimit::max(MAX_CONTROL_MESSAGE))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
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
    let app = router(state);
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
    use super::*;

    use axum::body::to_bytes;
    use p256::{
        ecdsa::{signature::Signer, Signature, SigningKey},
        pkcs8::EncodePublicKey,
    };
    use serde_json::Value;
    use tower::ServiceExt;

    use crate::services::mobile_control::config::MobileHostSettings;

    const ORIGIN: &str = "https://desk.example.ts.net";
    /// A raw project id and a filesystem path the phone must never be able to
    /// read back out of any response.
    const RAW_BOX: &str = "b-mobile";
    const RAW_PROJECT: &str = "raw-project-id-7f3";

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        state: HostState,
    }

    impl Fixture {
        /// A host with no project catalog at all.
        fn bare() -> Self {
            let dir = tempfile::tempdir().expect("state dir");
            let state_dir = dir.path().to_path_buf();
            let control_dir = state_dir.join("mobile-control");
            let auth = AuthStore::open(&control_dir, ORIGIN.to_string()).expect("auth store");
            let root = state_dir.join("work");
            std::fs::create_dir_all(&root).expect("project root");
            Self {
                _dir: dir,
                root,
                state: HostState {
                    config: HostConfig {
                        state_dir,
                        control_dir,
                        host: MobileHostSettings {
                            display_name: "Desk".into(),
                            ..MobileHostSettings::default()
                        },
                        origin: ORIGIN.into(),
                    },
                    auth: Arc::new(Mutex::new(auth)),
                    catalog: Arc::new(Mutex::new(CatalogCache::default())),
                    terminal_registry: TerminalRegistry::default(),
                },
            }
        }

        /// A host with one opted-in project holding one resumable agent tab.
        fn with_project() -> Self {
            let fixture = Self::bare();
            let state_dir = &fixture.state.config.state_dir;
            std::fs::write(
                state_dir.join("projects.json"),
                serde_json::to_vec(&serde_json::json!([{
                    "id": RAW_PROJECT,
                    "name": "Aurora",
                    "status": "active",
                    "directory": fixture.root.to_string_lossy(),
                    "eldrun_mobile_access": true,
                }]))
                .expect("projects fixture"),
            )
            .expect("write projects");
            let sessions = state_dir.join("sessions").join(RAW_PROJECT);
            std::fs::create_dir_all(&sessions).expect("session dir");
            std::fs::write(
                sessions.join("terminals.json"),
                serde_json::to_vec(&serde_json::json!({
                    "tabLayout": [{
                        "label": "Claude",
                        "cmd": "claude",
                        "cwd": fixture.root.to_string_lossy(),
                        "kind": "agent",
                        "sessionId": "9d0f-session",
                        "tmuxSession": format!("eldrun-{RAW_PROJECT}--agent-abcdef123"),
                    }]
                }))
                .expect("session fixture"),
            )
            .expect("write session");
            fixture
        }

        /// A host with one opted-in project (Mobile OFF on the project itself)
        /// that is the member of one opted-in box holding one shell tab in the
        /// member's tree and one in the box folder, plus one box with Mobile off.
        fn with_box() -> Self {
            let fixture = Self::bare();
            let state_dir = &fixture.state.config.state_dir;
            let folder = state_dir.join("boxes").join("paper");
            std::fs::create_dir_all(&folder).expect("box folder");
            std::fs::write(
                state_dir.join("projects.json"),
                serde_json::to_vec(&serde_json::json!([{
                    "id": RAW_PROJECT,
                    "name": "Aurora",
                    "status": "inactive",
                    "directory": fixture.root.to_string_lossy(),
                }]))
                .expect("projects fixture"),
            )
            .expect("write projects");
            std::fs::write(
                state_dir.join("boxes.json"),
                serde_json::to_vec(&serde_json::json!([
                    { "id": RAW_BOX, "name": "Paper", "member_ids": [RAW_PROJECT],
                      "folder": folder.to_string_lossy(), "eldrun_mobile_access": true },
                    { "id": "b-off", "name": "Private", "member_ids": [RAW_PROJECT],
                      "folder": folder.to_string_lossy() },
                ]))
                .expect("boxes fixture"),
            )
            .expect("write boxes");
            let sessions = state_dir.join("sessions").join(format!("box_{RAW_BOX}"));
            std::fs::create_dir_all(&sessions).expect("session dir");
            std::fs::write(
                sessions.join("terminals.json"),
                serde_json::to_vec(&serde_json::json!({
                    "tabLayout": [{
                        "label": "Box shell",
                        "cmd": "bash",
                        "cwd": folder.to_string_lossy(),
                        "kind": "shell",
                        "tmuxSession": format!("eldrun-box_{RAW_BOX}--shell-abcdef123"),
                    }, {
                        "label": "Aurora shell",
                        "cmd": "bash",
                        "cwd": fixture.root.to_string_lossy(),
                        "kind": "shell",
                        "tmuxSession": format!("eldrun-box_{RAW_BOX}--shell-bcdef1234"),
                    }]
                }))
                .expect("session fixture"),
            )
            .expect("write session");
            fixture
        }

        async fn send(&self, request: Request<Body>) -> (StatusCode, HeaderMap, String) {
            let response = router(self.state.clone())
                .oneshot(request)
                .await
                .expect("router response");
            let status = response.status();
            let headers = response.headers().clone();
            let body = to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("response body");
            (status, headers, String::from_utf8_lossy(&body).into_owned())
        }

        /// The real pair → challenge → sign → session flow, returning the
        /// session cookie and the paired device id.
        async fn pair_device(&self, signing: &SigningKey) -> (String, String) {
            let code = self
                .state
                .auth
                .lock()
                .unwrap()
                .create_pairing_code()
                .expect("pairing code")
                .0;
            let public_key = Base64UrlUnpadded::encode_string(
                signing
                    .verifying_key()
                    .to_public_key_der()
                    .expect("public key der")
                    .as_bytes(),
            );
            let (status, _, body) = self
                .send(post_json(
                    "/api/v1/pair",
                    ORIGIN,
                    &serde_json::json!({
                        "code": code,
                        "device_name": "Phone",
                        "public_key": public_key,
                    }),
                ))
                .await;
            assert_eq!(status, StatusCode::CREATED, "pair failed: {body}");
            let device_id = json(&body)["device_id"].as_str().expect("device id").into();

            let (status, _, body) = self
                .send(post_json(
                    "/api/v1/auth/challenge",
                    ORIGIN,
                    &serde_json::json!({ "device_id": device_id }),
                ))
                .await;
            assert_eq!(status, StatusCode::OK, "challenge failed: {body}");
            let challenge = json(&body);
            let nonce = challenge["nonce"].as_str().expect("nonce").to_string();
            let payload = challenge["payload"].as_str().expect("payload").to_string();

            let (status, headers, body) = self
                .send(post_json(
                    "/api/v1/auth/session",
                    ORIGIN,
                    &serde_json::json!({
                        "device_id": device_id,
                        "nonce": nonce,
                        "signature": sign(signing, &payload),
                    }),
                ))
                .await;
            assert_eq!(status, StatusCode::OK, "login failed: {body}");
            (set_cookie(&headers), device_id)
        }
    }

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_slice(&[seed; 32]).expect("test signing key")
    }

    fn sign(signing: &SigningKey, payload: &str) -> String {
        let signature: Signature = signing.sign(payload.as_bytes());
        Base64UrlUnpadded::encode_string(&signature.to_bytes())
    }

    fn json(body: &str) -> Value {
        serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
    }

    fn set_cookie(headers: &HeaderMap) -> String {
        headers
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .expect("Set-Cookie")
            .to_string()
    }

    fn cookie_pair(set_cookie: &str) -> String {
        set_cookie
            .split(';')
            .next()
            .expect("cookie pair")
            .trim()
            .to_string()
    }

    fn get_request(uri: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .body(Body::empty())
            .expect("request")
    }

    fn get_as(uri: &str, cookie: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header(header::COOKIE, cookie_pair(cookie))
            .body(Body::empty())
            .expect("request")
    }

    fn post_json(uri: &str, origin: &str, body: &Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::ORIGIN, origin)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(body).expect("body")))
            .expect("request")
    }

    /// Every route that serves project, tab, mail, calendar or task data.
    const AUTHENTICATED_GETS: &[&str] = &[
        "/api/v1/status",
        "/api/v1/todo",
        "/api/v1/alerts",
        "/api/v1/calendar",
        "/api/v1/mail",
        "/api/v1/mail/folders/anything",
        "/api/v1/mail/folders/anything/messages/anything",
        "/api/v1/activity",
        "/api/v1/projects",
        "/api/v1/projects/anything",
        "/api/v1/tabs/anything",
        "/api/v1/tabs/anything/schedules",
        "/api/v1/projects/anything/prompts",
        "/api/v1/tabs/anything/desktop-images",
    ];

    #[test]
    fn mobile_policy_allows_only_same_origin_microphone_capture() {
        assert!(MOBILE_PERMISSIONS_POLICY.contains("microphone=(self)"));
        assert!(MOBILE_PERMISSIONS_POLICY.contains("on-device-speech-recognition=(self)"));
        assert!(MOBILE_PERMISSIONS_POLICY.contains("camera=()"));
        assert!(!MOBILE_PERMISSIONS_POLICY.contains("microphone=()"));
        assert!(!MOBILE_PERMISSIONS_POLICY.contains("microphone=(*"));
    }

    #[tokio::test]
    async fn every_data_route_refuses_an_unauthenticated_request() {
        let host = Fixture::with_project();
        for uri in AUTHENTICATED_GETS {
            let (status, _, body) = host.send(get_request(uri)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} answered: {body}");
            assert_eq!(json(&body)["error"], "authentication_required", "{uri}");
        }
    }

    #[tokio::test]
    async fn mutating_routes_refuse_an_unauthenticated_request() {
        let host = Fixture::with_project();
        let create = serde_json::json!({
            "project_id": "anything",
            "kind": "shell",
            "idempotency_key": "0123456789abcdef",
        });
        for uri in [
            "/api/v1/projects/anything/tabs",
            "/api/v1/projects/anything/activate",
            "/api/v1/todo",
            "/api/v1/calendar",
            "/api/v1/tabs/anything/schedules",
            "/api/v1/tabs/anything/inbox",
            "/api/v1/tabs/anything/desktop-images",
            "/api/v1/projects/anything/prompts",
            "/api/v1/projects/anything/prompts/anything/send",
            "/api/v1/mail/folders/anything/messages/anything/mark",
            "/api/v1/mail/folders/anything/messages/anything/reply",
        ] {
            let (status, _, body) = host.send(post_json(uri, ORIGIN, &create)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} answered: {body}");
        }
        // The rename route is the one mutation that is a PUT on a GET path.
        let put = Request::builder()
            .method("PUT")
            .uri("/api/v1/tabs/anything")
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({ "label": "x" })).expect("body"),
            ))
            .expect("request");
        let (status, _, body) = host.send(put).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {body}");
    }

    #[tokio::test]
    async fn schedule_editor_requires_the_desktop_bridge_and_leaks_no_raw_target() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(12)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"]
            .as_str()
            .expect("opaque project id")
            .to_string();
        let (_, _, project_body) = host
            .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
            .await;
        let tab_id = json(&project_body)["tabs"][0]["id"]
            .as_str()
            .expect("opaque tab id")
            .to_string();

        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/tabs/{tab_id}/schedules"), &cookie))
            .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
        assert_eq!(json(&body)["error"], "desktop_unavailable");
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains(&host.root.to_string_lossy().to_string()));
        assert!(!body.contains("scheduleTargetId"));
    }

    #[tokio::test]
    async fn the_activity_list_answers_an_empty_list_when_no_desktop_classifies_tabs() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(21)).await.0;
        let (status, _, body) = host.send(get_as("/api/v1/activity", &cookie)).await;
        // A closed desktop is not an error here: the phone shows the list empty
        // and says why, the same way the project overview does.
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false);
        assert_eq!(json(&body)["tabs"].as_array().expect("tabs").len(), 0);
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains("eldrun-"));
    }

    #[test]
    fn the_activity_list_puts_a_waiting_session_first_and_a_finished_one_last() {
        assert!(activity_rank("question") < activity_rank("working"));
        assert!(activity_rank("working") < activity_rank("done"));
    }

    #[test]
    fn a_tab_label_is_refused_before_it_can_be_silently_truncated_or_smuggled() {
        assert_eq!(clean_tab_label("  Review  ").as_deref(), Some("Review"));
        assert_eq!(clean_tab_label("   "), None);
        assert!(clean_tab_label(&"x".repeat(MAX_TAB_LABEL)).is_some());
        assert_eq!(clean_tab_label(&"x".repeat(MAX_TAB_LABEL + 1)), None);
        // A control character would reach a terminal title verbatim.
        assert_eq!(clean_tab_label("Claude\u{1b}]0;pwned\u{7}"), None);
        assert_eq!(clean_tab_label("Claude\nrm -rf"), None);
        // The cap counts characters, not bytes: an emoji name is not 4x longer.
        assert!(clean_tab_label(&"\u{1f680}".repeat(MAX_TAB_LABEL)).is_some());
    }

    #[tokio::test]
    async fn renaming_a_tab_needs_the_desktop_bridge_a_same_origin_and_a_usable_label() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(16)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"]
            .as_str()
            .expect("opaque project id")
            .to_string();
        let (_, _, project_body) = host
            .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
            .await;
        let tab_id = json(&project_body)["tabs"][0]["id"]
            .as_str()
            .expect("opaque tab id")
            .to_string();

        let rename = |origin: &'static str, label: &str| {
            Request::builder()
                .method("PUT")
                .uri(format!("/api/v1/tabs/{tab_id}"))
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({ "label": label })).expect("body"),
                ))
                .expect("request")
        };

        // Origin is checked before the label and before any desktop call.
        let (status, _, body) = host.send(rename("https://evil.example", "Owned")).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");

        let (status, _, body) = host.send(rename(ORIGIN, "   ")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        assert_eq!(json(&body)["error"], "invalid_label");

        // A well-formed rename with no desktop window is unavailable, not an
        // error the phone should read as "the name was rejected" — and it still
        // leaks neither the raw project id nor the tmux name.
        let (status, _, body) = host.send(rename(ORIGIN, "Release review")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
        assert_eq!(json(&body)["error"], "desktop_unavailable");
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains("eldrun-"));
    }

    #[tokio::test]
    async fn mail_writes_check_origin_and_shape_before_the_desktop_bridge() {
        let host = Fixture::bare();
        let cookie = host.pair_device(&signing_key(17)).await.0;
        let post = |uri: &str, origin: &'static str, body: Value| {
            Request::builder()
                .method("POST")
                .uri(uri.to_string())
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).expect("body")))
                .expect("request")
        };
        let mark = "/api/v1/mail/folders/folder-1/messages/message-1/mark";
        let reply = "/api/v1/mail/folders/folder-1/messages/message-1/reply";

        // Origin first, before the body is even parsed.
        let (status, _, body) = host
            .send(post(mark, "https://evil.example", serde_json::json!({ "action": "seen" })))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");
        assert_eq!(json(&body)["error"], "invalid_origin");

        // Only the four flag verbs exist: no delete, no move, no free-form flag.
        for action in ["deleted", "move", "\\Seen", ""] {
            let (status, _, body) = host
                .send(post(mark, ORIGIN, serde_json::json!({ "action": action })))
                .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{action} answered: {body}");
            assert_eq!(json(&body)["error"], "invalid_request", "{action}");
        }
        // Ids are validated exactly as the read routes validate them.
        let (status, _, body) = host
            .send(post(
                "/api/v1/mail/folders/../messages/message-1/mark",
                ORIGIN,
                serde_json::json!({ "action": "seen" }),
            ))
            .await;
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
            "answered: {body}"
        );

        // A reply carries text and nothing else: no recipient, subject or
        // headers are accepted from the phone.
        let (status, _, body) = host
            .send(post(
                reply,
                ORIGIN,
                serde_json::json!({ "body": "Thanks", "to": "someone@example.test" }),
            ))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        let (status, _, body) = host
            .send(post(reply, ORIGIN, serde_json::json!({ "body": "   " })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        assert_eq!(json(&body)["error"], "empty_reply");
        let (status, _, body) = host
            .send(post(
                reply,
                ORIGIN,
                serde_json::json!({ "body": "x".repeat(MAX_MAIL_REPLY_BYTES + 1) }),
            ))
            .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "answered: {body}");

        // Well-formed writes with no desktop window are unavailable, not
        // silently accepted: the sidecar never touches mail itself.
        for (uri, body) in [
            (mark, serde_json::json!({ "action": "flag", "offset": 25 })),
            (reply, serde_json::json!({ "body": "On my way." })),
        ] {
            let (status, _, answer) = host.send(post(uri, ORIGIN, body)).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{uri} answered: {answer}");
            assert_eq!(json(&answer)["error"], "desktop_unavailable", "{uri}");
        }
    }

    #[tokio::test]
    async fn prompt_collection_requires_the_desktop_bridge_and_checks_origin() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(14)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"]
            .as_str()
            .expect("opaque project id")
            .to_string();
        let (_, _, project_body) = host
            .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
            .await;
        let tab_id = json(&project_body)["tabs"][0]["id"]
            .as_str()
            .expect("opaque tab id")
            .to_string();

        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{project_id}/prompts"), &cookie))
            .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
        assert_eq!(json(&body)["error"], "desktop_unavailable");
        assert!(!body.contains(RAW_PROJECT));

        let (status, _, body) = host
            .send(get_as("/api/v1/projects/nope/prompts", &cookie))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

        // A mutation from a foreign origin is refused before any desktop call.
        let create = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/projects/{project_id}/prompts"))
            .header(header::ORIGIN, "https://evil.example")
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({ "message": "Review" })).expect("body"),
            ))
            .expect("request");
        let (status, _, answer) = host.send(create).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {answer}");

        // Sending names a tab of this project; a shell tab is not a target.
        let send = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/projects/{project_id}/prompts/anything/send"))
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({ "tab_id": tab_id })).expect("body"),
            ))
            .expect("request");
        let (status, _, answer) = host.send(send).await;
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::SERVICE_UNAVAILABLE,
            "answered {status}: {answer}"
        );
        assert!(!answer.contains(RAW_PROJECT));
        assert!(!answer.contains("tmux"));
    }

    #[tokio::test]
    async fn a_session_cookie_must_carry_the_exact_host_prefixed_name() {
        let host = Fixture::bare();
        let cookie = host.pair_device(&signing_key(9)).await.0;
        let token = cookie_pair(&cookie)
            .split_once('=')
            .expect("token")
            .1
            .to_string();

        let (status, ..) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::OK);

        // The same token under an unprefixed name carries none of the
        // `__Host-` guarantees and must not authenticate.
        let request = Request::builder()
            .uri("/api/v1/status")
            .header(header::COOKIE, format!("eldrun_session={token}"))
            .body(Body::empty())
            .expect("request");
        let (status, _, body) = host.send(request).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {body}");
    }

    #[tokio::test]
    async fn mutating_routes_require_the_exact_serve_origin() {
        let host = Fixture::bare();
        let cookie = host.pair_device(&signing_key(11)).await.0;
        let body = serde_json::json!({ "device_id": "anything" });
        // A prefix of the real origin, a suffix of it, and no header at all.
        for origin in [
            "https://desk.example.ts.net.evil.example",
            "https://evil.example",
            "http://desk.example.ts.net",
            "null",
        ] {
            let (status, _, answer) = host.send(post_json("/api/v1/auth/challenge", origin, &body)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{origin} answered: {answer}");
            assert_eq!(json(&answer)["error"], "invalid_origin", "{origin}");
        }
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/challenge")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).expect("body")))
            .expect("request");
        let (status, ..) = host.send(request).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "a missing Origin is not exact");

        // An authenticated mutation is refused on origin too, not just on session.
        let create = Request::builder()
            .method("POST")
            .uri("/api/v1/projects/anything/tabs")
            .header(header::ORIGIN, "https://evil.example")
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "project_id": "anything",
                    "kind": "shell",
                    "idempotency_key": "0123456789abcdef",
                }))
                .expect("body"),
            ))
            .expect("request");
        let (status, _, answer) = host.send(create).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {answer}");

        let schedule = Request::builder()
            .method("POST")
            .uri("/api/v1/tabs/anything/schedules")
            .header(header::ORIGIN, "https://evil.example")
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "enabled": true,
                    "message": "Review",
                    "rule": { "type": "daily", "time": "09:00" },
                }))
                .expect("body"),
            ))
            .expect("request");
        let (status, _, answer) = host.send(schedule).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {answer}");
    }

    #[tokio::test]
    async fn a_paired_login_issues_a_hardened_session_cookie() {
        let host = Fixture::bare();
        let (cookie, _) = host.pair_device(&signing_key(13)).await;
        for attribute in [
            "__Host-eldrun_session=",
            "Path=/",
            "Secure",
            "HttpOnly",
            "SameSite=Strict",
        ] {
            assert!(cookie.contains(attribute), "{attribute} missing from {cookie}");
        }
        let (status, headers, _) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn a_signature_from_another_key_never_logs_in() {
        let host = Fixture::bare();
        let device = host.pair_device(&signing_key(17)).await.1;
        let (_, _, body) = host
            .send(post_json(
                "/api/v1/auth/challenge",
                ORIGIN,
                &serde_json::json!({ "device_id": device }),
            ))
            .await;
        let challenge = json(&body);
        let (status, _, answer) = host
            .send(post_json(
                "/api/v1/auth/session",
                ORIGIN,
                &serde_json::json!({
                    "device_id": device,
                    "nonce": challenge["nonce"],
                    // Correct payload, wrong device key.
                    "signature": sign(&signing_key(18), challenge["payload"].as_str().unwrap()),
                }),
            ))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {answer}");
        assert_eq!(json(&answer)["error"], "invalid_signature");
    }

    #[tokio::test]
    async fn a_captured_challenge_cannot_be_replayed() {
        let host = Fixture::bare();
        let signing = signing_key(19);
        let device = host.pair_device(&signing).await.1;
        let (_, _, body) = host
            .send(post_json(
                "/api/v1/auth/challenge",
                ORIGIN,
                &serde_json::json!({ "device_id": device }),
            ))
            .await;
        let challenge = json(&body);
        let login = serde_json::json!({
            "device_id": device,
            "nonce": challenge["nonce"],
            "signature": sign(&signing, challenge["payload"].as_str().unwrap()),
        });
        let (first, ..) = host.send(post_json("/api/v1/auth/session", ORIGIN, &login)).await;
        assert_eq!(first, StatusCode::OK);
        let (second, _, answer) = host.send(post_json("/api/v1/auth/session", ORIGIN, &login)).await;
        assert_eq!(second, StatusCode::UNAUTHORIZED, "replay answered: {answer}");
        assert_eq!(json(&answer)["error"], "invalid_challenge");
    }

    #[tokio::test]
    async fn revoking_a_device_kills_its_live_session() {
        let host = Fixture::bare();
        let (cookie, device) = host.pair_device(&signing_key(23)).await;
        let (status, ..) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::OK);

        host.state.auth.lock().unwrap().revoke(&device).expect("revoke");

        let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "a lost phone kept access: {body}");
    }

    #[tokio::test]
    async fn logging_out_clears_the_cookie_and_the_session() {
        let host = Fixture::bare();
        let cookie = host.pair_device(&signing_key(29)).await.0;
        let request = Request::builder()
            .method("DELETE")
            .uri("/api/v1/auth/session")
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(&cookie))
            .body(Body::empty())
            .expect("request");
        let (status, headers, _) = host.send(request).await;
        assert_eq!(status, StatusCode::OK);
        assert!(set_cookie(&headers).contains("Max-Age=0"));

        let (status, ..) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_pairing_flood_is_rate_limited_at_the_http_edge() {
        let host = Fixture::bare();
        host.state
            .auth
            .lock()
            .unwrap()
            .create_pairing_code()
            .expect("pairing code");
        let guess = serde_json::json!({
            "code": "00000000",
            "device_name": "Attacker",
            "public_key": "not-a-key",
        });
        let mut limited = false;
        // One more than the pairing budget in `auth::PAIR_ATTEMPT_BUDGET`.
        for _ in 0..11 {
            let (status, _, body) = host.send(post_json("/api/v1/pair", ORIGIN, &guess)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
            limited |= json(&body)["error"] == "too_many_attempts";
        }
        assert!(limited, "the pair flood was never rate limited");
    }

    #[tokio::test]
    async fn an_oversized_control_body_never_reaches_a_handler() {
        let host = Fixture::bare();
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/pair")
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(vec![b'x'; MAX_CONTROL_MESSAGE + 1]))
            .expect("request");
        let (status, ..) = host.send(request).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn every_response_carries_the_hardened_security_headers() {
        let host = Fixture::bare();
        for uri in ["/healthz", "/api/v1/status", "/"] {
            let (_, headers, _) = host.send(get_request(uri)).await;
            assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff", "{uri}");
            assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY", "{uri}");
            assert!(
                headers[header::CONTENT_SECURITY_POLICY]
                    .to_str()
                    .unwrap()
                    .contains("frame-ancestors 'none'"),
                "{uri}"
            );
            assert_eq!(headers["permissions-policy"], MOBILE_PERMISSIONS_POLICY, "{uri}");
        }
        // Only the API and health probe are no-store; the shell is revalidated.
        let (_, api, _) = host.send(get_request("/api/v1/status")).await;
        assert_eq!(api[header::CACHE_CONTROL], "no-store");
        let (_, shell, _) = host.send(get_request("/")).await;
        assert_eq!(shell[header::CACHE_CONTROL], "no-cache");
    }

    #[tokio::test]
    async fn an_unknown_api_path_is_not_answered_with_the_app_shell() {
        let host = Fixture::bare();
        let (status, headers, body) = host.send(get_request("/api/v1/does-not-exist")).await;
        let content_type = headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(
            !content_type.contains("text/html"),
            "an /api/ miss served the SPA shell ({status}): {content_type}"
        );
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    }

    #[tokio::test]
    async fn the_catalog_hands_the_phone_opaque_ids_and_no_paths() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(31)).await.0;

        let (status, _, body) = host
            .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert!(body.contains("Aurora"), "the display label is missing: {body}");
        assert!(!body.contains(RAW_PROJECT), "a raw project id leaked: {body}");
        assert!(
            !body.contains(&host.root.to_string_lossy().to_string()),
            "a filesystem path leaked: {body}"
        );

        let opaque = json(&body)["projects"][0]["id"]
            .as_str()
            .expect("opaque project id")
            .to_string();

        // The opaque id resolves; the raw one the desktop uses does not.
        let (status, ..) = host
            .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{RAW_PROJECT}"), &cookie))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "a raw id resolved: {body}");
    }

    /// #31aa: a box with Mobile on is a row of the phone's list — kind `box`,
    /// always active, opaque id, no path, no raw id — and its own tabs come
    /// back under it, including the one running in a member's tree. The
    /// member's own Mobile switch is off, so the member is *not* a row; the
    /// box's switch reaches the box's tabs and nothing of the member's own.
    #[tokio::test]
    async fn a_mobile_enabled_box_is_listed_as_a_box_scope_with_its_own_tabs() {
        let host = Fixture::with_box();
        let cookie = host.pair_device(&signing_key(33)).await.0;

        let (status, _, body) = host.send(get_as("/api/v1/projects?view=active", &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let rows = json(&body)["projects"].as_array().cloned().unwrap_or_default();
        assert_eq!(rows.len(), 1, "one box, no member of its own: {body}");
        assert_eq!(rows[0]["label"], "Paper");
        assert_eq!(rows[0]["kind"], "box");
        assert_eq!(rows[0]["status"], "active");
        assert!(!body.contains(RAW_BOX), "a raw box id leaked: {body}");
        assert!(!body.contains(RAW_PROJECT), "a raw project id leaked: {body}");
        assert!(!body.contains("Private"), "a box with Mobile off is listed: {body}");
        assert!(
            !body.contains(&host.root.to_string_lossy().to_string()),
            "a filesystem path leaked: {body}"
        );

        let opaque = rows[0]["id"].as_str().expect("opaque box id").to_string();
        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let detail = json(&body);
        assert_eq!(detail["project"]["kind"], "box");
        let labels: Vec<String> = detail["tabs"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|tab| tab["label"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(labels, vec!["Box shell", "Aurora shell"], "{body}");
        assert!(!body.contains("box_"), "a session-dir or tmux name leaked: {body}");
    }

    #[tokio::test]
    async fn a_tab_without_a_live_session_is_reported_gone() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(37)).await.0;
        let (status, _, body) = host
            .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let opaque = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
        let (_, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
            .await;
        let tab = &json(&body)["tabs"][0];
        assert_eq!(tab["kind"], "agent");
        assert_eq!(
            tab["available"], false,
            "a tab with no tmux session must not be attachable: {body}"
        );
        assert!(!body.contains("eldrun-raw-project"), "a tmux name leaked: {body}");
    }

    #[tokio::test]
    async fn a_create_request_for_another_project_is_refused_before_any_state_is_read() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(41)).await.0;
        let request = |body: Value| {
            Request::builder()
                .method("POST")
                .uri("/api/v1/projects/target/tabs")
                .header(header::ORIGIN, ORIGIN)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).expect("body")))
                .expect("request")
        };
        // The body's project id disagrees with the path's.
        let (status, _, answer) = host
            .send(request(serde_json::json!({
                "project_id": "somewhere-else",
                "kind": "shell",
                "idempotency_key": "0123456789abcdef",
            })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {answer}");
        assert_eq!(json(&answer)["error"], "invalid_request");

        // An unknown project resolves to nothing rather than to a raw id.
        let (status, _, answer) = host
            .send(request(serde_json::json!({
                "project_id": "target",
                "kind": "shell",
                "idempotency_key": "0123456789abcdef",
            })))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {answer}");
    }

    /// The opaque id of the fixture project's one tab, as the phone sees it.
    async fn fixture_tab_id(host: &Fixture, cookie: &str) -> String {
        let (_, _, body) = host
            .send(get_as("/api/v1/projects?view=search&q=aurora", cookie))
            .await;
        let opaque = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
        let (_, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{opaque}"), cookie))
            .await;
        json(&body)["tabs"][0]["id"].as_str().unwrap().to_string()
    }

    fn inbox_request(tab_id: &str, name: &str, cookie: &str, bytes: Vec<u8>) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/tabs/{tab_id}/inbox?name={name}"))
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(cookie))
            .header(header::CONTENT_TYPE, "image/jpeg")
            .body(Body::from(bytes))
            .expect("request")
    }

    #[tokio::test]
    async fn desktop_images_need_the_bridge_a_known_tab_a_same_origin_and_a_listed_id() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(31)).await.0;
        let tab_id = fixture_tab_id(&host, &cookie).await;
        let attach = |tab: &str, origin: &str, body: Value| {
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/tabs/{tab}/desktop-images"))
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).expect("body")))
                .expect("request")
        };

        // No desktop window: unavailable, and neither the raw project id nor
        // the project path leaks out of the answer.
        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/tabs/{tab_id}/desktop-images"), &cookie))
            .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
        assert_eq!(json(&body)["error"], "desktop_unavailable");
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains(host.root.to_str().unwrap()));

        let (status, _, body) = host
            .send(get_as("/api/v1/tabs/not-a-tab/desktop-images", &cookie))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

        // Origin, then the id's shape, before any desktop call — a path-shaped
        // id is refused as malformed, never resolved.
        let clipboard = serde_json::json!({ "image_id": "clipboard" });
        let (status, _, body) = host
            .send(attach(&tab_id, "https://evil.example", clipboard.clone()))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");
        for bad in ["", "../../etc/passwd", "/home/x/shot.png", "0123", "not-hex-but-32-characters-long!!"] {
            let (status, _, body) = host
                .send(attach(&tab_id, ORIGIN, serde_json::json!({ "image_id": bad })))
                .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad:?} answered: {body}");
            assert_eq!(json(&body)["error"], "invalid_request");
        }
        let (status, _, body) = host
            .send(attach(&tab_id, ORIGIN, serde_json::json!({ "nope": 1 })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");

        let (status, _, body) = host.send(attach(&tab_id, ORIGIN, clipboard.clone())).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
        assert_eq!(json(&body)["error"], "desktop_unavailable");
        let (status, _, body) = host.send(attach("not-a-tab", ORIGIN, clipboard)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
        // Nothing reached the inbox without a desktop to copy from.
        assert!(!host.root.join(inbox::INBOX_DIR).exists());
    }

    #[tokio::test]
    async fn a_phone_file_lands_in_the_project_inbox_and_only_a_relative_reference_returns() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(43)).await.0;
        let tab_id = fixture_tab_id(&host, &cookie).await;

        // Larger than a control message: the inbox route has its own limit.
        let bytes = vec![0xAB; MAX_CONTROL_MESSAGE * 4];
        let (status, _, body) = host
            .send(inbox_request(&tab_id, "IMG_0042.jpg", &cookie, bytes.clone()))
            .await;
        assert_eq!(status, StatusCode::CREATED, "answered: {body}");
        let attachment = &json(&body)["attachment"];
        let reference = attachment["reference"].as_str().expect("reference");
        assert!(reference.starts_with(".eldrun/inbox/"), "{reference}");
        assert!(reference.ends_with("-IMG_0042.jpg"), "{reference}");
        assert_eq!(attachment["size"], bytes.len());
        assert!(
            !body.contains(&host.root.to_string_lossy().to_string()),
            "a filesystem path leaked: {body}"
        );
        assert_eq!(std::fs::read(host.root.join(reference)).unwrap(), bytes);
    }

    #[tokio::test]
    async fn an_inbox_upload_is_bounded_and_scoped_to_a_known_tab() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(47)).await.0;
        let tab_id = fixture_tab_id(&host, &cookie).await;

        let (status, ..) = host
            .send(inbox_request(&tab_id, "huge.bin", &cookie, vec![0; inbox::MAX_INBOX_FILE + 1]))
            .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

        let (status, _, body) = host
            .send(inbox_request(&tab_id, "empty.txt", &cookie, vec![]))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        assert_eq!(json(&body)["error"], "empty_file");

        let (status, _, body) = host
            .send(inbox_request("not-a-tab", "a.txt", &cookie, b"x".to_vec()))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

        // Wrong origin: refused before anything is written.
        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/tabs/{tab_id}/inbox?name=a.txt"))
            .header(header::ORIGIN, "https://elsewhere.example")
            .header(header::COOKIE, cookie_pair(&cookie))
            .body(Body::from(b"x".to_vec()))
            .expect("request");
        let (status, ..) = host.send(request).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!host.root.join(inbox::INBOX_DIR).exists(), "a refused upload wrote to disk");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn desktop_availability_is_what_answers_not_what_file_was_left_behind() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(53)).await.0;
        let socket = host.state.config.control_dir.join("desktop-control.sock");

        // The file a desktop leaves when it exits — or crashes. `exists()` read
        // it as a desktop for as long as the desktop stayed closed.
        std::fs::write(&socket, b"").expect("stale socket file");
        let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false, "{body}");
        let (_, _, body) = host
            .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
            .await;
        let opaque = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false, "{body}");
        assert!(!body.contains(RAW_PROJECT));

        // Something listening there is a desktop.
        std::fs::remove_file(&socket).expect("remove stale file");
        let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
        let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], true, "{body}");
        drop(listener);
    }
}
