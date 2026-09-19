//! The **root console's MCP endpoint** — the extra rights an agent gets by
//! running in the root scope, and nowhere else.
//!
//! The root scope is the cross-project management console (the Ctrl+Shift+R
//! overlay). An agent there is asked for things no project agent should be able
//! to do: "add a calendar entry on Friday at 14:00, one hour", "put a card on
//! the board for project X", "which projects are there". Those are Eldrun's own
//! stores, so Eldrun serves them itself, as MCP tools over loopback HTTP.
//!
//! **Who may call it** is the whole design, and each spawn has a bearer token:
//!
//! - minted per agent spawn from the OS CSPRNG, held in memory, **never written to
//!   disk** — a project agent's fence sees `/` read-only, so a token in a file
//!   would be a token it can read;
//! - handed out in exactly one place, [`apply_to_spawn`], which the PTY spawn
//!   path calls only for a *local agent whose scope is root* (`project_id ==
//!   None`). The scope comes from the spawn request, the same trusted input
//!   that already decides the fence roots — a project agent cannot make Tauri
//!   calls, so it cannot ask for a root spawn;
//! - unreadable from a fenced project agent: bubblewrap gives it its own pid
//!   namespace and a fresh `/proc`, so neither the root agent's environment nor
//!   its argv is visible. An agent the user chose to run **unfenced** shares
//!   the uid and can read `/proc/<pid>/environ` — that is what turning the
//!   fence off means, and it is said in `docs/context/root_console.md` rather
//!   than papered over here.
//!
//! The port is loopback-only and a request carrying an `Origin` header is
//! refused, so a web page cannot reach the tools through the user's browser
//! even if it guessed the port.
//!
//! This module is `AppHandle`-free: the HTTP listener and the frontend event
//! live in `commands::root_mcp`. A write returns a [`Change`] describing the row
//! it made. `root_mcp_review` stages those rows by default; only approval (or
//! an explicitly lower review level) emits them to the window and CalDAV.
//!
//! **Never the phone.** Nothing here is reachable from `mobile_control`: the
//! catalog is built from `projects.json` and `boxes.json`, the root scope is in
//! neither, and `discovery` refuses the id outright. Root Claude tabs also spawn
//! without `--remote-control` (see `commands::terminal`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use super::root_mcp_security::{self as security, Access, Policy};

use serde_json::{json, Value};

use crate::schema::calendar::{add_minutes, CalendarEvent, CalendarTask};
use crate::terminal::PtyOptions;

/// The env var a root agent finds its token in. Codex reads it by name
/// (`bearer_token_env_var`); it is set for every root agent so a CLI wired up by
/// hand can use it too.
pub const TOKEN_ENV: &str = "ELDRUN_ROOT_MCP_TOKEN";
/// The endpoint, for the same by-hand wiring.
pub const URL_ENV: &str = "ELDRUN_ROOT_MCP_URL";
/// The server name the agent CLIs list the tools under.
pub const SERVER_NAME: &str = "eldrun";

const PROTOCOL_VERSION: &str = "2025-03-26";

/// The listener endpoint. Secrets belong to individual root-agent spawns.
#[derive(Debug, Clone)]
pub struct Runtime { pub port: u16 }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub tab: String,
    pub caller: Caller,
    /// The project a [`Caller::Reader`] runs in — the VM whose narrowness every
    /// one of its mail calls is checked against. `None` for a root agent.
    pub project: Option<String>,
}
static TOKENS: OnceLock<std::sync::Mutex<HashMap<String, Session>>> = OnceLock::new();
fn tokens() -> &'static std::sync::Mutex<HashMap<String, Session>> {
    TOKENS.get_or_init(Default::default)
}
fn register_token(token: String, identity: Identity) {
    let mut map = tokens().lock().unwrap_or_else(|p| p.into_inner());
    map.retain(|_, old| {
        if old.identity.tab == identity.tab { old.revoked.store(true, Ordering::Release); false } else { true }
    });
    let session = Session {
        id: super::root_mcp_review::hash(token.as_bytes()),
        access: Access::initial(identity.caller), identity,
        revoked: Arc::new(AtomicBool::new(false)),
        permits: Arc::new(tokio::sync::Semaphore::new(2)),
        rate: Arc::new(std::sync::Mutex::new((std::time::Instant::now(), 0))),
    };
    map.insert(token, session);
}
pub fn revoke_tab(tab: &str) {
    tokens().lock().unwrap_or_else(|p| p.into_inner()).retain(|_, s| {
        if s.identity.tab == tab { s.revoked.store(true, Ordering::Release); false } else { true }
    });
}
pub fn tab_active(tab: &str) -> bool {
    tokens().lock().unwrap_or_else(|p| p.into_inner()).values().any(|s| s.identity.tab == tab)
}

#[cfg(test)]
pub(crate) fn test_session(caller: Caller) -> (String, Session) {
    let token = mint_token().unwrap();
    register_token(token.clone(), Identity { tab: format!("test:{}", &token[..16]), caller, project: None });
    let session = authenticate(Some(&format!("Bearer {token}"))).unwrap();
    (token, session)
}

/// Who a presented bearer token belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Caller {
    /// Any root agent CLI (Claude, Codex, …).
    Agent,
    /// A local-model (Mistral Vibe on Ollama) tab.
    LocalModel,
    /// An agent tab in a `mail_reader` VM project (`services::mail_reader`): the
    /// one class that reads mail. Its taint is a property of the class, fixed at
    /// spawn — it is served no cross-project sweep, and every calendar or board
    /// write it makes is staged whatever `root_mcp_review` says.
    Reader,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

/// Record the live listener. First caller wins — there is one per process.
pub fn set_runtime(runtime: Runtime) {
    let _ = RUNTIME.set(runtime);
}

pub fn runtime() -> Option<&'static Runtime> {
    RUNTIME.get()
}

/// 32 random bytes, hex. `None` when the OS has no entropy to give — the
/// endpoint then simply does not start; a guessable token is not a fallback.
pub fn mint_token() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn endpoint_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

/// Compare every candidate; no shared process-wide token remains valid.
/// A request holds this generation even after its token is revoked or narrowed.
#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub identity: Identity,
    pub access: Access,
    revoked: Arc<AtomicBool>,
    pub permits: Arc<tokio::sync::Semaphore>,
    rate: Arc<std::sync::Mutex<(std::time::Instant, u32)>>,
}
impl Session {
    pub fn admit_rate(&self) -> bool {
        let mut rate = self.rate.lock().unwrap_or_else(|p| p.into_inner());
        if rate.0.elapsed() >= std::time::Duration::from_secs(60) { *rate = (std::time::Instant::now(), 0); }
        if rate.1 >= 120 { return false; }
        rate.1 += 1;
        true
    }
    pub fn check(&self) -> Result<(), String> {
        if self.revoked.load(Ordering::Acquire) { Err("MCP session was revoked or changed".into()) } else { Ok(()) }
    }
}
#[derive(serde::Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub tab: String,
    pub caller: Caller,
    pub access: Access,
}
pub fn sessions() -> Vec<SessionInfo> {
    tokens().lock().unwrap_or_else(|p| p.into_inner()).values().map(|s| SessionInfo {
        id: s.id.clone(), tab: s.identity.tab.clone(), caller: s.identity.caller, access: s.access.clone(),
    }).collect()
}
/// Tauri-only: replacing a grant invalidates all requests queued under the old grant.
pub fn set_access(id: &str, access: Access) -> Result<(), String> {
    access.validate()?;
    let mut map = tokens().lock().unwrap_or_else(|p| p.into_inner());
    let s = map.values_mut().find(|s| s.id == id).ok_or("MCP session is closed")?;
    s.revoked.store(true, Ordering::Release);
    s.revoked = Arc::new(AtomicBool::new(false));
    s.access = access;
    drop(map);
    // Finish any operation which already crossed its mutation boundary.
    let _guard = super::root_mcp_review::lock();
    Ok(())
}
pub fn revoke_session(id: &str) -> Result<String, String> {
    let mut map = tokens().lock().unwrap_or_else(|p| p.into_inner());
    let key = map.iter().find(|(_, s)| s.id == id).map(|(k, _)| k.clone()).ok_or("MCP session is closed")?;
    let s = map.remove(&key).unwrap();
    s.revoked.store(true, Ordering::Release);
    Ok(s.identity.tab)
}
pub fn authenticate(header: Option<&str>) -> Option<Session> {
    let map = tokens().lock().unwrap_or_else(|p| p.into_inner());
    let mut found = None;
    for (token, session) in map.iter() {
        if authorized(header, token) { found = Some(session.clone()); }
    }
    found
}
pub fn caller(header: Option<&str>) -> Option<Identity> {
    authenticate(header).map(|s| s.identity)
}

/// Constant-time bearer check. `header` is the raw `Authorization` value.
pub fn authorized(header: Option<&str>, token: &str) -> bool {
    use subtle::ConstantTimeEq;
    let Some(presented) = header.and_then(|h| h.strip_prefix("Bearer ")) else {
        return false;
    };
    presented.as_bytes().ct_eq(token.as_bytes()).into()
}

// ── Spawn wiring ────────────────────────────────────────────────────────────

/// Whether this spawn is a root-console agent: a recognised agent CLI, run
/// locally, in the root scope. The caller has already resolved `is_agent`.
pub fn is_root_agent(opts: &PtyOptions, is_agent: bool) -> bool {
    is_agent && opts.project_id.is_none()
}

fn basename(cmd: &str) -> &str {
    cmd.rsplit(['/', '\\']).next().unwrap_or(cmd)
}

/// The cloud agent CLIs [`apply_to_spawn_with`] names the server to on their
/// command line — the ones that can actually *call* the tools. Every other
/// opted-in root agent gets the env pair only. The Models & agents menu's
/// "MCP" chip reads this (via `root_mcp_status`) to say which CLIs the switch
/// can do anything for, so a CLI wired below must be listed here; the
/// `every_wired_cli_is_named_the_server` test holds the two together.
pub const WIRED_CLIS: &[&str] = &["claude", "codex"];

/// Hand a root agent the endpoint. Pure over `runtime` so it is testable.
///
/// Only an agent that wears the 🧠 menu's "MCP" chip gets anything: a cloud
/// CLI whose binary is in `tool_agents` (`Settings::root_mcp_agent_list`), a
/// local model in `tool_models`. "Root" alone lets an agent run in the root
/// console *without* the tools — no server, no token, no env pair.
///
/// The CLI is told about the server on its **own command line**, never through
/// its config files — Eldrun does not write another application's config
/// (`feedback: no foreign app paths`), and a flag dies with the tab, so a
/// project agent started later inherits nothing.
///
/// - **Claude**: `--mcp-config <inline json>`, last in argv (the flag is
///   variadic; nothing positional may follow it). The header names the token
///   as `${ELDRUN_ROOT_MCP_TOKEN}`, which Claude expands from its environment
///   (verified on 2.1.276), so the secret is never in its argv. That matters
///   beyond `ps`: a fenced argv is past tmux's message limit, so
///   `tmux_local` moves the whole command line into a launcher script on disk.
/// - **Codex**: `-c mcp_servers.eldrun.…` overrides, first in argv so they
///   precede a `resume <id>` subcommand. The token is named, not inlined.
/// - **Vibe** (a local-model tab): `VIBE_MCP_SERVERS` / `VIBE_ENABLED_TOOLS`,
///   Vibe's own env layer, which outranks the per-model `config.toml`. An
///   untagged model keeps `prepare_local_agent`'s tools-off config, which is
///   what lets a completion-only model run at all. The tools are narrowed to this
///   server's, so a small model gets a short tool list and no shell. The
///   token is named (`api_key_env`), not inlined.
/// - Every other opted-in agent gets the env pair only, until its CLI has a
///   per-invocation way to name a server.
///
/// `local_only` (`Settings::root_mcp_local_only`) hands a cloud agent nothing
/// at all. Each spawn gets its own secret; the token map retains its caller class.
pub fn apply_to_spawn_with(
    opts: &mut PtyOptions,
    runtime: &Runtime,
    token: &str,
    tool_agents: &[String],
    tool_models: &[String],
    local_only: bool,
) {
    let local = is_local_model(opts);
    if local_only && !local {
        return;
    }
    let opted_in = if local {
        local_model_has_tools(opts, tool_models)
    } else {
        let bin = basename(&opts.cmd);
        tool_agents.iter().any(|a| a == bin)
    };
    if !opted_in {
        return;
    }
    let url = endpoint_url(runtime.port);
    opts.env.insert(TOKEN_ENV.to_string(), token.to_string());
    opts.env.insert(URL_ENV.to_string(), url.clone());
    match basename(&opts.cmd) {
        "vibe" if local => {
            let servers = json!([{
                "name": SERVER_NAME,
                "transport": "http",
                "url": url,
                "api_key_env": TOKEN_ENV,
            }]);
            opts.env.insert("VIBE_MCP_SERVERS".to_string(), servers.to_string());
            opts.env.insert(
                "VIBE_ENABLED_TOOLS".to_string(),
                json!([format!("{SERVER_NAME}_*")]).to_string(),
            );
        }
        bin => wire_cli_args(bin, &mut opts.args, &url),
    }
}

/// Name the server on a wired CLI's own command line ([`WIRED_CLIS`]); a no-op
/// for every other binary, and for an argv that already names it.
fn wire_cli_args(bin: &str, args: &mut Vec<String>, url: &str) {
    match bin {
        "claude" if !args.iter().any(|a| a == "--mcp-config") => {
            let config = json!({
                "mcpServers": {
                    SERVER_NAME: {
                        "type": "http",
                        "url": url,
                        "headers": { "Authorization": format!("Bearer ${{{TOKEN_ENV}}}") },
                    }
                }
            });
            args.push("--mcp-config".to_string());
            args.push(config.to_string());
        }
        "codex" if !args.iter().any(|a| a.starts_with("mcp_servers.eldrun.")) => {
            let overrides = [
                "-c".to_string(),
                format!("mcp_servers.{SERVER_NAME}.url=\"{url}\""),
                "-c".to_string(),
                format!("mcp_servers.{SERVER_NAME}.bearer_token_env_var=\"{TOKEN_ENV}\""),
            ];
            args.splice(0..0, overrides);
        }
        _ => {}
    }
}

/// Whether this spawn is a local-model tab: Vibe, pointed at an Ollama model
/// by the env pair `NewTabMenu` sets. A bare `vibe` is Mistral's cloud CLI.
fn is_local_model(opts: &PtyOptions) -> bool {
    basename(&opts.cmd) == "vibe"
        && (opts.env.contains_key("ELDRUN_LOCAL_MODEL") || opts.env.contains_key("VIBE_ACTIVE_MODEL"))
}

/// Whether a Vibe tab's local model wears the "MCP" chip. The tab names its
/// model twice (`NewTabMenu`): `ELDRUN_LOCAL_MODEL` raw, `VIBE_ACTIVE_MODEL`
/// as the alias `prepare_local_agent` wrote — and a restored tab may carry
/// only the alias (`CenterPanel` re-hydrates just that pair).
fn local_model_has_tools(opts: &PtyOptions, tool_models: &[String]) -> bool {
    let raw = opts.env.get("ELDRUN_LOCAL_MODEL");
    let alias = opts.env.get("VIBE_ACTIVE_MODEL");
    tool_models.iter().any(|m| {
        raw.is_some_and(|r| r == m) || alias.is_some_and(|a| *a == m.replace(':', "-"))
    })
}

/// Roll back a handed-out token if wrapping or spawning the PTY fails.
pub struct SpawnTokenGuard { token: Option<String>, armed: bool }
impl SpawnTokenGuard {
    pub fn new(opts: &PtyOptions) -> Self { Self { token: opts.env.get(TOKEN_ENV).cloned(), armed: true } }
    pub fn keep(&mut self) { self.armed = false; }
}
impl Drop for SpawnTokenGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Some(token) = &self.token { revoke_token(token); }
        }
    }
}
pub fn revoke_token(token: &str) -> Option<Identity> {
    tokens().lock().unwrap_or_else(|p| p.into_inner()).remove(token).map(|s| {
        s.revoked.store(true, Ordering::Release);
        s.identity
    })
}

/// Missing, malformed or unreadable policy always refuses access.
pub fn enabled_in(settings: &Path) -> bool {
    Policy::load(settings).is_ok_and(|p| p.enabled)
}
pub fn mail_enabled_in(settings: &Path) -> bool {
    Policy::load(settings).is_ok_and(|p| p.enabled && p.mail)
}
pub const MAIL_OFF: &str = "mail tools are switched off in Eldrun's Settings";
pub fn serves(settings: &Path, caller: Caller) -> bool {
    Policy::load(settings).is_ok_and(|p| p.serves(caller))
}

/// [`enabled_in`] against the live `settings.json`.
pub fn enabled() -> bool {
    enabled_in(&crate::storage::state_dir().join("settings.json"))
}

/// [`apply_to_spawn_with`] against the live listener; a no-op while none is up
/// or while the tools are switched off.
pub fn apply_to_spawn(opts: &mut PtyOptions) {
    let Some(runtime) = runtime() else { return };
    let Ok(settings) = crate::storage::read_json::<crate::schema::Settings>(
        &crate::storage::state_dir().join("settings.json"),
    ) else { return };
    if !settings.root_mcp() { return; }
    let local_only = settings.root_mcp_local_only();
    let tool_agents = settings.root_mcp_agent_list();
    let tool_models = settings.ollama_mcp_models.unwrap_or_default();
    let Some(token) = mint_token() else { return };
    let caller = if is_local_model(opts) { Caller::LocalModel } else { Caller::Agent };
    apply_to_spawn_with(opts, runtime, &token, &tool_agents, &tool_models, local_only);
    if opts.env.get(TOKEN_ENV) == Some(&token) {
        register_token(token, Identity { tab: opts.id.clone(), caller, project: None });
    }
}

/// The guest-side address of the root MCP port inside a `mail_reader` VM: a
/// `guestfwd` channel `services::vm` adds for such a project only. Fixed, for
/// the reason the proxy's is — the in-guest config survives a host port change.
pub const READER_GUEST_HOST: &str = "10.0.2.101"; // privacy-check: ok — QEMU slirp, not a real host
pub const READER_GUEST_PORT: u16 = 8765;

pub fn reader_endpoint_url() -> String {
    format!("http://{READER_GUEST_HOST}:{READER_GUEST_PORT}/mcp")
}

/// Hand a **contained reader** its endpoint: an agent spawn into a VM project
/// whose trusted record carries `mail_reader`. `agent_cmd`/`agent_args` are the
/// agent CLI's own command line (the one `ssh -tt` runs in the guest), so the
/// server is named on it exactly as [`apply_to_spawn_with`] does for a root
/// agent; the returned env pair travels in the remote command's environment.
/// The token is visible to everything inside that VM — the VM is the unit of
/// containment, the token is scoped to the `Reader` tool set, and it dies with
/// the tab. `None` when the tools are off, local-only, mail is not switched on
/// (`Settings::root_mcp_mail`), or the CLI is not wired.
pub fn apply_reader_to_spawn(
    tab: &str,
    project: &str,
    agent_cmd: &str,
    agent_args: &mut Vec<String>,
) -> Option<Vec<(String, String)>> {
    runtime()?;
    let settings = crate::storage::read_json::<crate::schema::Settings>(
        &crate::storage::state_dir().join("settings.json"),
    )
    .ok();
    if settings.as_ref().is_some_and(|s| !s.root_mcp() || s.root_mcp_local_only()) {
        return None;
    }
    // Mail is off unless switched on, a missing settings file included.
    if !settings.as_ref().is_some_and(|s| s.root_mcp_mail()) {
        return None;
    }
    let token = mint_token()?;
    let env = reader_wiring(agent_cmd, agent_args, &token)?;
    register_token(
        token,
        Identity { tab: tab.to_string(), caller: Caller::Reader, project: Some(project.to_string()) },
    );
    Some(env)
}

/// The pure half of [`apply_reader_to_spawn`].
pub fn reader_wiring(agent_cmd: &str, agent_args: &mut Vec<String>, token: &str) -> Option<Vec<(String, String)>> {
    let bin = basename(agent_cmd);
    if !WIRED_CLIS.contains(&bin) {
        return None;
    }
    let url = reader_endpoint_url();
    wire_cli_args(bin, agent_args, &url);
    Some(vec![(TOKEN_ENV.to_string(), token.to_string()), (URL_ENV.to_string(), url)])
}

// ── Tools ───────────────────────────────────────────────────────────────────

/// A row a tool wrote, for the window to merge and (CalDAV) push.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Change {
    /// `"event"` | `"task"` | `"calendar"` | `"draft"` (a mail draft an agent
    /// wrote, `root_mcp_mail`; its row is the id and origin, never the text).
    pub kind: &'static str,
    /// `"upsert"` | `"delete"`.
    pub op: &'static str,
    pub row: Value,
    /// The write touched only Eldrun's own board fields (`column`/`rank`), which
    /// no CalDAV server stores — the window merges the row and pushes nothing,
    /// exactly as a drag on the board does.
    pub local: bool,
}

/// What a call leaves for the command layer to tell the window.
#[derive(Debug, Default)]
pub struct Effects {
    pub changes: Vec<Change>,
}

impl Effects {
    fn wrote(changes: Vec<Change>) -> Self {
        Effects { changes }
    }
}

/// Where the tools read and write. Paths, so tests drive a tempdir.
pub struct Stores<'a> {
    pub calendar: &'a Path,
    pub projects: &'a Path,
    /// Read only, for the review level the writes answer to.
    pub settings: &'a Path,
    /// The state directory itself (`~/.local/share/eldrun`), for the read-only
    /// stores addressed *per project id* — `remote-projects/<id>/{git_peer,sync,
    /// local_loss}.json` — and for the flat rollups beside it
    /// (`boxes.json`, `time_summary.json`, `usage_stats.json`). One field rather
    /// than one per file: every store below is a read, and a new one must not
    /// cost a signature change in the command layer as well.
    pub state: &'a Path,
    /// Who is asking. Fixed at spawn with the token; decides which tools exist
    /// for this call ([`served`]) and whether its writes must stage.
    pub caller: Caller,
    /// Mail, when the store is open and unlocked. `None` refuses every mail
    /// tool with `root_mcp_mail::LOCKED`; nothing here can unlock or prompt.
    pub mail: Option<&'a dyn super::root_mcp_mail::MailAccess>,
    /// For a [`Caller::Reader`]: why its VM is not narrow *right now*
    /// (`services::mail_reader`), checked by the command layer per call.
    pub reader_refusal: Option<&'a str>,
    pub policy: Policy,
    pub access: Access,
    pub session: Option<&'a Session>,
    pub deadline: Option<std::time::Instant>,
}
impl Stores<'_> {
    pub fn check(&self) -> Result<(), String> {
        if let Some(s) = self.session {
            s.check()?;
            if Policy::load(self.settings)? != self.policy {
                return Err("MCP security policy changed; retry the request".into());
            }
        }
        if self.deadline.is_some_and(|d| std::time::Instant::now() >= d) {
            return Err("MCP request deadline exceeded".into());
        }
        Ok(())
    }
}

pub fn served(caller: Caller, name: &str) -> bool {
    security::tool(name).is_some_and(|t| t.serves(caller))
}

pub fn tool_names() -> Vec<&'static str> {
    let mut names = store_tool_names();
    names.extend(super::root_mcp_mail::TOOLS);
    names
}

fn store_tool_names() -> Vec<&'static str> {
    vec![
        "proposals_list",
        "projects_list",
        "projects_git_status",
        "boxes_list",
        "calendar_list",
        "calendar_create",
        "calendar_add_event",
        "calendar_update_event",
        "calendar_move_events",
        "calendar_delete_event",
        "todo_list",
        "todo_add",
        "todo_complete",
        "todo_reopen",
        "todo_update",
        "todo_move",
        "todo_delete",
        "time_summary",
        "usage_recap",
        "sync_status",
    ]
}

/// MCP tool annotations: what a tool does, stated so the client can decide
/// whether to ask. Codex prompts before any tool that does not say it is
/// read-only; the annotation only describes the tool — the approval stays the
/// CLI's own (`docs/context/root_console.md`).
pub(crate) fn tool_annotations(name: &str) -> Value {
    match security::tool(name) {
        Some(t) if !t.write => json!({ "readOnlyHint": true, "openWorldHint": false }),
        Some(t) => json!({ "readOnlyHint": false, "destructiveHint": t.destructive }),
        None => json!({ "readOnlyHint": false, "destructiveHint": true }),
    }
}

fn tool_definitions(caller: Caller, mail: bool) -> Value {
    let mut tools = tool_schemas().as_array().cloned().unwrap_or_default();
    if mail {
        tools.extend(super::root_mcp_mail::tool_schemas(caller));
    }
    tools.retain(|tool| served(caller, tool["name"].as_str().unwrap_or_default()));
    for tool in &mut tools {
        let name = tool["name"].as_str().unwrap_or_default().to_string();
        tool["annotations"] = tool_annotations(&name);
        tool["inputSchema"]["additionalProperties"] = json!(false);
        if security::tool(&name).is_some_and(|t| !t.write && t.family != "mail") {
            tool["inputSchema"]["properties"]["offset"] = json!({"type":"integer", "minimum":0, "maximum":1000000});
            tool["inputSchema"]["properties"]["limit"] = json!({"type":"integer", "minimum":1, "maximum":100});
        }
    }
    Value::Array(tools)
}

fn tool_schemas() -> Value {
    let stamp = "Local wall-clock time, \"YYYY-MM-DDTHH:MM\" (or \"YYYY-MM-DD\" when all_day).";
    json!([
        { "name": "proposals_list", "description": "List only this tab's proposals and whether each is pending, applied, rejected or conflicted. A staged write is a proposal, not a completed change.",
          "inputSchema": { "type": "object", "properties": {} } },
        {
            "name": "projects_list",
            "description": "List every Eldrun project: id, name, status (current/active/inactive), folder, and whether it runs on a remote host.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "projects_git_status",
            "description": "Git state of every project's working copy, in one sweep: branch, commits ahead/behind its upstream, and staged/unstaged/untracked counts. Answers \"which projects have uncommitted work\". Local reads only — it never contacts a remote host, so a remote project is read through its local mirror and reported as skipped when it has none.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Only this project (id or name); every project when absent." },
                    "dirty_only": { "type": "boolean", "description": "Leave out repos that are clean and level with their upstream." }
                }
            }
        },
        {
            "name": "boxes_list",
            "description": "List the project boxes: each box's members (the projects grouped in it), its folder when it has one, and any declared relations between members.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Only boxes holding this project (id or name)." }
                }
            }
        },
        {
            "name": "calendar_list",
            "description": "List the user's calendars and the events that start inside [from, to). Recurring events are returned as their master row with its rrule, not expanded.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "Inclusive lower bound, \"YYYY-MM-DD\"." },
                    "to": { "type": "string", "description": "Exclusive upper bound, \"YYYY-MM-DD\"." }
                }
            }
        },
        {
            "name": "calendar_create",
            "description": "Create a new, empty local calendar. Its name must not already be taken, since tools address calendars by name as well as id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "color": { "type": "string", "description": "\"#rrggbb\"; the next colour of the calendar palette when absent." }
                },
                "required": ["name"]
            }
        },
        {
            "name": "calendar_add_event",
            "description": "Add an event to the user's Eldrun calendar. Give `start` and either `end` or `duration_minutes` (default 60).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "start": { "type": "string", "description": stamp },
                    "end": { "type": "string", "description": "Exclusive end, same format as start." },
                    "duration_minutes": { "type": "integer", "minimum": 1, "maximum": 1000000, "description": "Used when `end` is absent. Default 60." },
                    "all_day": { "type": "boolean" },
                    "location": { "type": "string" },
                    "notes": { "type": "string" },
                    "calendar": { "type": "string", "description": "Calendar id or name; the default calendar when absent." }
                },
                "required": ["title", "start"]
            }
        },
        {
            "name": "calendar_update_event",
            "description": "Edit one calendar event by id. Only the fields given change, and an empty string clears `location` or `notes`. Moving `start` alone keeps the event's length, so rescheduling needs no `end`; give `end` or `duration_minutes` to change the length too. A recurring event is edited as a whole series. Refuses an event in a read-only calendar.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "title": { "type": "string" },
                    "start": { "type": "string", "description": stamp },
                    "end": { "type": "string", "description": "Exclusive end, same format as start." },
                    "duration_minutes": { "type": "integer", "minimum": 1, "maximum": 1000000, "description": "New length, from `start`. Ignored when `end` is given." },
                    "all_day": { "type": "boolean", "description": "Turn the event into (or out of) an all-day one; turning it into a timed event needs a `start`." },
                    "location": { "type": "string" },
                    "notes": { "type": "string" },
                    "calendar": { "type": "string", "description": "Move the event to this calendar (id or name), as calendar_move_events does." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "calendar_move_events",
            "description": "Move events into another calendar: the events `ids`, or every event in calendar `from`. All of them move or none does. An event keeps its id, times and fields. Out of a CalDAV-synced calendar the server copy is deleted and the event is created anew in the target, so anything the server stored that Eldrun does not show (attendees, for one) is not carried over. Refuses read-only calendars on either side, and a recurring series whose occurrences were edited on a CalDAV server.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ids": { "type": "array", "items": { "type": "string" }, "description": "Event ids (see calendar_list)." },
                    "from": { "type": "string", "description": "Instead of `ids`: move every event in this calendar (id or name)." },
                    "to": { "type": "string", "description": "Target calendar, id or name." }
                },
                "required": ["to"]
            }
        },
        {
            "name": "calendar_delete_event",
            "description": "Delete one event by id (as returned by calendar_list / calendar_add_event). A recurring event is deleted as a whole series.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "todo_list",
            "description": "List the to-do board: its columns and cards. Completed cards are left out unless include_completed is true.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "include_completed": { "type": "boolean" },
                    "project": { "type": "string", "description": "Only cards linked to this project (id or name)." }
                }
            }
        },
        {
            "name": "todo_add",
            "description": "Add a card to the to-do board, optionally linked to a project and with a due time.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "notes": { "type": "string" },
                    "due": { "type": "string", "description": stamp },
                    "project": { "type": "string", "description": "Project id or name to link the card to." },
                    "column": { "type": "string", "description": "Board column id or name; the first column when absent." },
                    "tags": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["title"]
            }
        },
        {
            "name": "todo_complete",
            "description": "Mark one to-do card done, by id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "completed_at": { "type": "string", "description": "Local \"YYYY-MM-DDTHH:MM\"; the card's due/creation stamp is used when absent." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "todo_reopen",
            "description": "Mark a completed to-do card as not done again, by id. It leaves the done column for the board's intake column.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "todo_update",
            "description": "Edit one to-do card, by id. Only the fields given change; an empty string clears `notes`, `due` or `project`, and `tags` replaces the whole list. Use todo_move for the column and todo_complete / todo_reopen for done-ness.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "title": { "type": "string" },
                    "notes": { "type": "string" },
                    "due": { "type": "string", "description": stamp },
                    "project": { "type": "string", "description": "Project id or name to link the card to." },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "priority": { "type": "integer", "minimum": 0, "maximum": 9, "description": "iCalendar priority: 0 unset, 1 highest, 9 lowest." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "todo_move",
            "description": "Move one to-do card to another board column (or reorder it inside its own). Moving into the done column completes the card; moving out of it reopens it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "column": { "type": "string", "description": "Board column id or name (see todo_list)." },
                    "position": { "type": "integer", "minimum": 0, "description": "0-based slot in the column, top first; the bottom when absent." },
                    "completed_at": { "type": "string", "description": "Used when the move completes the card; same rule as todo_complete." }
                },
                "required": ["id", "column"]
            }
        },
        {
            "name": "todo_delete",
            "description": "Delete one to-do card for good, by id. There is no undo — prefer todo_complete for a card that is merely finished.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "time_summary",
            "description": "Tracked working time per project over a date range, in seconds, from Eldrun's own timer. Days are keyed by UTC date, not local date, so a late-evening session east of UTC lands on the next day's bucket. Eldrun's own window time is reported separately as `app_seconds`, never inside a project's total.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "Inclusive lower bound, \"YYYY-MM-DD\"; everything recorded when absent." },
                    "to": { "type": "string", "description": "Exclusive upper bound, \"YYYY-MM-DD\"." },
                    "project": { "type": "string", "description": "Only this project (id or name)." }
                }
            }
        },
        {
            "name": "usage_recap",
            "description": "Eldrun's local activity counters over a date range — agent tabs and prompts, shell commands, files created/modified/deleted, tabs, apps launched — as the daily recap reads them. Counts only, no content, and only what happened inside Eldrun. Days are keyed by UTC date. Distinct from time_summary (worked seconds) and from git history.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "Inclusive lower bound, \"YYYY-MM-DD\"; everything retained when absent (about 13 months)." },
                    "to": { "type": "string", "description": "Exclusive upper bound, \"YYYY-MM-DD\"." },
                    "project": { "type": "string", "description": "Only this project (id or name); implies by_project." },
                    "by_project": { "type": "boolean", "description": "Also break the totals down per project." }
                }
            }
        },
        {
            "name": "sync_status",
            "description": "Where each remote project stands with its host: git lockstep (on/off, in step or not, and why), what byte-sync tracks, and any unacknowledged warning that a local file was overwritten or deleted by a sync or lockstep pass. Reads Eldrun's recorded state only — it opens no SSH connection, so the answer is as of the last pass, not a fresh probe.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Only this project (id or name)." },
                    "include_acked": { "type": "boolean", "description": "Include local-loss warnings the user has already seen." }
                }
            }
        }
    ])
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn all_digits(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit())
}

/// `"YYYY-MM-DD"`, with a month and day that can exist.
fn valid_date(s: &str) -> bool {
    let mut parts = s.split('-');
    let (Some(y), Some(m), Some(d), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if !(all_digits(y, 4) && all_digits(m, 2) && all_digits(d, 2)) {
        return false;
    }
    let (m, d): (u32, u32) = (m.parse().unwrap_or(0), d.parse().unwrap_or(0));
    (1..=12).contains(&m) && (1..=31).contains(&d)
}

/// `"YYYY-MM-DDTHH:MM"`; a trailing `:SS` is accepted and dropped, because that
/// is what a model that knows ISO 8601 writes.
fn normalize_stamp(s: &str) -> Option<String> {
    let (date, time) = s.split_once('T')?;
    if !valid_date(date) {
        return None;
    }
    let mut parts = time.split(':');
    let (h, mi) = (parts.next()?, parts.next()?);
    if let Some(sec) = parts.next() {
        if !all_digits(sec, 2) || parts.next().is_some() {
            return None;
        }
    }
    if !(all_digits(h, 2) && all_digits(mi, 2)) {
        return None;
    }
    let (hn, mn): (u32, u32) = (h.parse().ok()?, mi.parse().ok()?);
    (hn < 24 && mn < 60).then(|| format!("{date}T{h}:{mi}"))
}

fn read_projects(path: &Path) -> Vec<crate::schema::projects::ProjectEntry> {
    crate::storage::read_json(path).unwrap_or_default()
}

/// Resolve "id or name" to a project id. A name must match exactly one project
/// (case-insensitively) — an ambiguous name links nothing rather than guessing.
fn resolve_project(stores: &Stores, wanted: &str) -> Result<String, String> {
    let projects: Vec<_> = read_projects(stores.projects).into_iter().filter(|p| stores.access.projects.contains(&p.id)).collect();
    if let Some(p) = projects.iter().find(|p| p.id == wanted) {
        return Ok(p.id.clone());
    }
    let by_name: Vec<_> = projects
        .iter()
        .filter(|p| p.name.eq_ignore_ascii_case(wanted))
        .collect();
    match by_name.as_slice() {
        [one] => Ok(one.id.clone()),
        [] => Err(format!("no project named '{wanted}' (see projects_list)")),
        _ => Err(format!("several projects are named '{wanted}'; pass the id instead")),
    }
}

fn projects_list(stores: &Stores) -> Result<Value, String> {
    let rows: Vec<Value> = read_projects(stores.projects)
        .iter()
        .filter(|p| !crate::paths::is_trash_project_id(&p.id) && stores.access.projects.contains(&p.id))
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "status": p.status,
                "directory": p.extra.get("directory").and_then(Value::as_str).unwrap_or(""),
                "remote": p.extra.get("remote").is_some_and(|r| !r.is_null()),
            })
        })
        .collect();
    Ok(json!({ "projects": rows }))
}

fn calendar_list(stores: &Stores, args: &Value) -> Result<Value, String> {
    let from = str_arg(args, "from");
    let to = str_arg(args, "to");
    for bound in [from, to].into_iter().flatten() {
        if !valid_date(bound) {
            return Err(format!("'{bound}' is not a YYYY-MM-DD date"));
        }
    }
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    // Stamps sort lexicographically, and a date is a prefix of its own day's
    // stamps, so plain string comparison is the range test.
    let events: Vec<&CalendarEvent> = data
        .events
        .iter()
        .filter(|e| stores.access.calendars.contains(&e.calendar_id))
        .filter(|e| e.rrule.is_some() || from.is_none_or(|f| e.start.as_str() >= f))
        .filter(|e| to.is_none_or(|t| e.start.as_str() < t))
        .collect();
    let calendars: Vec<Value> = data
        .calendars
        .iter()
        .filter(|c| stores.access.calendars.contains(&c.id))
        .map(|c| json!({ "id": c.id, "name": c.name, "readonly": c.readonly }))
        .collect();
    Ok(json!({ "calendars": calendars, "events": events }))
}

fn resolve_calendar(
    data: &crate::schema::calendar::CalendarData,
    wanted: Option<&str>,
) -> Result<String, String> {
    let Some(wanted) = wanted else {
        return Ok(String::new());
    };
    let found = data
        .calendars
        .iter()
        .find(|c| c.id == wanted)
        .or_else(|| data.calendars.iter().find(|c| c.name.eq_ignore_ascii_case(wanted)))
        .ok_or_else(|| format!("no calendar '{wanted}' (see calendar_list)"))?;
    if found.readonly {
        return Err(format!("calendar '{}' is read-only", found.name));
    }
    Ok(found.id.clone())
}

fn calendar_add_event(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let title = str_arg(args, "title").ok_or("`title` is required")?;
    let raw_start = str_arg(args, "start").ok_or("`start` is required")?;
    let all_day = args.get("all_day").and_then(Value::as_bool).unwrap_or(false);

    let (start, end) = if all_day {
        let day = raw_start.split('T').next().unwrap_or(raw_start);
        if !valid_date(day) {
            return Err(format!("'{raw_start}' is not a YYYY-MM-DD date"));
        }
        let end = match str_arg(args, "end") {
            Some(e) if valid_date(e) && e > day => e.to_string(),
            Some(e) => return Err(format!("`end` '{e}' must be a date after `start` (it is exclusive)")),
            None => crate::schema::calendar::add_days(day, 1),
        };
        (day.to_string(), end)
    } else {
        let start = normalize_stamp(raw_start)
            .ok_or_else(|| format!("'{raw_start}' is not a local YYYY-MM-DDTHH:MM time"))?;
        let end = match str_arg(args, "end") {
            Some(e) => {
                let end = normalize_stamp(e)
                    .ok_or_else(|| format!("'{e}' is not a local YYYY-MM-DDTHH:MM time"))?;
                if end <= start {
                    return Err("`end` must be after `start`".into());
                }
                end
            }
            None => {
                let minutes = args.get("duration_minutes").and_then(Value::as_i64).unwrap_or(60);
                if !(1..=60 * 24 * 31).contains(&minutes) {
                    return Err("`duration_minutes` must be between 1 and 44640".into());
                }
                add_minutes(&start, minutes)
            }
        };
        (start, end)
    };

    let data = crate::commands::calendar::read_data(stores.calendar)?;
    let calendar_id = resolve_calendar(&data, str_arg(args, "calendar"))?;
    let event = CalendarEvent {
        calendar_id,
        start,
        end,
        all_day,
        title: title.to_string(),
        location: str_arg(args, "location").unwrap_or_default().to_string(),
        notes: str_arg(args, "notes").unwrap_or_default().to_string(),
        ..Default::default()
    };
    let created = crate::commands::calendar::create_event_at(stores.calendar, event)?;
    let row = serde_json::to_value(&created).map_err(|e| e.to_string())?;
    Ok((row.clone(), Change { kind: "event", op: "upsert", row, local: false }))
}

/// The span an edit leaves behind: `(start, end, all_day)`.
///
/// The rule worth stating is the one for a bare `start`: a move **keeps the
/// event's own length**. Falling back to the one-hour default that
/// `calendar_add_event` uses would quietly resize a three-hour meeting every
/// time it was rescheduled, and an agent that omits `end` is moving the event,
/// not shortening it.
fn updated_span(event: &CalendarEvent, args: &Value) -> Result<(String, String, bool), String> {
    let all_day = args.get("all_day").and_then(Value::as_bool).unwrap_or(event.all_day);
    let start_given = str_arg(args, "start");
    let end_given = str_arg(args, "end");
    let minutes = match args.get("duration_minutes") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let n = value.as_i64().ok_or("`duration_minutes` must be an integer")?;
            if !(1..=60 * 24 * 31).contains(&n) {
                return Err("`duration_minutes` must be between 1 and 44640".into());
            }
            Some(n)
        }
    };
    // Nothing about the time was asked to change (a title or notes edit): keep
    // the stored span exactly as it is, rather than recomputing a row we were
    // not asked to touch.
    if start_given.is_none() && end_given.is_none() && minutes.is_none() && all_day == event.all_day {
        return Ok((event.start.clone(), event.end.clone(), event.all_day));
    }

    if all_day {
        let raw = start_given.unwrap_or(&event.start);
        let start = raw.split('T').next().unwrap_or(raw);
        if !valid_date(start) {
            return Err(format!("'{raw}' is not a YYYY-MM-DD date"));
        }
        let end = match end_given {
            Some(e) if valid_date(e) => e.to_string(),
            Some(e) => return Err(format!("'{e}' is not a YYYY-MM-DD date")),
            // Keep the length in days when it already was an all-day event; one
            // that is only now becoming all-day gets the single day it starts on
            // (`end` is exclusive).
            None => {
                let days = event
                    .all_day
                    .then(|| crate::schema::calendar::days_between(&event.start, &event.end))
                    .flatten()
                    .filter(|d| *d > 0)
                    .unwrap_or(1);
                crate::schema::calendar::add_days(start, days)
            }
        };
        if end.as_str() <= start {
            return Err("`end` must be a date after `start` (it is exclusive)".into());
        }
        return Ok((start.to_string(), end, true));
    }

    let start = match start_given {
        Some(raw) => normalize_stamp(raw)
            .ok_or_else(|| format!("'{raw}' is not a local YYYY-MM-DDTHH:MM time"))?,
        // An all-day event has no time of day to keep, so turning it into a timed
        // one without saying when would be Eldrun inventing an hour.
        None if event.all_day => {
            return Err("give `start` as a local YYYY-MM-DDTHH:MM time when turning an all-day event into a timed one".into())
        }
        None => event.start.clone(),
    };
    let end = match (end_given, minutes) {
        (Some(e), _) => {
            normalize_stamp(e).ok_or_else(|| format!("'{e}' is not a local YYYY-MM-DDTHH:MM time"))?
        }
        (None, Some(n)) => add_minutes(&start, n),
        (None, None) => {
            let span = crate::schema::calendar::minutes_between(&event.start, &event.end)
                .filter(|m| *m > 0)
                .unwrap_or(60);
            add_minutes(&start, span)
        }
    };
    if end <= start {
        return Err("`end` must be after `start`".into());
    }
    Ok((start, end, false))
}

fn calendar_update_event(stores: &Stores, args: &Value) -> Result<(Value, Vec<Change>), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    let mut event = data
        .events
        .iter()
        .find(|e| e.id == id)
        .cloned()
        .ok_or_else(|| format!("event '{id}' not found"))?;
    // A read-only calendar is one Eldrun shows but may not write back to; the
    // window would refuse the CalDAV push this change asks for, so the edit is
    // refused here instead of half-landing in the local file.
    if data.calendars.iter().any(|c| c.id == event.calendar_id && c.readonly) {
        return Err(format!("event '{id}' is in a read-only calendar"));
    }
    // The row as its server holds it, for the delete a move owes that server.
    let before = event.clone();
    // Present-but-empty clears; absent keeps — as in `todo_update`.
    let given = |key: &str| args.get(key).and_then(Value::as_str).map(str::trim);
    if let Some(title) = given("title") {
        if title.is_empty() {
            return Err("`title` cannot be empty".into());
        }
        event.title = title.to_string();
    }
    if let Some(location) = given("location") {
        event.location = location.to_string();
    }
    if let Some(notes) = given("notes") {
        event.notes = notes.to_string();
    }
    if let Some(calendar) = given("calendar") {
        if calendar.is_empty() {
            return Err("`calendar` cannot be empty; name the calendar to move the event to".into());
        }
        let to = resolve_calendar(&data, Some(calendar))?;
        if to != event.calendar_id {
            crate::commands::calendar::relocate_event(&data, &mut event, &to)?;
        }
    }
    let (start, end, all_day) = updated_span(&event, args)?;
    event.start = start;
    event.end = end;
    event.all_day = all_day;
    let moved = before.calendar_id != event.calendar_id;
    let updated = crate::commands::calendar::update_event_at(stores.calendar, event)?;
    let row = serde_json::to_value(&updated).map_err(|e| e.to_string())?;
    let mut changes = Vec::new();
    if moved {
        changes.extend(server_copy_delete(&before)?);
    }
    changes.push(Change { kind: "event", op: "upsert", row: row.clone(), local: false });
    Ok((row, changes))
}

/// The delete that retires a moved event's copy on the CalDAV server it came
/// from, or nothing for an event that never had one.
///
/// It is an ordinary `delete` change carrying the row as it was, which is all
/// the window's CalDAV hook needs to address the old resource; the `upsert`
/// that follows puts the row back under its new calendar, where, having no
/// `caldav_href` any more, it is pushed as a create. Emitted *before* that
/// upsert, since the window merges the two in order.
fn server_copy_delete(before: &CalendarEvent) -> Result<Option<Change>, String> {
    let href = before
        .extra
        .get(crate::commands::calendar::CALDAV_HREF_KEY)
        .and_then(Value::as_str)
        .unwrap_or("");
    if href.trim().is_empty() {
        return Ok(None);
    }
    let row = serde_json::to_value(before).map_err(|e| e.to_string())?;
    Ok(Some(Change { kind: "event", op: "delete", row, local: false }))
}

/// A calendar colour: `#rrggbb`, the only form every surface renders as itself
/// (the sidebar's native swatch turns anything else into its fallback).
fn valid_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The sidebar's palette (`CalendarSidebar.tsx`'s `CALENDAR_COLORS`), cycled
/// the same way, so a calendar an agent made looks like one the user made.
const CALENDAR_COLORS: [&str; 8] = [
    "#4aa3df", "#e8663d", "#59b96a", "#c164d6", "#e2b93b", "#d9556b", "#4fc3c3", "#8d8fd6",
];

fn calendar_create(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let name = str_arg(args, "name").ok_or("`name` is required")?;
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    // Every calendar tool takes "id or name", and a name held twice would make
    // the second calendar unreachable by it.
    if data.calendars.iter().any(|c| c.name.eq_ignore_ascii_case(name)) {
        return Err(format!("a calendar named '{name}' already exists (see calendar_list)"));
    }
    let color = match str_arg(args, "color") {
        Some(c) if valid_color(c) => c.to_ascii_lowercase(),
        Some(c) => return Err(format!("`color` '{c}' is not a #rrggbb colour")),
        None => CALENDAR_COLORS[data.calendars.len() % CALENDAR_COLORS.len()].to_string(),
    };
    let calendar = crate::schema::calendar::Calendar {
        id: String::new(),
        name: name.to_string(),
        color,
        visible: true,
        readonly: false,
        extra: HashMap::new(),
    };
    let created = crate::commands::calendar::create_calendar_at(stores.calendar, calendar)?;
    let row = serde_json::to_value(&created).map_err(|e| e.to_string())?;
    // `local`: a calendar made here is Eldrun's own. CalDAV calendars are
    // subscribed to from the server's side, never created from this one.
    Ok((row.clone(), Change { kind: "calendar", op: "upsert", row, local: true }))
}

fn calendar_move_events(stores: &Stores, args: &Value) -> Result<(Value, Vec<Change>), String> {
    let to = str_arg(args, "to").ok_or("`to` is required")?;
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    let to = resolve_calendar(&data, Some(to))?;
    let listed = args.get("ids").filter(|v| !v.is_null());
    let ids: Vec<String> = match (listed, str_arg(args, "from")) {
        (Some(_), Some(_)) => return Err("give `ids` or `from`, not both".into()),
        (Some(ids), None) => {
            let ids = ids.as_array().ok_or("`ids` must be an array of event ids")?;
            let ids: Vec<String> = ids
                .iter()
                .map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string))
                .collect::<Option<_>>()
                .ok_or("`ids` must be an array of event ids")?;
            if ids.is_empty() {
                return Err("`ids` is empty".into());
            }
            ids
        }
        (None, Some(from)) => {
            let from = resolve_calendar(&data, Some(from))?;
            data.events
                .iter()
                .filter(|e| e.calendar_id == from)
                .map(|e| e.id.clone())
                .collect()
        }
        (None, None) => return Err("give `ids` (events to move) or `from` (a calendar to empty)".into()),
    };
    if ids.len() > security::MAX_ROWS / 2 { return Err("Move at most 50 events per call".into()); }
    stores.check()?;
    let moved = crate::commands::calendar::move_events_at(stores.calendar, &ids, &to)?;
    let mut changes = Vec::new();
    for m in &moved {
        changes.extend(server_copy_delete(&m.before)?);
        let row = serde_json::to_value(&m.after).map_err(|e| e.to_string())?;
        changes.push(Change { kind: "event", op: "upsert", row, local: false });
    }
    let ids: Vec<&str> = moved.iter().map(|m| m.after.id.as_str()).collect();
    Ok((json!({ "moved": ids, "to": to }), changes))
}

fn calendar_delete_event(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    let event = data
        .events
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("event '{id}' not found"))?;
    // The row rides along so the window can address the CalDAV copy, which is
    // unreachable once the local row is gone.
    let row = serde_json::to_value(event).map_err(|e| e.to_string())?;
    crate::commands::calendar::delete_event_at(stores.calendar, id)?;
    Ok((json!({ "deleted": id }), Change { kind: "event", op: "delete", row, local: false }))
}

fn todo_list(stores: &Stores, args: &Value) -> Result<Value, String> {
    let include_completed = args.get("include_completed").and_then(Value::as_bool).unwrap_or(false);
    let project = match str_arg(args, "project") {
        Some(p) => Some(resolve_project(stores, p)?),
        None => None,
    };
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    let cards: Vec<&CalendarTask> = data
        .tasks
        .iter()
        .filter(|t| stores.access.calendars.contains(&t.calendar_id) && stores.access.projects.contains(&t.project_id))
        .filter(|t| include_completed || t.completed.is_none())
        .filter(|t| project.as_ref().is_none_or(|p| &t.project_id == p))
        .collect();
    let columns: Vec<Value> = data
        .task_columns
        .iter()
        .map(|c| json!({ "id": c.id, "name": c.name }))
        .collect();
    Ok(json!({ "columns": columns, "cards": cards }))
}

/// A card's `due`: a bare date or a local stamp.
fn parse_due(d: &str) -> Result<String, String> {
    if valid_date(d) {
        return Ok(d.to_string());
    }
    normalize_stamp(d).ok_or_else(|| format!("'{d}' is not a local date or YYYY-MM-DDTHH:MM time"))
}

/// Resolve "id or name" to a board column id.
fn resolve_column(data: &crate::schema::calendar::CalendarData, wanted: &str) -> Result<String, String> {
    data.task_columns
        .iter()
        .find(|c| c.id == wanted)
        .or_else(|| data.task_columns.iter().find(|c| c.name.eq_ignore_ascii_case(wanted)))
        .map(|c| c.id.clone())
        .ok_or_else(|| format!("no board column '{wanted}' (see todo_list)"))
}

fn find_task(stores: &Stores, id: &str) -> Result<CalendarTask, String> {
    crate::commands::calendar::read_data(stores.calendar)?
        .tasks
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("card '{id}' not found"))
}

/// The stamp a completion gets. This crate has no local clock, so without an
/// explicit `completed_at` the card's own due/creation stamp stands in.
fn completion_stamp(task: &CalendarTask, args: &Value) -> Result<String, String> {
    match str_arg(args, "completed_at") {
        Some(s) => normalize_stamp(s).ok_or_else(|| format!("'{s}' is not a local YYYY-MM-DDTHH:MM time")),
        None => Ok(task
            .due
            .clone()
            .filter(|d| d.contains('T'))
            .or_else(|| Some(task.created.clone()).filter(|c| !c.is_empty()))
            .unwrap_or_else(|| "1970-01-01T00:00".to_string())),
    }
}

fn task_upsert(task: &CalendarTask) -> Result<(Value, Change), String> {
    let row = serde_json::to_value(task).map_err(|e| e.to_string())?;
    Ok((row.clone(), Change { kind: "task", op: "upsert", row, local: false }))
}

fn todo_add(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let title = str_arg(args, "title").ok_or("`title` is required")?;
    let due = str_arg(args, "due").map(parse_due).transpose()?;
    let project_id = match str_arg(args, "project") {
        Some(p) => resolve_project(stores, p)?,
        None => String::new(),
    };
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    let column = match str_arg(args, "column") {
        Some(wanted) => resolve_column(&data, wanted)?,
        // Empty: `normalize` files the card into the board's first column.
        None => String::new(),
    };
    let tags = args
        .get("tags")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let task = CalendarTask {
        title: title.to_string(),
        notes: str_arg(args, "notes").unwrap_or_default().to_string(),
        due,
        project_id,
        column,
        tags,
        ..Default::default()
    };
    task_upsert(&crate::commands::calendar::create_task_at(stores.calendar, task)?)
}

fn todo_complete(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    let mut task = find_task(stores, id)?;
    task.completed = Some(completion_stamp(&task, args)?);
    task.percent = 100;
    // `normalize` moves a completed card into the board's done column.
    task_upsert(&crate::commands::calendar::update_task_at(stores.calendar, task)?)
}

fn todo_reopen(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    let mut task = find_task(stores, id)?;
    task.completed = None;
    task.percent = 0;
    // Empty: an open card cannot stay in the done column, and `normalize` files
    // an unplaced one into the board's intake column. An archived card keeps
    // its place — archives are exempt from the done coupling.
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    if data.task_columns.iter().any(|c| c.done && c.id == task.column) {
        task.column = String::new();
        task.rank = None;
    }
    task_upsert(&crate::commands::calendar::update_task_at(stores.calendar, task)?)
}

fn todo_update(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    let mut task = find_task(stores, id)?;
    // Present-but-empty clears; absent keeps. `str_arg` cannot tell the two apart.
    let given = |key: &str| args.get(key).and_then(Value::as_str).map(str::trim);
    if let Some(title) = given("title") {
        if title.is_empty() {
            return Err("`title` cannot be empty".into());
        }
        task.title = title.to_string();
    }
    if let Some(notes) = given("notes") {
        task.notes = notes.to_string();
    }
    if let Some(due) = given("due") {
        task.due = if due.is_empty() { None } else { Some(parse_due(due)?) };
    }
    if let Some(project) = given("project") {
        task.project_id = if project.is_empty() {
            String::new()
        } else {
            resolve_project(stores, project)?
        };
    }
    if let Some(tags) = args.get("tags").and_then(Value::as_array) {
        task.tags = tags.iter().filter_map(Value::as_str).map(str::to_string).collect();
    }
    if let Some(priority) = args.get("priority").and_then(Value::as_i64) {
        if !(0..=9).contains(&priority) {
            return Err("`priority` must be between 0 and 9".into());
        }
        task.priority = priority as u8;
    }
    task_upsert(&crate::commands::calendar::update_task_at(stores.calendar, task)?)
}

/// A move can change more than the card it names (a column reindex), so every
/// changed row goes to the window; the reply is the moved card alone.
fn todo_move(stores: &Stores, args: &Value) -> Result<(Value, Vec<Change>), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    let wanted = str_arg(args, "column").ok_or("`column` is required")?;
    let index = match args.get("position") {
        None | Some(Value::Null) => u32::MAX,
        Some(v) => v
            .as_u64()
            .map(|n| n.min(u64::from(u32::MAX)) as u32)
            .ok_or("`position` must be a non-negative integer")?,
    };
    // Resolve against the board the move itself is about to seed, so a column
    // can be named on a file that has never been dragged on.
    let mut data = crate::commands::calendar::read_data(stores.calendar)?;
    data.ensure_board();
    data.normalize();
    let column = resolve_column(&data, wanted)?;
    let task = data
        .tasks
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("card '{id}' not found"))?;
    let placement = crate::commands::calendar::TaskPlacement {
        id: id.to_string(),
        column,
        index,
        completed_stamp: Some(completion_stamp(task, args)?),
    };
    let was_done = task.percent >= 100;
    let changed = crate::commands::calendar::move_tasks_at(stores.calendar, vec![placement])?;
    let moved = match changed.iter().find(|t| t.id == id) {
        Some(task) => task.clone(),
        // Already in that slot: nothing changed, which is still a success.
        None => find_task(stores, id)?,
    };
    let changes = changed
        .iter()
        .map(|t| {
            // Only a move that completed or reopened the card changed anything a
            // server holds; the neighbours of a reindex never did.
            let local = t.id != id || (t.percent >= 100) == was_done;
            task_upsert(t).map(|(_, change)| Change { local, ..change })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((serde_json::to_value(&moved).map_err(|e| e.to_string())?, changes))
}

fn todo_delete(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    // The row rides along, as for an event: the CalDAV copy is addressed by it.
    let row = serde_json::to_value(find_task(stores, id)?).map_err(|e| e.to_string())?;
    crate::commands::calendar::delete_task_at(stores.calendar, id)?;
    Ok((json!({ "deleted": id }), Change { kind: "task", op: "delete", row, local: false }))
}

// ── The read-only sweeps ────────────────────────────────────────────────────
//
// Five tools that answer a question about *every* project at once, which is the
// one thing a project agent structurally cannot do. All of them are pure reads of
// files Eldrun already owns, and none of them opens a connection: the git sweep
// runs `git` on the local working copy only, and `sync_status` reports the state
// the last sync pass recorded rather than probing the host. That is deliberate —
// a synchronous SSH round trip from a tool call would stall the handler for as
// long as a dead session takes to time out, per project.

/// The `[from, to)` window the rollup readers share: inclusive lower bound,
/// exclusive upper, either or both absent. Same convention as `calendar_list`.
fn date_range(args: &Value) -> Result<(Option<&str>, Option<&str>), String> {
    let range = (str_arg(args, "from"), str_arg(args, "to"));
    for bound in [range.0, range.1].into_iter().flatten() {
        if !valid_date(bound) {
            return Err(format!("'{bound}' is not a YYYY-MM-DD date"));
        }
    }
    Ok(range)
}

fn in_range(day: &str, (from, to): (Option<&str>, Option<&str>)) -> bool {
    from.is_none_or(|f| day >= f) && to.is_none_or(|t| day < t)
}

/// The optional `project` argument, resolved to an id.
fn project_filter(stores: &Stores, args: &Value) -> Result<Option<String>, String> {
    match str_arg(args, "project") {
        Some(wanted) => resolve_project(stores, wanted).map(Some),
        None => Ok(None),
    }
}

fn project_names(path: &Path) -> HashMap<String, String> {
    read_projects(path).into_iter().map(|p| (p.id, p.name)).collect()
}

/// What to call a counter's scope. The rollups are keyed by scope id, not by
/// project id alone: the root terminal has its own, and a project deleted since
/// the counter was written has no name left — which is reported as the bare id
/// rather than dropped, because the time is still real.
fn scope_name(names: &HashMap<String, String>, id: &str) -> String {
    if id == crate::storage::ROOT_SCOPE {
        return "Root".to_string();
    }
    names.get(id).cloned().unwrap_or_else(|| id.to_string())
}

/// A unix stamp as an ISO-8601 UTC string, for the "when did this last happen"
/// fields. `None` stays `None` — a never-synced project must not read as 1970.
fn iso_utc(secs: Option<u64>) -> Option<String> {
    let (y, mo, d, h, mi, s) = crate::storage::epoch_to_utc(secs?);
    Some(format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z"))
}

fn time_summary(stores: &Stores, args: &Value) -> Result<Value, String> {
    let range = date_range(args)?;
    let only = project_filter(stores, args)?;
    // The file, not `time_log::load_summary_migrating`: the running app has long
    // since folded any legacy log in, and a tool annotated read-only must not be
    // the thing that rewrites the store.
    let summary: crate::schema::time_log::TimeSummary =
        crate::storage::read_json(&stores.state.join(crate::schema::time_log::SUMMARY_FILE))
            .unwrap_or_default();
    let names = project_names(stores.projects);

    let mut per_project: HashMap<&str, f64> = HashMap::new();
    let mut per_day: Vec<(&str, f64)> = Vec::new();
    let mut app = 0f64;
    for (day, by_project) in &summary.days {
        if !in_range(day, range) {
            continue;
        }
        let mut day_total = 0f64;
        for (id, secs) in by_project {
            if !secs.is_finite() || *secs <= 0.0 {
                continue;
            }
            // Eldrun's own window time is not any project's work.
            if id == crate::commands::timer::APP_TIMER_ID {
                if stores.access.projects.all { app += secs; }
                continue;
            }
            if !stores.access.projects.contains(id) || only.as_deref().is_some_and(|o| o != id) {
                continue;
            }
            *per_project.entry(id.as_str()).or_insert(0.0) += secs;
            day_total += secs;
        }
        if day_total > 0.0 {
            per_day.push((day.as_str(), day_total));
        }
    }

    let mut projects: Vec<(&str, f64)> = per_project.into_iter().collect();
    projects.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    per_day.sort_by(|a, b| a.0.cmp(b.0));
    let total: f64 = projects.iter().map(|(_, secs)| *secs).sum();
    Ok(json!({
        "unit": "seconds",
        "from": range.0,
        "to": range.1,
        "total_seconds": total.round() as u64,
        "app_seconds": app.round() as u64,
        "projects": projects
            .iter()
            .map(|(id, secs)| json!({
                "id": id,
                "name": scope_name(&names, id),
                "seconds": secs.round() as u64,
            }))
            .collect::<Vec<_>>(),
        "days": per_day
            .iter()
            .map(|(day, secs)| json!({ "date": day, "seconds": secs.round() as u64 }))
            .collect::<Vec<_>>(),
    }))
}

fn usage_recap(stores: &Stores, args: &Value) -> Result<Value, String> {
    let range = date_range(args)?;
    let only = project_filter(stores, args)?;
    // Asking about one project is asking for its own numbers, so the filter
    // implies the breakdown; without either, the totals alone keep the reply small.
    let by_project = only.is_some() || args.get("by_project").and_then(Value::as_bool).unwrap_or(false);
    let stats: crate::schema::usage_stats::UsageStats =
        crate::storage::read_json(&stores.state.join(crate::schema::usage_stats::STATS_FILE))
            .unwrap_or_default();
    let names = project_names(stores.projects);

    let mut totals: HashMap<&str, u64> = HashMap::new();
    let mut per_project: HashMap<&str, HashMap<&str, u64>> = HashMap::new();
    let mut days = 0usize;
    for (day, by_id) in &stats.days {
        if !in_range(day, range) {
            continue;
        }
        if by_id.keys().any(|id| stores.access.projects.contains(id) && only.as_deref().is_none_or(|o| o == id)) { days += 1; }
        for (id, counters) in by_id {
            if !stores.access.projects.contains(id) || only.as_deref().is_some_and(|o| o != id) {
                continue;
            }
            for (key, count) in counters {
                *totals.entry(key.as_str()).or_insert(0) += count;
                if by_project {
                    *per_project
                        .entry(id.as_str())
                        .or_default()
                        .entry(key.as_str())
                        .or_insert(0) += count;
                }
            }
        }
    }

    let counter_map = |counters: &HashMap<&str, u64>| -> Value {
        counters.iter().map(|(k, v)| ((*k).to_string(), json!(v))).collect::<serde_json::Map<_, _>>().into()
    };
    let mut rows: Vec<(&str, Value)> = per_project
        .iter()
        .map(|(id, counters)| {
            let total: u64 = counters.values().sum();
            (
                *id,
                json!({ "id": id, "name": scope_name(&names, id), "counters": counter_map(counters), "total": total }),
            )
        })
        .collect();
    rows.sort_by(|a, b| {
        let key = |v: &Value| v["total"].as_u64().unwrap_or(0);
        key(&b.1).cmp(&key(&a.1)).then_with(|| a.0.cmp(b.0))
    });
    let mut out = json!({
        "from": range.0,
        "to": range.1,
        "days_counted": days,
        "totals": counter_map(&totals),
    });
    if by_project {
        out["projects"] = rows.into_iter().map(|(_, row)| row).collect::<Vec<_>>().into();
    }
    Ok(out)
}

fn boxes_list(stores: &Stores, args: &Value) -> Result<Value, String> {
    let only = project_filter(stores, args)?;
    let boxes: crate::schema::boxes::BoxesList =
        crate::storage::read_json(&stores.state.join("boxes.json")).unwrap_or_default();
    let names = project_names(stores.projects);
    let mut boxes: Vec<_> = boxes
        .into_iter()
        .filter(|b| b.member_ids.iter().all(|id| stores.access.projects.contains(id))
            && b.relations.iter().all(|r| stores.access.projects.contains(&r.source) && stores.access.projects.contains(&r.target)))
        .filter(|b| only.as_deref().is_none_or(|p| b.member_ids.iter().any(|m| m == p)))
        .collect();
    boxes.sort_by(|a, b| a.position.cmp(&b.position).then_with(|| a.name.cmp(&b.name)));
    let rows: Vec<Value> = boxes
        .iter()
        .map(|b| {
            json!({
                "id": b.id,
                "name": b.name,
                "folder": b.folder,
                "members": b.member_ids
                    .iter()
                    .map(|id| json!({ "id": id, "name": scope_name(&names, id) }))
                    .collect::<Vec<_>>(),
                "relations": b.relations
                    .iter()
                    .map(|r| json!({
                        "source": scope_name(&names, &r.source),
                        "target": scope_name(&names, &r.target),
                        "kind": r.kind,
                    }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({ "boxes": rows }))
}

/// What `git status --porcelain=v1 --branch` says about one working copy.
#[derive(Debug, Default, PartialEq)]
struct GitSnapshot {
    /// `None` on a detached HEAD.
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    staged: usize,
    unstaged: usize,
    untracked: usize,
}

/// Parse the `## …` header line: the branch, its upstream, and how far apart
/// they are. The shapes git emits are `## main`, `## main...origin/main`,
/// `## main...origin/main [ahead 1, behind 2]`, `## main...origin/main [gone]`,
/// `## HEAD (no branch)` and `## No commits yet on main`.
fn parse_branch_header(line: &str) -> (Option<String>, Option<String>, u32, u32) {
    let rest = line.trim_start_matches("## ");
    let rest = rest.strip_prefix("No commits yet on ").unwrap_or(rest);
    let (names, track) = match rest.split_once(" [") {
        Some((names, track)) => (names, track.trim_end_matches(']')),
        None => (rest, ""),
    };
    let (branch, upstream) = match names.split_once("...") {
        Some((branch, upstream)) => (branch, Some(upstream.to_string())),
        None => (names, None),
    };
    let count = |what: &str| {
        track
            .split(", ")
            .find_map(|part| part.strip_prefix(what)?.trim().parse::<u32>().ok())
            .unwrap_or(0)
    };
    let branch = (branch != "HEAD (no branch)").then(|| branch.to_string());
    (branch, upstream, count("ahead "), count("behind "))
}

fn parse_porcelain(text: &str) -> GitSnapshot {
    let mut snap = GitSnapshot::default();
    for line in text.lines() {
        if let Some(header) = line.strip_prefix("## ") {
            let (branch, upstream, ahead, behind) = parse_branch_header(header);
            (snap.branch, snap.upstream, snap.ahead, snap.behind) = (branch, upstream, ahead, behind);
            continue;
        }
        let mut chars = line.chars();
        let (Some(x), Some(y)) = (chars.next(), chars.next()) else { continue };
        if x == '?' && y == '?' {
            snap.untracked += 1;
        } else {
            if x != ' ' {
                snap.staged += 1;
            }
            if y != ' ' {
                snap.unstaged += 1;
            }
        }
    }
    snap
}

/// `git status` on one local directory. `Ok(None)` for "not a git repository",
/// which is an answer about the folder rather than a failure of the sweep.
///
/// `GIT_OPTIONAL_LOCKS=0` for the same reason the file tree sets it: a status
/// read that refreshes the index takes `index.lock`, and a background reader
/// doing that is half of the root git-status loop.
fn git_snapshot(stores: &Stores, dir: &Path) -> Result<Option<GitSnapshot>, String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    stores.check()?;
    let mut command = crate::commands::git::hookless_git_command_in(
        dir, &["status", "--porcelain=v1", "--branch"],
    );
    command.env("GIT_OPTIONAL_LOCKS", "0").stdin(Stdio::null()).stderr(Stdio::null()).stdout(Stdio::piped());
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| format!("running git: {e}"))?;
    let stdout = child.stdout.take().ok_or("Missing git output pipe")?;
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take((security::MAX_RESPONSE + 1) as u64).read_to_end(&mut bytes)
            .map_err(|e| e.to_string()).and_then(|_| {
                if bytes.len() > security::MAX_RESPONSE { Err("Git output limit exceeded".into()) } else { Ok(bytes) }
            });
        let _ = tx.send(result);
    });
    let deadline = stores.deadline.unwrap_or_else(|| Instant::now() + Duration::from_secs(3))
        .min(Instant::now() + Duration::from_secs(3));
    let result = loop {
        if let Err(e) = stores.check() { break Err(e); }
        if Instant::now() >= deadline { break Err("Git status timed out".into()); }
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(result) => break result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {},
            Err(_) => break Err("Git output reader stopped".into()),
        }
    };
    // A closed stdout is not process completion. Bound that wait too.
    let result = result.and_then(|bytes| loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.success().then(|| parse_porcelain(&String::from_utf8_lossy(&bytes)))),
            Err(e) => break Err(e.to_string()),
            Ok(None) => {},
        }
        if Instant::now() >= deadline || stores.check().is_err() { break Err("Git status cancelled or timed out".into()); }
        std::thread::sleep(Duration::from_millis(10));
    });
    if result.is_err() {
        crate::terminal::reap_child_subtree(child.id(), crate::terminal::ReapMode::Immediate);
        #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = reader.join();
    result
}

/// The **local** working copy to read for a project, and what it is: a local
/// project's own folder, or a remote project's local mirror. `Err` carries the
/// reason there is none, which the sweep reports rather than swallowing.
fn local_checkout(entry: &crate::schema::projects::ProjectEntry) -> Result<(String, &'static str), String> {
    let field = |key: &str| {
        entry
            .extra
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let (dir, source) = if entry.extra.get("remote").is_some_and(|r| !r.is_null()) {
        // Never the host: see the note above this section.
        let mirror = field("mirror")
            .ok_or("remote project with no local mirror; its files live on the host")?;
        (mirror, "mirror")
    } else {
        (field("directory").ok_or("no folder recorded")?, "project")
    };
    if !Path::new(dir).is_dir() {
        return Err(format!("folder is missing: {dir}"));
    }
    Ok((dir.to_string(), source))
}

fn projects_git_status(stores: &Stores, args: &Value) -> Result<Value, String> {
    if !crate::commands::git::git_available() {
        return Err("git is not installed (or not on PATH), so no working copy can be read".into());
    }
    let only = project_filter(stores, args)?;
    let dirty_only = args.get("dirty_only").and_then(Value::as_bool).unwrap_or(false);
    let (mut rows, mut skipped) = (Vec::new(), Vec::new());
    for entry in read_projects(stores.projects) {
        stores.check()?;
        if !stores.access.projects.contains(&entry.id) || crate::paths::is_trash_project_id(&entry.id) || only.as_deref().is_some_and(|o| o != entry.id) {
            continue;
        }
        let skip = |reason: String| json!({ "id": entry.id, "name": entry.name, "reason": reason });
        let (dir, source) = match local_checkout(&entry) {
            Ok(found) => found,
            Err(reason) => {
                skipped.push(skip(reason));
                continue;
            }
        };
        let snap = match git_snapshot(stores, Path::new(&dir)) {
            Ok(Some(snap)) => snap,
            Ok(None) => {
                skipped.push(skip("not a git repository".into()));
                continue;
            }
            Err(error) => {
                skipped.push(skip(error));
                continue;
            }
        };
        let clean = snap.staged == 0 && snap.unstaged == 0 && snap.untracked == 0;
        if dirty_only && clean && snap.ahead == 0 && snap.behind == 0 {
            continue;
        }
        rows.push(json!({
            "id": entry.id,
            "name": entry.name,
            "source": source,
            "directory": dir,
            "branch": snap.branch,
            "upstream": snap.upstream,
            "ahead": snap.ahead,
            "behind": snap.behind,
            "staged": snap.staged,
            "unstaged": snap.unstaged,
            "untracked": snap.untracked,
            "clean": clean,
        }));
    }
    Ok(json!({ "projects": rows, "skipped": skipped }))
}

/// A lockstep HEAD as one line — "main @ a1b2c3d4" — rather than the stored
/// record. An agent comparing two sides wants to read them, not destructure them.
fn head_line(head: Option<&crate::services::git_peer::HeadRef>) -> Option<String> {
    use crate::services::git_peer::HeadRef;
    let short = |sha: &String| sha.chars().take(8).collect::<String>();
    match head? {
        HeadRef::Branch { name, sha } => Some(format!("{name} @ {}", short(sha))),
        HeadRef::Detached { sha } => Some(format!("detached @ {}", short(sha))),
        HeadRef::Unborn => Some("no commits yet".to_string()),
    }
}

fn sync_status(stores: &Stores, args: &Value) -> Result<Value, String> {
    let only = project_filter(stores, args)?;
    let include_acked = args.get("include_acked").and_then(Value::as_bool).unwrap_or(false);
    let (mut rows, mut local) = (Vec::new(), 0usize);
    for entry in read_projects(stores.projects) {
        stores.check()?;
        if !stores.access.projects.contains(&entry.id) || crate::paths::is_trash_project_id(&entry.id) || only.as_deref().is_some_and(|o| o != entry.id) {
            continue;
        }
        let Some(remote) = entry.extra.get("remote").filter(|r| !r.is_null()) else {
            local += 1;
            continue;
        };
        let peer: crate::services::git_peer::GitPeerState = crate::storage::read_json(
            &crate::services::git_peer::state_path_in(stores.state, &entry.id),
        )
        .unwrap_or_default();
        let manifest: crate::services::remote_sync::Manifest = crate::storage::read_json(
            &crate::services::remote_sync::manifest_path_in(stores.state, &entry.id),
        )
        .unwrap_or_default();
        let losses: Vec<crate::services::local_loss::LocalLoss> = crate::storage::read_json(
            &crate::services::local_loss::log_path_in(stores.state, &entry.id),
        )
        .unwrap_or_default();

        let tracked = manifest.values().filter(|e| e.selected && !e.is_dir).count();
        let folders = manifest.values().filter(|e| e.selected && e.is_dir).count();
        let auto = manifest.values().filter(|e| e.auto_sync).count();
        let excluded = manifest.values().filter(|e| e.excluded).count();
        let warnings: Vec<Value> = losses
            .iter()
            .filter(|l| include_acked || !l.acked)
            .map(|l| {
                json!({
                    "when": iso_utc(Some(l.ts)),
                    "source": l.source,
                    "kind": l.kind,
                    "op": l.op,
                    // The log already caps its path list; this caps what a sweep
                    // over every project spends on one of them.
                    "paths": l.paths.iter().take(5).collect::<Vec<_>>(),
                    "total": l.total,
                    "recovery": l.recovery,
                    "acknowledged": l.acked,
                })
            })
            .collect();
        rows.push(json!({
            "id": entry.id,
            "name": entry.name,
            "host": remote.get("host").and_then(Value::as_str),
            "lockstep": {
                "enabled": peer.enabled,
                "status": peer.status,
                "detail": peer.detail,
                "local_head": head_line(peer.local_head.as_ref()),
                "remote_head": head_line(peer.remote_head.as_ref()),
                "last_pass": iso_utc(peer.last_sync_ts),
                "blocked_by_pairing_conflict": peer.pairing_conflict.is_some(),
            },
            "byte_sync": {
                "tracked_files": tracked,
                "tracked_folders": folders,
                "auto_paths": auto,
                "excluded_paths": excluded,
                "last_pull": iso_utc(manifest.values().filter_map(|e| e.last_pull_ts).max()),
                "last_push": iso_utc(manifest.values().filter_map(|e| e.last_push_ts).max()),
            },
            "warnings": warnings,
        }));
    }
    Ok(json!({
        "as_of": "the last recorded pass; no host was contacted",
        "remote_projects": rows,
        "local_projects_skipped": local,
    }))
}

pub(crate) fn call_tool(stores: &Stores, name: &str, args: &Value) -> Result<(Value, Effects), String> {
    call_store_tool(stores, name, args).map(|(v, changes)| (v, Effects::wrote(changes)))
}

fn call_store_tool(stores: &Stores, name: &str, args: &Value) -> Result<(Value, Vec<Change>), String> {
    let wrote = |r: Result<(Value, Change), String>| r.map(|(v, c)| (v, vec![c]));
    match name {
        "projects_list" => projects_list(stores).map(|v| (v, Vec::new())),
        "projects_git_status" => projects_git_status(stores, args).map(|v| (v, Vec::new())),
        "boxes_list" => boxes_list(stores, args).map(|v| (v, Vec::new())),
        "calendar_list" => calendar_list(stores, args).map(|v| (v, Vec::new())),
        "calendar_create" => wrote(calendar_create(stores, args)),
        "calendar_add_event" => wrote(calendar_add_event(stores, args)),
        "calendar_update_event" => calendar_update_event(stores, args),
        "calendar_move_events" => calendar_move_events(stores, args),
        "calendar_delete_event" => wrote(calendar_delete_event(stores, args)),
        "todo_list" => todo_list(stores, args).map(|v| (v, Vec::new())),
        "todo_add" => wrote(todo_add(stores, args)),
        "todo_complete" => wrote(todo_complete(stores, args)),
        "todo_reopen" => wrote(todo_reopen(stores, args)),
        "todo_update" => wrote(todo_update(stores, args)),
        "todo_move" => todo_move(stores, args),
        "todo_delete" => wrote(todo_delete(stores, args)),
        "time_summary" => time_summary(stores, args).map(|v| (v, Vec::new())),
        "usage_recap" => usage_recap(stores, args).map(|v| (v, Vec::new())),
        "sync_status" => sync_status(stores, args).map(|v| (v, Vec::new())),
        other => Err(format!("unknown tool '{other}'")),
    }
}

// ── JSON-RPC ────────────────────────────────────────────────────────────────

fn paginate(value: &mut Value, args: &Value) {
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let limit = args["limit"].as_u64().unwrap_or(50).min(security::MAX_ROWS as u64) as usize;
    let mut next = serde_json::Map::new();
    if let Some(object) = value.as_object_mut() {
        for (key, field) in object.iter_mut() {
            if let Some(rows) = field.as_array_mut() {
                let total = rows.len();
                let end = offset.saturating_add(limit).min(total);
                let page = rows.drain(offset.min(total)..end).collect();
                *rows = page;
                if end < total { next.insert(key.clone(), json!(end)); }
            }
        }
        if !next.is_empty() { object.insert("next_offsets".into(), Value::Object(next)); }
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Answer one JSON-RPC message. `None` for a notification (no `id`), which MCP
/// answers with `202 Accepted` and no body. Blocking: it reads and writes files.
pub fn handle_message(stores: &Stores, tab: &str, message: &Value) -> (Option<Value>, Effects) {
    if message["jsonrpc"] != "2.0" || !message["method"].is_string()
        || message.get("id").is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
        || message.get("params").is_some_and(|p| !p.is_object()) {
        return (Some(rpc_error(Value::Null, -32600, "invalid request")), Effects::default());
    }
    let Some(id) = message.get("id").filter(|v| !v.is_null()).cloned() else {
        return (None, Effects::default());
    };
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let ok = |result: Value| Some(json!({ "jsonrpc": "2.0", "id": id.clone(), "result": result }));
    if !stores.policy.serves(stores.caller) || stores.check().is_err()
        || (stores.caller == Caller::Reader && stores.reader_refusal.is_some()) {
        return (Some(rpc_error(id, -32000, "MCP access unavailable")), Effects::default());
    }
    match method {
        "initialize" => (
            ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Eldrun's cross-project console: the user's projects (their boxes, git state, tracked time and activity counters, and how remote ones stand with their hosts), the calendar and the to-do board. Event and card times are local wall-clock, never UTC; the rollups time_summary and usage_recap are bucketed by UTC date, as they were recorded. Writes are normally staged proposals: when staged is true, say proposed, never done. Only the user can approve in Eldrun. Use proposals_list to check status; dropped_proposals no longer apply.",
            })),
            Effects::default(),
        ),
        "ping" => (ok(json!({})), Effects::default()),
        "tools/list" => (
            ok(json!({ "tools": tool_definitions(stores.caller, stores.policy.mail).as_array().unwrap().iter()
                .filter(|t| stores.access.allows(stores.caller, t["name"].as_str().unwrap_or(""))).collect::<Vec<_>>() })),
            Effects::default(),
        ),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let empty = json!({});
            let args = params.get("arguments").unwrap_or(&empty);
            // A failed tool is a *result* with `isError`, not a protocol error:
            // that is what lets the model read the message and correct itself.
            // A tool outside the caller's class does not exist for it: the
            // same answer an invented name gets.
            let definitions = tool_definitions(stores.caller, true);
            let schema = definitions.as_array().unwrap().iter().find(|t| t["name"] == name);
            let validation = schema.map(|t| security::validate(&t["inputSchema"], args))
                .unwrap_or_else(|| Err("unknown tool".into()));
            let result = if !stores.access.allows(stores.caller, name) {
                Err(format!("unknown tool '{name}'"))
            } else if super::root_mcp_mail::is_mail_tool(name) && !stores.policy.mail {
                // Its own switch, off by default: unlisted, and named when
                // called anyway so the agent can tell the user what to flip.
                Err(MAIL_OFF.to_string())
            } else if let Err(error) = validation {
                Err(error)
            } else if super::root_mcp_mail::is_mail_tool(name) {
                // Mail touches no calendar row, so it has nothing to stage: the
                // draft *is* the proposal and the composer's Send the approval.
                super::root_mcp_mail::call(stores, name, args)
            } else {
                super::root_mcp_review::call(stores, tab, name, args)
            };
            let result = result.and_then(|(mut value, effects)| {
                if security::tool(name).is_some_and(|t| !t.write && t.family != "mail") {
                    paginate(&mut value, args);
                }
                if security::tool(name).is_some_and(|t| !t.write) { stores.check()?; }
                Ok((value, effects))
            });
            match result {
                Ok((value, effects)) => {
                    let text = match &value { Value::String(s) => s.clone(), v => v.to_string() };
                    let mut reply = ok(json!({"content":[{"type":"text", "text":text}], "isError":false}));
                    if reply.as_ref().unwrap().to_string().len() > security::MAX_RESPONSE {
                        let write = security::tool(name).is_some_and(|t| t.write);
                        let receipt = if write {
                            json!({"result_omitted":true, "staged":value["staged"].as_bool().unwrap_or(false),
                                "proposal":value.get("proposal"), "note":"Change recorded; result is too large to return. Review it in Eldrun."}).to_string()
                        } else { "Result exceeds the response limit; narrow the query".into() };
                        reply = ok(json!({"content":[{"type":"text", "text":receipt}], "isError":!write}));
                    }
                    // Never lose committed change events because a receipt
                    // was large, or because the caller disconnected afterwards.
                    (reply, effects)
                },
                Err(error) => (
                    ok(json!({
                        "content": [{ "type": "text", "text": error }],
                        "isError": true,
                    })),
                    Effects::default(),
                ),
            }
        }
        _ => (Some(rpc_error(id, -32601, "method not found")), Effects::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn narrowing_invalidates_already_authenticated_requests() {
        let (token, old) = test_session(Caller::Agent);
        let mut access = old.access.clone(); access.write = false;
        set_access(&old.id, access).unwrap();
        assert!(old.check().is_err());
        let current = authenticate(Some(&format!("Bearer {token}"))).unwrap();
        assert!(current.check().is_ok());
        assert!(!current.access.allows(Caller::Agent, "todo_delete"));
        revoke_session(&current.id).unwrap();
        assert!(current.check().is_err());
    }

    #[test]
    fn rpc_types_and_scope_filters_cannot_be_bypassed() {
        let f = Fixture::new();
        let mut stores = f.stores();
        stores.access.projects = security::Scope { all: false, ids: vec!["p1".into()] };
        let list = projects_list(&stores).unwrap();
        assert_eq!(list["projects"].as_array().unwrap().len(), 1);
        assert!(resolve_project(&stores, "p2").is_err());
        assert!(resolve_project(&stores, "Beta").is_err());
        for message in [json!({"method":"ping", "id":1}), json!({"jsonrpc":"2.0","method":"ping","id":[]})] {
            assert_eq!(handle_message(&stores, "t", &message).0.unwrap()["error"]["code"], -32600);
        }
        for args in [json!([]), json!({"title":"test","start":7}), json!({"title":"test","start":"2026-09-20","unexpected":true})] {
            let message = json!({"jsonrpc":"2.0","id":1,"method":"tools/call", "params":{"name":"calendar_add_event","arguments":args}});
            let (reply, effects) = handle_message(&stores, "t", &message);
            assert_eq!(reply.unwrap()["result"]["isError"], true);
            assert!(effects.changes.is_empty());
            assert!(!f.calendar.exists());
        }
    }

    #[test]
    fn policy_change_refuses_a_queued_request() {
        let f = Fixture::new();
        let (_, session) = test_session(Caller::Agent);
        let stores = Stores { session: Some(&session), ..f.stores() };
        assert!(stores.check().is_ok());
        f.write_state("settings.json", json!({"root_mcp":false}));
        assert!(stores.check().is_err());
        revoke_tab(&session.identity.tab);
    }

    fn opts(cmd: &str, args: &[&str], project_id: Option<&str>) -> PtyOptions {
        PtyOptions {
            cmd: cmd.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            project_id: project_id.map(str::to_string),
            env: HashMap::new(),
            id: "root:t".to_string(),
            cwd: String::new(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            agent: true,
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
        }
    }

    fn rt() -> Runtime {
        Runtime { port: 4321 }
    }

    /// Missing keys retain old defaults; an unavailable policy file refuses.
    #[test]
    fn the_switch_is_on_unless_stored_off() {
        let fx = Fixture::new();
        std::fs::remove_file(&fx.settings).unwrap();
        assert!(!enabled_in(&fx.settings), "missing security settings refuse access");
        fx.write_state("settings.json", json!({ "debug": true }));
        assert!(enabled_in(&fx.settings));
        fx.write_state("settings.json", json!({ "root_mcp": false }));
        assert!(!enabled_in(&fx.settings));
        fx.write_state("settings.json", json!({ "root_mcp": true }));
        assert!(enabled_in(&fx.settings));
    }

    struct Fixture {
        dir: tempfile::TempDir,
        calendar: std::path::PathBuf,
        projects: std::path::PathBuf,
        settings: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let calendar = dir.path().join("calendar.json");
            let projects = dir.path().join("projects.json");
            std::fs::write(
                &projects,
                r#"[{"id":"p1","name":"Alpha","status":"active","position":0,"local_file":"","directory":"/w/alpha"},
                    {"id":"p2","name":"Beta","status":"inactive","position":1,"local_file":"","remote":{"host":"h"}}]"#,
            )
            .unwrap();
            let settings = dir.path().join("settings.json");
            // Mail is off by default; the class tables below cover every tool.
            std::fs::write(&settings, r#"{"root_mcp_mail":true}"#).unwrap();
            Fixture { dir, calendar, projects, settings }
        }
        fn stores(&self) -> Stores<'_> {
            Stores {
                calendar: &self.calendar,
                projects: &self.projects,
                settings: &self.settings,
                state: self.dir.path(),
                caller: Caller::Agent,
                mail: None,
                reader_refusal: None,
                policy: Policy::load(&self.settings).unwrap(),
                access: Access::initial(Caller::Agent), session: None, deadline: None,
            }
        }
        /// Write one of the flat state files the read-only sweeps roll up.
        fn write_state(&self, name: &str, body: Value) {
            std::fs::write(self.dir.path().join(name), body.to_string()).unwrap();
        }
        /// Write one of a remote project's per-project state files.
        fn write_remote_state(&self, project_id: &str, name: &str, body: Value) {
            let dir = self.dir.path().join("remote-projects").join(project_id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(name), body.to_string()).unwrap();
        }
        fn call_fx(&self, name: &str, args: Value) -> (Value, Effects) {
            let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                              "params": { "name": name, "arguments": args } });
            let mut settings: Value = crate::storage::read_json(&self.settings).unwrap_or(json!({}));
            settings["root_mcp_review"] = json!("off");
            self.write_state("settings.json", settings);
            let (reply, effects) = handle_message(&self.stores(), "root:test", &msg);
            (reply.unwrap()["result"].clone(), effects)
        }
        fn call(&self, name: &str, args: Value) -> (Value, Vec<Change>) {
            let (result, effects) = self.call_fx(name, args);
            (result, effects.changes)
        }
    }

    /// Every CLI the spawn tests use, all wearing the "MCP" chip.
    fn every_agent() -> Vec<String> {
        WIRED_CLIS.iter().chain(&["gemini", "vibe"]).map(|c| c.to_string()).collect()
    }

    fn text(result: &Value) -> Value {
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap_or(Value::Null)
    }

    #[test]
    fn only_a_root_scope_agent_is_a_root_agent() {
        assert!(is_root_agent(&opts("claude", &[], None), true));
        assert!(!is_root_agent(&opts("claude", &[], Some("p1")), true));
        assert!(!is_root_agent(&opts("claude", &[], Some("box:b")), true));
        // A root *shell* is not an agent and gets nothing.
        assert!(!is_root_agent(&opts("bash", &[], None), false));
    }

    #[test]
    fn claude_gets_an_inline_config_last_in_argv() {
        let mut o = opts("claude", &["--resume", "abc"], None);
        apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], false);
        assert_eq!(&o.args[..2], ["--resume", "abc"]);
        assert_eq!(o.args[2], "--mcp-config");
        let cfg: Value = serde_json::from_str(&o.args[3]).unwrap();
        let server = &cfg["mcpServers"]["eldrun"];
        assert_eq!(server["url"], "http://127.0.0.1:4321/mcp");
        assert_eq!(server["headers"]["Authorization"], "Bearer ${ELDRUN_ROOT_MCP_TOKEN}");
        assert_eq!(o.env[TOKEN_ENV], "tok");
        assert!(!o.args.iter().any(|a| a.contains("Bearer tok")), "the token is never in Claude's argv");
        // A respawn that re-runs the wiring must not stack the flag.
        apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], false);
        assert_eq!(o.args.iter().filter(|a| *a == "--mcp-config").count(), 1);
    }

    #[test]
    fn every_wired_cli_is_named_the_server() {
        for cli in WIRED_CLIS {
            let mut o = opts(cli, &[], None);
            apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], false);
            assert!(!o.args.is_empty(), "{cli} is listed as wired but gets no server");
        }
        // An unlisted CLI gets the env pair only — which is what the chip says.
        let mut o = opts("gemini", &[], None);
        apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], false);
        assert!(o.args.is_empty() && o.env.contains_key(TOKEN_ENV));
    }

    #[test]
    fn codex_overrides_precede_the_resume_subcommand_and_name_the_token() {
        let mut o = opts("/usr/bin/codex", &["resume", "abc"], None);
        apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], false);
        assert_eq!(o.args[0], "-c");
        assert_eq!(o.args[1], "mcp_servers.eldrun.url=\"http://127.0.0.1:4321/mcp\"");
        assert_eq!(o.args[3], "mcp_servers.eldrun.bearer_token_env_var=\"ELDRUN_ROOT_MCP_TOKEN\"");
        assert_eq!(&o.args[4..], ["resume", "abc"]);
        assert!(!o.args.iter().any(|a| a.contains("tok\"")), "the token is never in Codex's argv");
    }

    #[test]
    fn vibe_gets_the_server_only_for_a_model_wearing_the_mcp_chip() {
        let tagged = vec!["gemma4:e4b".to_string()];
        let vibe = |env: &[(&str, &str)]| {
            let mut o = opts("vibe", &[], None);
            for (k, v) in env {
                o.env.insert(k.to_string(), v.to_string());
            }
            o
        };

        let mut o = vibe(&[("ELDRUN_LOCAL_MODEL", "gemma4:e4b"), ("VIBE_ACTIVE_MODEL", "gemma4-e4b")]);
        apply_to_spawn_with(&mut o, &rt(), "tok", &[], &tagged, false);
        let servers: Value = serde_json::from_str(&o.env["VIBE_MCP_SERVERS"]).unwrap();
        assert_eq!(servers[0]["name"], "eldrun");
        assert_eq!(servers[0]["url"], "http://127.0.0.1:4321/mcp");
        assert_eq!(servers[0]["api_key_env"], TOKEN_ENV);
        assert_eq!(o.env["VIBE_ENABLED_TOOLS"], r#"["eldrun_*"]"#);
        assert!(!o.env["VIBE_MCP_SERVERS"].contains("tok"), "the token is named, never inlined");
        assert!(o.args.is_empty());

        // A restored tab carries only the alias.
        let mut o = vibe(&[("VIBE_ACTIVE_MODEL", "gemma4-e4b")]);
        apply_to_spawn_with(&mut o, &rt(), "tok", &[], &tagged, false);
        assert!(o.env.contains_key("VIBE_MCP_SERVERS"));

        // Untagged model ("Root" without "MCP"): tools stay off and it gets
        // nothing — not even the env pair, whichever agents wear the chip.
        let mut o = vibe(&[("ELDRUN_LOCAL_MODEL", "llama3:latest"), ("VIBE_ACTIVE_MODEL", "llama3-latest")]);
        apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &tagged, false);
        assert!(!o.env.contains_key("VIBE_MCP_SERVERS"));
        assert!(!o.env.contains_key("VIBE_ENABLED_TOOLS"));
        assert!(!o.env.contains_key(URL_ENV) && !o.env.contains_key(TOKEN_ENV));
    }

    #[test]
    fn local_only_hands_cloud_agents_nothing_and_local_models_their_own_token() {
        for cmd in ["claude", "codex", "gemini", "vibe"] {
            let mut o = opts(cmd, &[], None);
            apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], true);
            assert!(o.args.is_empty(), "{cmd}");
            assert!(!o.env.contains_key(TOKEN_ENV), "{cmd}");
            assert!(!o.env.contains_key(URL_ENV), "{cmd}");
        }
        let tagged = vec!["gemma4:e4b".to_string()];
        let mut o = opts("vibe", &[], None);
        o.env.insert("ELDRUN_LOCAL_MODEL".into(), "gemma4:e4b".into());
        apply_to_spawn_with(&mut o, &rt(), "tok", &[], &tagged, true);
        assert!(o.env.contains_key("VIBE_MCP_SERVERS"));
        assert_eq!(o.env[TOKEN_ENV], "tok");
        // The local token is the local tab's with the switch off too, so
        // flipping it on later keeps that tab served.
        let mut o = opts("vibe", &[], None);
        o.env.insert("ELDRUN_LOCAL_MODEL".into(), "gemma4:e4b".into());
        apply_to_spawn_with(&mut o, &rt(), "tok", &[], &tagged, false);
        assert_eq!(o.env[TOKEN_ENV], "tok");
    }

    #[test]
    fn stale_spawn_teardown_cannot_revoke_a_replacement_token() {
        let tab = "root:token-generation";
        register_token("generation-old".into(), Identity { tab: tab.into(), caller: Caller::Agent, project: None });
        register_token("generation-new".into(), Identity { tab: tab.into(), caller: Caller::LocalModel, project: None });
        assert!(revoke_token("generation-old").is_none());
        assert_eq!(caller(Some("Bearer generation-new")).unwrap().tab, tab);
        let mut options = opts("vibe", &[], None);
        options.env.insert(TOKEN_ENV.into(), "generation-new".into());
        drop(SpawnTokenGuard::new(&options));
        assert!(caller(Some("Bearer generation-new")).is_none());
    }

    #[test]
    fn the_endpoint_tells_callers_apart_and_local_only_refuses_agents() {
        register_token("tok".into(), Identity { tab: "root:auth-agent".into(), caller: Caller::Agent, project: None });
        register_token("loc".into(), Identity { tab: "root:auth-local".into(), caller: Caller::LocalModel, project: None });
        assert_eq!(caller(Some("Bearer tok")).unwrap().caller, Caller::Agent);
        assert_eq!(caller(Some("Bearer loc")).unwrap().caller, Caller::LocalModel);
        assert_eq!(caller(Some("Bearer nope")), None);
        assert_eq!(caller(None), None);
        revoke_tab("root:auth-agent");
        assert_eq!(caller(Some("Bearer tok")), None);
        assert!(caller(Some("Bearer loc")).is_some());
        revoke_tab("root:auth-local");

        let fx = Fixture::new();
        assert!(serves(&fx.settings, Caller::Agent), "absent means every root agent");
        fx.write_state("settings.json", json!({ "root_mcp_local_only": true }));
        assert!(!serves(&fx.settings, Caller::Agent));
        assert!(serves(&fx.settings, Caller::LocalModel));
        fx.write_state("settings.json", json!({ "root_mcp": false, "root_mcp_local_only": true }));
        assert!(!serves(&fx.settings, Caller::LocalModel), "the global switch outranks it");
    }

    /// Mail has its own switch and it starts off: `root_mcp` alone lists no
    /// mail tool, refuses a call to one by name, and serves a reader nothing.
    #[test]
    fn mail_tools_are_off_until_switched_on_separately() {
        use crate::services::root_mcp_mail::is_mail_tool;
        let fx = Fixture::new();
        let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
        let draft = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                            "params": { "name": "mail_drafts_list", "arguments": {} } });
        let listed_mail = |fx: &Fixture| {
            let (reply, _) = handle_message(&fx.stores(), "t", &list);
            reply.unwrap()["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|t| is_mail_tool(t["name"].as_str().unwrap()))
                .count()
        };
        for off in [Some(json!({})), Some(json!({ "root_mcp": true })), Some(json!({ "root_mcp_mail": false }))] {
            match &off {
                Some(body) => fx.write_state("settings.json", body.clone()),
                None => std::fs::remove_file(&fx.settings).unwrap(),
            }
            assert!(!mail_enabled_in(&fx.settings), "{off:?}");
            assert_eq!(listed_mail(&fx), 0, "{off:?}");
            let (reply, _) = handle_message(&fx.stores(), "t", &draft);
            let result = reply.unwrap()["result"].clone();
            assert_eq!(result["isError"], true, "{off:?}");
            assert_eq!(result["content"][0]["text"], MAIL_OFF, "{off:?}");
            assert!(serves(&fx.settings, Caller::Agent), "the other tools stay on: {off:?}");
            assert!(!serves(&fx.settings, Caller::Reader), "a reader is mail only: {off:?}");
        }
        fx.write_state("settings.json", json!({ "root_mcp_mail": true }));
        assert!(listed_mail(&fx) > 0);
        assert!(serves(&fx.settings, Caller::Reader));
        fx.write_state("settings.json", json!({ "root_mcp": false, "root_mcp_mail": true }));
        assert!(!serves(&fx.settings, Caller::Reader), "the global switch outranks it");
    }

    #[test]
    fn a_root_agent_without_the_mcp_chip_gets_nothing() {
        let only_codex = vec!["codex".to_string()];
        for cmd in ["claude", "/usr/bin/claude", "gemini"] {
            let mut o = opts(cmd, &["--resume", "abc"], None);
            apply_to_spawn_with(&mut o, &rt(), "tok", &only_codex, &[], false);
            assert_eq!(o.args, ["--resume", "abc"], "{cmd}");
            assert!(o.env.is_empty(), "{cmd}");
        }
        let mut o = opts("/usr/bin/codex", &[], None);
        apply_to_spawn_with(&mut o, &rt(), "tok", &only_codex, &[], false);
        assert_eq!(o.env[TOKEN_ENV], "tok");
    }

    #[test]
    fn the_mcp_agent_list_falls_back_to_the_root_agents() {
        let s: crate::schema::Settings =
            serde_json::from_value(json!({ "root_agents": ["claude", "gemini"] })).unwrap();
        assert_eq!(s.root_mcp_agent_list(), ["claude", "gemini"], "pre-chip root agents keep the tools");
        let s: crate::schema::Settings =
            serde_json::from_value(json!({ "root_agents": ["claude"], "root_mcp_agents": [] })).unwrap();
        assert!(s.root_mcp_agent_list().is_empty(), "an explicit empty list is none");
    }

    #[test]
    fn other_agents_get_the_env_pair_only() {
        let mut o = opts("gemini", &[], None);
        apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], false);
        assert!(o.args.is_empty());
        assert_eq!(o.env[URL_ENV], "http://127.0.0.1:4321/mcp");
    }

    #[test]
    fn bearer_check() {
        assert!(authorized(Some("Bearer tok"), "tok"));
        assert!(!authorized(Some("Bearer to"), "tok"));
        assert!(!authorized(Some("tok"), "tok"));
        assert!(!authorized(None, "tok"));
    }

    #[test]
    fn minted_tokens_are_long_and_distinct() {
        let (a, b) = (mint_token().unwrap(), mint_token().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn notifications_get_no_reply_and_unknown_methods_an_error() {
        let f = Fixture::new();
        let (reply, _) = handle_message(&f.stores(), "root:test", &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        assert!(reply.is_none());
        let (reply, _) = handle_message(&f.stores(), "root:test", &json!({ "jsonrpc": "2.0", "id": 7, "method": "nope" }));
        assert_eq!(reply.unwrap()["error"]["code"], -32601);
    }

    #[test]
    fn tools_list_matches_the_advertised_names() {
        let f = Fixture::new();
        let (reply, _) = handle_message(&f.stores(), "root:test", &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
        let listed: Vec<String> = reply.unwrap()["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        // A root tab is shown everything but the mail read tools.
        let served_root: Vec<&str> = tool_names().into_iter().filter(|n| served(Caller::Agent, n)).collect();
        assert_eq!(listed, served_root);
        assert!(!listed.iter().any(|n| crate::services::root_mcp_mail::is_read_tool(n)));
    }

    /// Table-driven over every tool × every class: `tools/list` equals the
    /// served set exactly, and a call outside it is an unknown tool. A tool
    /// added later is in no class until someone places it on purpose.
    #[test]
    fn every_tool_has_a_class_and_dispatch_follows_it() {
        use crate::services::root_mcp_mail::READ_TOOLS;
        const SWEEP: &[&str] =
            &["projects_list", "projects_git_status", "sync_status", "time_summary", "usage_recap", "boxes_list"];
        let f = Fixture::new();
        for caller in [Caller::Agent, Caller::LocalModel, Caller::Reader] {
            let stores = Stores { caller, ..f.stores() };
            let (reply, _) = handle_message(&stores, "t", &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
            let listed: Vec<String> = reply.unwrap()["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_string())
                .collect();
            for name in tool_names() {
                let expected = if caller == Caller::Reader { !SWEEP.contains(&name) } else { !READ_TOOLS.contains(&name) };
                assert_eq!(served(caller, name), expected, "{caller:?} × {name}");
                assert_eq!(listed.iter().any(|l| l == name), expected, "tools/list: {caller:?} × {name}");
                let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                  "params": { "name": name, "arguments": {} } });
                let (reply, _) = handle_message(&stores, "t", &msg);
                let text = reply.unwrap()["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string();
                assert_eq!(!text.starts_with("unknown tool"), expected, "dispatch: {caller:?} × {name}: {text}");
            }
        }
        // A root tab's draft tools have no recipient and no reply argument.
        let (reply, _) = handle_message(&f.stores(), "t", &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
        let tools = reply.unwrap()["result"]["tools"].clone();
        let create = tools.as_array().unwrap().iter().find(|t| t["name"] == "mail_draft_create").unwrap().clone();
        for absent in ["to", "cc", "bcc", "reply_to_message_id"] {
            assert!(create["inputSchema"]["properties"].get(absent).is_none(), "{absent}");
        }
    }

    /// The reader wiring names the guest-side URL and the token only by name.
    #[test]
    fn a_reader_is_wired_to_the_guest_side_address_and_only_a_wired_cli() {
        let mut args = vec!["resume".to_string(), "abc".to_string()];
        let env = reader_wiring("codex", &mut args, "s3cret").unwrap();
        assert!(args[1].contains(&reader_endpoint_url()), "{args:?}");
        assert!(!args.iter().any(|a| a.contains("s3cret") || a.contains("127.0.0.1")), "{args:?}");
        assert_eq!(args[args.len() - 2..], ["resume".to_string(), "abc".to_string()]);
        assert!(env.contains(&(TOKEN_ENV.to_string(), "s3cret".to_string())));
        let mut args = Vec::new();
        reader_wiring("/usr/bin/claude", &mut args, "s3cret").unwrap();
        assert_eq!(args[0], "--mcp-config");
        assert!(args[1].contains(&reader_endpoint_url()) && !args[1].contains("s3cret"));
        assert!(reader_wiring("bash", &mut Vec::new(), "s3cret").is_none(), "a plain shell is handed nothing");
    }

    /// Two spawns get different tokens, each bound to its own tab and class; a
    /// closed tab's token is refused.
    #[test]
    fn tokens_are_per_tab_and_die_with_it() {
        let (a, b) = (mint_token().unwrap(), mint_token().unwrap());
        assert_ne!(a, b);
        register_token(a.clone(), Identity { tab: "root:pt-a".into(), caller: Caller::Agent, project: None });
        register_token(b.clone(), Identity { tab: "vm:pt-b".into(), caller: Caller::Reader, project: Some("p1".into()) });
        let ida = caller(Some(&format!("Bearer {a}"))).unwrap();
        let idb = caller(Some(&format!("Bearer {b}"))).unwrap();
        assert_eq!((ida.tab.as_str(), ida.caller), ("root:pt-a", Caller::Agent));
        assert_eq!((idb.tab.as_str(), idb.caller, idb.project.as_deref()), ("vm:pt-b", Caller::Reader, Some("p1")));
        revoke_tab("root:pt-a");
        assert!(caller(Some(&format!("Bearer {a}"))).is_none(), "a closed tab's token is refused");
        assert!(caller(Some(&format!("Bearer {b}"))).is_some());
        revoke_tab("vm:pt-b");
    }

    /// Codex prompts before any tool that does not say it is read-only, so the
    /// classification is listed here in full rather than derived from the name: a
    /// tool added without deciding which side it is on fails this test.
    #[test]
    fn every_tool_is_deliberately_classified() {
        const READ_ONLY: &[&str] = &[
            "proposals_list",
            "projects_list",
            "projects_git_status",
            "boxes_list",
            "calendar_list",
            "todo_list",
            "time_summary",
            "usage_recap",
            "sync_status",
            "mail_accounts_list",
            "mail_folders",
            "mail_search",
            "mail_read",
            "mail_thread",
            "mail_drafts_list",
        ];
        const DESTRUCTIVE: &[&str] = &[
            "calendar_update_event",
            "calendar_move_events",
            "calendar_delete_event",
            "todo_update",
            "todo_delete",
            "mail_draft_update",
            "mail_draft_delete",
        ];
        // The two classes between them list every tool.
        let mut tools = tool_definitions(Caller::Agent, true).as_array().unwrap().clone();
        for tool in tool_definitions(Caller::Reader, true).as_array().unwrap() {
            if !tools.iter().any(|t| t["name"] == tool["name"]) {
                tools.push(tool.clone());
            }
        }
        assert_eq!(tools.len(), tool_names().len());
        for tool in &tools {
            let name = tool["name"].as_str().unwrap();
            let hints = &tool["annotations"];
            assert_eq!(hints["readOnlyHint"], READ_ONLY.contains(&name), "{name}");
            if !READ_ONLY.contains(&name) {
                assert_eq!(hints["destructiveHint"], DESTRUCTIVE.contains(&name), "{name}");
            }
        }
        // Every listed tool is dispatched: a schema with no arm would be a tool
        // the agent can see and never call.
        let f = Fixture::new();
        for name in tool_names().into_iter().filter(|n| served(Caller::Agent, n)) {
            let (result, _) = f.call_fx(name, json!({}));
            let error = result["content"][0]["text"].as_str().unwrap_or_default();
            assert!(!error.starts_with("unknown tool"), "{name}");
        }
    }

    #[test]
    fn an_event_defaults_to_one_hour_and_rolls_midnight() {
        let f = Fixture::new();
        let (result, change) = f.call("calendar_add_event", json!({ "title": "Review", "start": "2026-09-18T23:30:00" }));
        assert_eq!(result["isError"], false);
        let row = text(&result);
        assert_eq!(row["start"], "2026-09-18T23:30");
        assert_eq!(row["end"], "2026-09-19T00:30");
        let change = change.into_iter().next().unwrap();
        assert_eq!((change.kind, change.op), ("event", "upsert"));
        assert_eq!(change.row["id"], row["id"]);

        let (listed, _) = f.call("calendar_list", json!({ "from": "2026-09-18", "to": "2026-09-19" }));
        assert_eq!(text(&listed)["events"].as_array().unwrap().len(), 1);
        let (listed, _) = f.call("calendar_list", json!({ "from": "2026-09-19" }));
        assert_eq!(text(&listed)["events"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn explicit_duration_all_day_and_bad_input() {
        let f = Fixture::new();
        let (r, _) = f.call("calendar_add_event", json!({ "title": "A", "start": "2026-09-18T09:00", "duration_minutes": 90 }));
        assert_eq!(text(&r)["end"], "2026-09-18T10:30");
        let (r, _) = f.call("calendar_add_event", json!({ "title": "B", "start": "2026-09-30", "all_day": true }));
        assert_eq!(text(&r)["end"], "2026-10-01");

        for bad in [
            json!({ "title": "x", "start": "tomorrow" }),
            json!({ "title": "x", "start": "2026-13-01T09:00" }),
            json!({ "title": "x", "start": "2026-09-18T09:00", "end": "2026-09-18T08:00" }),
            json!({ "title": "x", "start": "2026-09-18T09:00", "duration_minutes": 0 }),
            json!({ "start": "2026-09-18T09:00" }),
            json!({ "title": "x", "start": "2026-09-18T09:00", "calendar": "nope" }),
        ] {
            let (r, change) = f.call("calendar_add_event", bad.clone());
            assert_eq!(r["isError"], true, "{bad}");
            assert!(change.is_empty());
        }
    }

    #[test]
    fn deleting_an_event_hands_the_row_over() {
        let f = Fixture::new();
        let (r, _) = f.call("calendar_add_event", json!({ "title": "Gone", "start": "2026-09-18T09:00" }));
        let id = text(&r)["id"].as_str().unwrap().to_string();
        let (r, change) = f.call("calendar_delete_event", json!({ "id": id }));
        assert_eq!(r["isError"], false);
        let change = change.into_iter().next().unwrap();
        assert_eq!(change.op, "delete");
        assert_eq!(change.row["title"], "Gone");
        let (r, _) = f.call("calendar_delete_event", json!({ "id": id }));
        assert_eq!(r["isError"], true);
    }

    #[test]
    fn a_card_links_to_a_project_by_name_and_completes() {
        let f = Fixture::new();
        let (r, change) = f.call("todo_add", json!({ "title": "Ship", "project": "alpha", "due": "2026-09-20" }));
        assert_eq!(r["isError"], false);
        let card = text(&r);
        assert_eq!(card["project_id"], "p1");
        assert_eq!(change[0].kind, "task");

        let (r, _) = f.call("todo_list", json!({ "project": "Beta" }));
        assert_eq!(text(&r)["cards"].as_array().unwrap().len(), 0);
        let (r, _) = f.call("todo_add", json!({ "title": "x", "project": "Gamma" }));
        assert_eq!(r["isError"], true);

        let id = card["id"].as_str().unwrap();
        let (r, _) = f.call("todo_complete", json!({ "id": id, "completed_at": "2026-09-17T12:00" }));
        assert_eq!(text(&r)["completed"], "2026-09-17T12:00");
        let (r, _) = f.call("todo_list", json!({}));
        assert_eq!(text(&r)["cards"].as_array().unwrap().len(), 0);
    }

    fn add_card(f: &Fixture, title: &str) -> String {
        let (r, _) = f.call("todo_add", json!({ "title": title }));
        text(&r)["id"].as_str().unwrap().to_string()
    }

    fn column_id(f: &Fixture, pick: impl Fn(&Value) -> bool) -> String {
        let data: Value = crate::storage::read_json(&f.calendar).unwrap();
        let cols = data["task_columns"].as_array().unwrap();
        cols.iter().find(|c| pick(c)).unwrap()["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn a_card_is_edited_field_by_field_and_cleared_by_an_empty_string() {
        let f = Fixture::new();
        let (r, _) = f.call("todo_add", json!({ "title": "Draft", "notes": "n", "due": "2026-09-20", "project": "p1", "tags": ["a"] }));
        let id = text(&r)["id"].as_str().unwrap().to_string();

        let (r, change) = f.call("todo_update", json!({ "id": id, "title": "Final", "priority": 1, "tags": ["b", "c"] }));
        assert_eq!(r["isError"], false);
        let card = text(&r);
        assert_eq!(card["title"], "Final");
        assert_eq!(card["priority"], 1);
        assert_eq!(card["tags"], json!(["b", "c"]));
        // Untouched fields survive.
        assert_eq!((card["notes"].clone(), card["due"].clone(), card["project_id"].clone()), (json!("n"), json!("2026-09-20"), json!("p1")));
        assert_eq!((change[0].kind, change[0].op, change[0].local), ("task", "upsert", false));

        let (r, _) = f.call("todo_update", json!({ "id": id, "notes": "", "due": "", "project": "" }));
        let card = text(&r);
        assert!(card.get("notes").is_none() && card.get("due").is_none() && card.get("project_id").is_none());

        for bad in [
            json!({ "id": id, "title": " " }),
            json!({ "id": id, "due": "soon" }),
            json!({ "id": id, "priority": 12 }),
            json!({ "id": id, "project": "Gamma" }),
            json!({ "id": "nope", "title": "x" }),
        ] {
            let (r, change) = f.call("todo_update", bad.clone());
            assert_eq!(r["isError"], true, "{bad}");
            assert!(change.is_empty());
        }
        let (r, _) = f.call("todo_list", json!({}));
        assert_eq!(text(&r)["cards"][0]["title"], "Final", "a refused edit wrote nothing");
    }

    #[test]
    fn deleting_a_card_hands_the_row_over() {
        let f = Fixture::new();
        let id = add_card(&f, "Gone");
        let (r, change) = f.call("todo_delete", json!({ "id": id }));
        assert_eq!(text(&r)["deleted"], id.as_str());
        assert_eq!((change[0].kind, change[0].op), ("task", "delete"));
        assert_eq!(change[0].row["title"], "Gone");
        let (r, change) = f.call("todo_delete", json!({ "id": id }));
        assert_eq!(r["isError"], true);
        assert!(change.is_empty());
    }

    #[test]
    fn a_move_seeds_the_board_completes_into_done_and_reopens_out_of_it() {
        let f = Fixture::new();
        let (a, b) = (add_card(&f, "A"), add_card(&f, "B"));

        // The file has no board yet; the move creates it and the name resolves.
        let (r, change) = f.call("todo_move", json!({ "id": a, "column": "done", "completed_at": "2026-09-17T12:00" }));
        assert_eq!(r["isError"], false, "{r}");
        let done = column_id(&f, |c| c["done"] == true);
        let card = text(&r);
        assert_eq!((card["column"].as_str(), card["percent"].as_i64()), (Some(done.as_str()), Some(100)));
        assert_eq!(card["completed"], "2026-09-17T12:00");
        let moved = change.iter().find(|c| c.row["id"] == a.as_str()).unwrap();
        assert!(!moved.local, "a completion is something a server stores");

        // Reopen: out of done, no stamp left behind.
        let (r, _) = f.call("todo_reopen", json!({ "id": a }));
        let card = text(&r);
        assert_eq!(card["percent"], 0);
        assert!(card.get("completed").is_none());
        assert_ne!(card["column"], done.as_str());

        // A plain reorder is board-only, and a replay changes nothing.
        let home = text(&f.call("todo_list", json!({})).0)["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == b.as_str())
            .unwrap()["column"]
            .as_str()
            .unwrap()
            .to_string();
        let (r, change) = f.call("todo_move", json!({ "id": b, "column": home, "position": 0 }));
        assert_eq!(r["isError"], false);
        assert!(change.iter().all(|c| c.local));
        let (r, change) = f.call("todo_move", json!({ "id": b, "column": home, "position": 0 }));
        assert_eq!(text(&r)["id"], b.as_str());
        assert!(change.is_empty());

        // Moving out of done reopens, which is not board-only.
        f.call("todo_complete", json!({ "id": b }));
        let (r, change) = f.call("todo_move", json!({ "id": b, "column": home }));
        assert_eq!(text(&r)["percent"], 0);
        assert!(!change.iter().find(|c| c.row["id"] == b.as_str()).unwrap().local);

        for bad in [
            json!({ "id": b, "column": "nowhere" }),
            json!({ "id": "nope", "column": home }),
            json!({ "id": b, "column": home, "position": -1 }),
            json!({ "id": b }),
        ] {
            let (r, change) = f.call("todo_move", bad.clone());
            assert_eq!(r["isError"], true, "{bad}");
            assert!(change.is_empty());
        }
    }

    #[test]
    fn projects_list_reports_remoteness_and_hides_nothing_else() {
        let f = Fixture::new();
        let (r, _) = f.call("projects_list", json!({}));
        let projects = text(&r)["projects"].clone();
        assert_eq!(projects[0]["directory"], "/w/alpha");
        assert_eq!(projects[0]["remote"], false);
        assert_eq!(projects[1]["remote"], true);
    }

    // ── calendar_update_event ───────────────────────────────────────────────

    /// Add an event and hand back its id.
    fn add_event(f: &Fixture, args: Value) -> String {
        let (r, _) = f.call("calendar_add_event", args);
        assert_eq!(r["isError"], false, "{r}");
        text(&r)["id"].as_str().unwrap().to_string()
    }

    /// The point of the tool: "move it to 15:00" must not also resize it.
    #[test]
    fn moving_an_event_keeps_its_length() {
        let f = Fixture::new();
        let id = add_event(&f, json!({ "title": "Review", "start": "2026-09-18T09:00", "duration_minutes": 180 }));
        let (r, changes) = f.call("calendar_update_event", json!({ "id": id, "start": "2026-09-18T15:00" }));
        let row = text(&r);
        assert_eq!(row["start"], "2026-09-18T15:00");
        assert_eq!(row["end"], "2026-09-18T18:00", "three hours stay three hours");
        assert_eq!(row["title"], "Review");
        let change = changes.into_iter().next().unwrap();
        assert_eq!((change.kind, change.op, change.local), ("event", "upsert", false));
        assert_eq!(change.row["id"], id);

        // An explicit length still wins, in either spelling.
        let (r, _) = f.call("calendar_update_event", json!({ "id": id, "duration_minutes": 30 }));
        assert_eq!(text(&r)["end"], "2026-09-18T15:30");
        let (r, _) = f.call("calendar_update_event", json!({ "id": id, "end": "2026-09-18T16:00" }));
        assert_eq!(text(&r)["end"], "2026-09-18T16:00");
    }

    #[test]
    fn an_edit_touches_only_the_fields_it_is_given() {
        let f = Fixture::new();
        let id = add_event(&f, json!({
            "title": "Standup", "start": "2026-09-18T09:00", "location": "Room 2", "notes": "bring the plan"
        }));
        let (r, _) = f.call("calendar_update_event", json!({ "id": id, "title": "Standup (short)" }));
        let row = text(&r);
        assert_eq!(row["title"], "Standup (short)");
        assert_eq!(row["start"], "2026-09-18T09:00");
        assert_eq!(row["end"], "2026-09-18T10:00", "an untouched span is left byte for byte");
        assert_eq!(row["location"], "Room 2");
        // Present-but-empty clears, as in todo_update.
        let (r, _) = f.call("calendar_update_event", json!({ "id": id, "notes": "", "location": "Room 3" }));
        let row = text(&r);
        assert!(row["notes"].is_null(), "a cleared note is not serialized at all");
        assert_eq!(row["location"], "Room 3");
    }

    #[test]
    fn an_edit_can_turn_an_event_all_day_and_back() {
        let f = Fixture::new();
        let id = add_event(&f, json!({ "title": "Trip", "start": "2026-09-18", "end": "2026-09-21", "all_day": true }));
        // A moved all-day event keeps its three-day span.
        let (r, _) = f.call("calendar_update_event", json!({ "id": id, "start": "2026-09-25" }));
        let row = text(&r);
        assert_eq!((row["start"].as_str(), row["end"].as_str()), (Some("2026-09-25"), Some("2026-09-28")));
        assert_eq!(row["all_day"], true);
        // Turning it into a timed event needs an hour to put it at.
        let (r, changes) = f.call("calendar_update_event", json!({ "id": id, "all_day": false }));
        assert_eq!(r["isError"], true);
        assert!(changes.is_empty());
        let (r, _) = f.call("calendar_update_event", json!({ "id": id, "all_day": false, "start": "2026-09-25T10:00" }));
        let row = text(&r);
        assert_eq!(row["all_day"], false);
        assert_eq!((row["start"].as_str(), row["end"].as_str()), (Some("2026-09-25T10:00"), Some("2026-09-25T11:00")));
        // And back: an event becoming all-day covers the day it starts on.
        let (r, _) = f.call("calendar_update_event", json!({ "id": id, "all_day": true }));
        let row = text(&r);
        assert_eq!((row["start"].as_str(), row["end"].as_str()), (Some("2026-09-25"), Some("2026-09-26")));
    }

    #[test]
    fn an_edit_is_refused_where_it_could_not_be_pushed() {
        let f = Fixture::new();
        let id = add_event(&f, json!({ "title": "Talk", "start": "2026-09-18T09:00" }));
        for bad in [
            json!({ "id": "nope", "title": "x" }),
            json!({ "id": id, "title": "" }),
            json!({ "id": id, "start": "Friday" }),
            json!({ "id": id, "end": "2026-09-18T08:00" }),
            json!({ "id": id, "duration_minutes": 0 }),
            json!({ "id": id, "calendar": "nowhere" }),
            json!({}),
        ] {
            let (r, changes) = f.call("calendar_update_event", bad.clone());
            assert_eq!(r["isError"], true, "{bad}");
            assert!(changes.is_empty(), "{bad}");
        }

        // A calendar Eldrun may show but not write back to.
        let mut data = crate::commands::calendar::read_data(&f.calendar).unwrap();
        data.calendars.push(crate::schema::calendar::Calendar {
            id: "sub".into(),
            name: "Subscribed".into(),
            readonly: true,
            ..crate::schema::calendar::Calendar::default_calendar()
        });
        if let Some(event) = data.events.iter_mut().find(|e| e.id == id) {
            event.calendar_id = "sub".into();
        }
        std::fs::write(&f.calendar, serde_json::to_string(&data).unwrap()).unwrap();
        let (r, changes) = f.call("calendar_update_event", json!({ "id": id, "title": "Moved" }));
        assert_eq!(r["isError"], true);
        assert!(r["content"][0]["text"].as_str().unwrap().contains("read-only"));
        assert!(changes.is_empty());
    }

    #[test]
    fn a_calendar_is_created_once_per_name_in_the_palette() {
        let f = Fixture::new();
        let (r, changes) = f.call("calendar_create", json!({ "name": "Work" }));
        assert_eq!(r["isError"], false, "{r}");
        let row = text(&r);
        assert_eq!(row["name"], "Work");
        // The default calendar is the first; the next palette colour is ours.
        assert_eq!(row["color"], CALENDAR_COLORS[1]);
        assert_eq!(row["visible"], true);
        let change = changes.into_iter().next().unwrap();
        assert_eq!((change.kind, change.op, change.local), ("calendar", "upsert", true));
        // Reachable by name from then on.
        add_event(&f, json!({ "title": "Sprint", "start": "2026-09-18T09:00", "calendar": "work" }));

        let (r, _) = f.call("calendar_create", json!({ "name": "Garden", "color": "#A0B0C0" }));
        assert_eq!(text(&r)["color"], "#a0b0c0");
        for bad in [
            json!({ "name": "WORK" }),
            json!({ "name": "  " }),
            json!({ "name": "Red", "color": "red" }),
            json!({ "name": "Red", "color": "#abc" }),
        ] {
            let (r, changes) = f.call("calendar_create", bad.clone());
            assert_eq!(r["isError"], true, "{bad}");
            assert!(changes.is_empty(), "{bad}");
        }
        let (listed, _) = f.call("calendar_list", json!({}));
        assert_eq!(text(&listed)["calendars"].as_array().unwrap().len(), 3);
    }

    /// Give an event the address a CalDAV sync would have left on it.
    fn mark_synced(f: &Fixture, id: &str, href: &str) {
        let mut data = crate::commands::calendar::read_data(&f.calendar).unwrap();
        let event = data.events.iter_mut().find(|e| e.id == id).unwrap();
        event.extra.insert("caldav_href".into(), json!(href));
        event.extra.insert("caldav_etag".into(), json!("\"e1\""));
        std::fs::write(&f.calendar, serde_json::to_string(&data).unwrap()).unwrap();
    }

    #[test]
    fn events_move_between_calendars_by_id_or_all_at_once() {
        let f = Fixture::new();
        f.call("calendar_create", json!({ "name": "Work" }));
        f.call("calendar_create", json!({ "name": "Archive" }));
        let a = add_event(&f, json!({ "title": "A", "start": "2026-09-18T09:00", "duration_minutes": 90 }));
        let b = add_event(&f, json!({ "title": "B", "start": "2026-09-19T09:00" }));

        let (r, changes) = f.call("calendar_move_events", json!({ "ids": [a, a], "to": "Work" }));
        assert_eq!(r["isError"], false, "{r}");
        assert_eq!(text(&r)["moved"], json!([a]), "a repeated id moves once");
        let [change] = changes.as_slice() else { panic!("one row: {changes:?}") };
        assert_eq!((change.kind, change.op, change.local), ("event", "upsert", false));
        assert_eq!(change.row["id"], a, "a move keeps the event's identity");
        assert_eq!(change.row["end"], "2026-09-18T10:30", "and its times");
        let work = change.row["calendar_id"].clone();
        assert_ne!(work, "default");

        // Already there: nothing to do, nothing reported.
        let (r, changes) = f.call("calendar_move_events", json!({ "ids": [a], "to": "Work" }));
        assert_eq!(text(&r)["moved"], json!([]));
        assert!(changes.is_empty());

        // `from` empties a calendar.
        let (r, changes) = f.call("calendar_move_events", json!({ "from": "Personal", "to": "Archive" }));
        assert_eq!(text(&r)["moved"], json!([b]));
        assert_eq!(changes.len(), 1);
        let (listed, _) = f.call("calendar_list", json!({}));
        let events = text(&listed)["events"].clone();
        let calendar_of = |id: &str| {
            events.as_array().unwrap().iter().find(|e| e["id"] == id).unwrap()["calendar_id"].clone()
        };
        assert_eq!(calendar_of(&a), work);
        assert_ne!(calendar_of(&b), work);
    }

    #[test]
    fn a_move_is_all_or_nothing_and_refused_where_it_could_not_be_pushed() {
        let f = Fixture::new();
        f.call("calendar_create", json!({ "name": "Work" }));
        let a = add_event(&f, json!({ "title": "A", "start": "2026-09-18T09:00" }));
        for bad in [
            json!({ "ids": [a, "nope"], "to": "Work" }),
            json!({ "ids": [a], "to": "nowhere" }),
            json!({ "ids": [a], "from": "Personal", "to": "Work" }),
            json!({ "ids": [], "to": "Work" }),
            json!({ "ids": "a", "to": "Work" }),
            json!({ "to": "Work" }),
            json!({ "ids": [a] }),
        ] {
            let (r, changes) = f.call("calendar_move_events", bad.clone());
            assert_eq!(r["isError"], true, "{bad}");
            assert!(changes.is_empty(), "{bad}");
        }
        let (listed, _) = f.call("calendar_list", json!({}));
        assert_eq!(text(&listed)["events"][0]["calendar_id"], "default", "the good id did not move either");

        // Neither into nor out of a calendar Eldrun may not write back to.
        let mut data = crate::commands::calendar::read_data(&f.calendar).unwrap();
        data.calendars.push(crate::schema::calendar::Calendar {
            id: "sub".into(),
            name: "Subscribed".into(),
            readonly: true,
            ..crate::schema::calendar::Calendar::default_calendar()
        });
        std::fs::write(&f.calendar, serde_json::to_string(&data).unwrap()).unwrap();
        let (r, _) = f.call("calendar_move_events", json!({ "ids": [a], "to": "Subscribed" }));
        assert!(r["content"][0]["text"].as_str().unwrap().contains("read-only"));
        let mut data = crate::commands::calendar::read_data(&f.calendar).unwrap();
        data.events[0].calendar_id = "sub".into();
        std::fs::write(&f.calendar, serde_json::to_string(&data).unwrap()).unwrap();
        let (r, changes) = f.call("calendar_move_events", json!({ "ids": [a], "to": "Work" }));
        assert!(r["content"][0]["text"].as_str().unwrap().contains("read-only"));
        assert!(changes.is_empty());
    }

    /// A synced row is a resource in its old collection: the move must retire
    /// that copy and hand the new calendar a row with no address to `PUT` to.
    #[test]
    fn moving_a_synced_event_deletes_the_server_copy_first() {
        let f = Fixture::new();
        f.call("calendar_create", json!({ "name": "Work" }));
        let a = add_event(&f, json!({ "title": "A", "start": "2026-09-18T09:00" }));
        mark_synced(&f, &a, "/cal/personal/a.ics");

        let (_, changes) = f.call("calendar_move_events", json!({ "ids": [a], "to": "Work" }));
        let [delete, upsert] = changes.as_slice() else { panic!("two rows: {changes:?}") };
        assert_eq!((delete.kind, delete.op), ("event", "delete"));
        assert_eq!(delete.row["calendar_id"], "default", "addressed in the calendar it left");
        assert_eq!(delete.row["caldav_href"], "/cal/personal/a.ics");
        assert_eq!(delete.row["caldav_etag"], "\"e1\"");
        assert_eq!(upsert.op, "upsert");
        assert_ne!(upsert.row["calendar_id"], "default");
        assert!(upsert.row.get("caldav_href").is_none(), "{}", upsert.row);
        assert!(upsert.row.get("caldav_etag").is_none());
        let stored = crate::commands::calendar::read_data(&f.calendar).unwrap();
        assert!(!stored.events[0].extra.contains_key("caldav_href"), "and on disk");

        // `calendar_update_event`'s `calendar` is the same move.
        let b = add_event(&f, json!({ "title": "B", "start": "2026-09-19T09:00" }));
        mark_synced(&f, &b, "/cal/personal/b.ics");
        let (r, changes) = f.call("calendar_update_event", json!({ "id": b, "calendar": "Work", "title": "B2" }));
        assert_eq!(text(&r)["title"], "B2");
        let ops: Vec<_> = changes.iter().map(|c| c.op).collect();
        assert_eq!(ops, ["delete", "upsert"]);
        assert!(changes[1].row.get("caldav_href").is_none());
        // An edit that does not move keeps the address and deletes nothing.
        let c = add_event(&f, json!({ "title": "C", "start": "2026-09-20T09:00" }));
        mark_synced(&f, &c, "/cal/personal/c.ics");
        let (_, changes) = f.call("calendar_update_event", json!({ "id": c, "calendar": "Personal", "title": "C2" }));
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].row["caldav_href"], "/cal/personal/c.ics");
    }

    #[test]
    fn a_synced_series_with_server_overrides_does_not_move_in_pieces() {
        let f = Fixture::new();
        f.call("calendar_create", json!({ "name": "Work" }));
        let master = add_event(&f, json!({ "title": "Weekly", "start": "2026-09-18T09:00" }));
        let moved = add_event(&f, json!({ "title": "Weekly (moved)", "start": "2026-09-25T10:00" }));
        mark_synced(&f, &master, "/cal/personal/weekly.ics");
        mark_synced(&f, &moved, "/cal/personal/weekly.ics");
        let (r, changes) = f.call("calendar_move_events", json!({ "ids": [master], "to": "Work" }));
        assert_eq!(r["isError"], true);
        assert!(r["content"][0]["text"].as_str().unwrap().contains("recurring series"));
        assert!(changes.is_empty());
    }

    // ── The read-only sweeps ────────────────────────────────────────────────

    #[test]
    fn time_summary_ranges_by_day_and_keeps_the_app_out_of_the_projects() {
        let f = Fixture::new();
        f.write_state(
            "time_summary.json",
            json!({ "version": 1, "migrated": true, "days": {
                "2026-09-15": { "p1": 3600.0, "__eldrun__": 60.0 },
                "2026-09-16": { "p1": 1800.0, "p2": 7200.0 },
                "2026-09-17": { "p1": 900.0 },
            }}),
        );
        let (r, _) = f.call("time_summary", json!({ "from": "2026-09-15", "to": "2026-09-17" }));
        let out = text(&r);
        assert_eq!(out["total_seconds"], 3600 + 1800 + 7200);
        assert_eq!(out["app_seconds"], 60, "Eldrun's own window time is never a project's");
        // Sorted by time spent, and named.
        assert_eq!(out["projects"][0]["id"], "p2");
        assert_eq!(out["projects"][0]["name"], "Beta");
        assert_eq!(out["projects"][1]["seconds"], 5400);
        assert_eq!(out["days"].as_array().unwrap().len(), 2, "`to` is exclusive");
        assert_eq!(out["days"][0]["date"], "2026-09-15");

        let (r, _) = f.call("time_summary", json!({ "project": "Alpha" }));
        let out = text(&r);
        assert_eq!(out["total_seconds"], 6300);
        assert_eq!(out["projects"].as_array().unwrap().len(), 1);
        assert_eq!(f.call("time_summary", json!({ "from": "nope" })).0["isError"], true);
    }

    #[test]
    fn usage_recap_totals_and_breaks_down_only_when_asked() {
        let f = Fixture::new();
        f.write_state(
            "usage_stats.json",
            json!({ "version": 1, "hours": {}, "days": {
                "2026-09-16": { "p1": { "agent.prompt.claude": 3, "shell.command": 10 }, "p2": { "agent.prompt.claude": 4 } },
                "2026-09-17": { "p1": { "agent.prompt.claude": 1 } },
            }}),
        );
        let (r, _) = f.call("usage_recap", json!({}));
        let out = text(&r);
        assert_eq!(out["totals"]["agent.prompt.claude"], 8);
        assert_eq!(out["totals"]["shell.command"], 10);
        assert_eq!(out["days_counted"], 2);
        assert!(out["projects"].is_null(), "the breakdown is opt-in");

        let (r, _) = f.call("usage_recap", json!({ "by_project": true, "to": "2026-09-17" }));
        let out = text(&r);
        assert_eq!(out["totals"]["agent.prompt.claude"], 7);
        assert_eq!(out["projects"][0]["id"], "p1", "the busiest project leads");
        assert_eq!(out["projects"][0]["counters"]["shell.command"], 10);
        assert_eq!(out["projects"][1]["name"], "Beta");

        // Naming a project is asking for its own numbers.
        let (r, _) = f.call("usage_recap", json!({ "project": "p2" }));
        let out = text(&r);
        assert_eq!(out["totals"]["agent.prompt.claude"], 4);
        assert_eq!(out["projects"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn boxes_list_names_its_members() {
        let f = Fixture::new();
        f.write_state(
            "boxes.json",
            json!([
                { "id": "b2", "name": "Later", "member_ids": ["p2"], "position": 20 },
                { "id": "b1", "name": "Thesis", "member_ids": ["p1", "p2", "gone"], "position": 10,
                  "folder": "/home/u/eldrun/boxes/thesis",
                  "relations": [{ "source": "p1", "target": "p2", "kind": "python-lib" }] },
            ]),
        );
        let (r, _) = f.call("boxes_list", json!({}));
        let boxes = text(&r)["boxes"].clone();
        assert_eq!(boxes[0]["name"], "Thesis", "ordered by position, not by file order");
        assert_eq!(boxes[0]["members"][0]["name"], "Alpha");
        // A member whose project is gone keeps its id rather than vanishing.
        assert_eq!(boxes[0]["members"][2]["name"], "gone");
        assert_eq!(boxes[0]["relations"][0]["source"], "Alpha");
        assert_eq!(boxes[0]["folder"], "/home/u/eldrun/boxes/thesis");
        assert!(boxes[1]["folder"].is_null());

        let (r, _) = f.call("boxes_list", json!({ "project": "Alpha" }));
        let boxes = text(&r)["boxes"].clone();
        assert_eq!(boxes.as_array().unwrap().len(), 1);
        assert_eq!(boxes[0]["id"], "b1");
        assert_eq!(f.call("boxes_list", json!({ "project": "nope" })).0["isError"], true);
    }

    #[test]
    fn a_branch_header_is_read_in_every_shape_git_writes_it() {
        let cases = [
            ("## main", (Some("main"), None, 0, 0)),
            ("## main...origin/main", (Some("main"), Some("origin/main"), 0, 0)),
            ("## main...origin/main [ahead 2]", (Some("main"), Some("origin/main"), 2, 0)),
            ("## main...origin/main [behind 3]", (Some("main"), Some("origin/main"), 0, 3)),
            ("## dev...origin/dev [ahead 1, behind 2]", (Some("dev"), Some("origin/dev"), 1, 2)),
            ("## main...origin/main [gone]", (Some("main"), Some("origin/main"), 0, 0)),
            ("## No commits yet on main", (Some("main"), None, 0, 0)),
            ("## HEAD (no branch)", (None, None, 0, 0)),
        ];
        for (line, want) in cases {
            let (branch, upstream, ahead, behind) = parse_branch_header(line.trim_start_matches("## "));
            let got = (branch.as_deref(), upstream.as_deref(), ahead, behind);
            assert_eq!(got, want, "{line}");
        }
    }

    #[test]
    fn porcelain_counts_split_staged_unstaged_and_untracked() {
        let snap = parse_porcelain(
            "## dev...origin/dev [ahead 1]\nM  staged.rs\n M unstaged.rs\nMM both.rs\n?? new.rs\nR  old.rs -> new_name.rs\n",
        );
        assert_eq!(snap.branch.as_deref(), Some("dev"));
        assert_eq!(snap.ahead, 1);
        assert_eq!((snap.staged, snap.unstaged, snap.untracked), (3, 2, 1));
    }

    /// A real repo, because the point of the tool is the answer about a folder.
    #[test]
    fn the_git_sweep_reads_local_copies_and_says_why_it_skipped_the_rest() {
        if !crate::commands::git::git_available() {
            return; // Reported honestly by the tool itself; nothing to test here.
        }
        let f = Fixture::new();
        let repo = f.dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if !git(&["init", "-q", "-b", "main"]) {
            return; // A git too old for `init -b`; the parser tests still hold.
        }
        git(&["config", "user.email", "t@example.invalid"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(repo.join("a.txt"), "one").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-qm", "first"]);
        std::fs::write(repo.join("a.txt"), "two").unwrap();
        std::fs::write(repo.join("b.txt"), "new").unwrap();

        let plain = f.dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(
            &f.projects,
            json!([
                { "id": "p1", "name": "Alpha", "status": "active", "position": 0, "local_file": "", "directory": repo.to_str().unwrap() },
                { "id": "p2", "name": "Beta", "status": "active", "position": 1, "local_file": "", "remote": { "host": "h" } },
                { "id": "p3", "name": "Gamma", "status": "active", "position": 2, "local_file": "", "directory": plain.to_str().unwrap() },
                { "id": "p4", "name": "Delta", "status": "active", "position": 3, "local_file": "", "directory": "/nope/gone" },
            ])
            .to_string(),
        )
        .unwrap();

        let (r, changes) = f.call("projects_git_status", json!({}));
        assert_eq!(r["isError"], false, "{r}");
        assert!(changes.is_empty(), "a sweep writes nothing");
        let out = text(&r);
        let row = &out["projects"][0];
        assert_eq!(row["id"], "p1");
        assert_eq!(row["source"], "project");
        assert_eq!(row["branch"], "main");
        assert!(row["upstream"].is_null());
        assert_eq!((row["unstaged"].as_u64(), row["untracked"].as_u64()), (Some(1), Some(1)));
        assert_eq!(row["clean"], false);
        assert_eq!(out["projects"].as_array().unwrap().len(), 1);

        let reasons: HashMap<&str, &str> = out["skipped"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (s["id"].as_str().unwrap(), s["reason"].as_str().unwrap()))
            .collect();
        assert!(reasons["p2"].contains("no local mirror"), "never over SSH: {:?}", reasons["p2"]);
        assert_eq!(reasons["p3"], "not a git repository");
        assert!(reasons["p4"].starts_with("folder is missing"));

        // `dirty_only` keeps a sweep over many projects short.
        git(&["checkout", "-q", "--", "a.txt"]);
        std::fs::remove_file(repo.join("b.txt")).unwrap();
        let (r, _) = f.call("projects_git_status", json!({ "dirty_only": true }));
        assert!(text(&r)["projects"].as_array().unwrap().is_empty());
        let (r, _) = f.call("projects_git_status", json!({ "project": "Alpha" }));
        assert_eq!(text(&r)["projects"][0]["clean"], true);
    }

    #[test]
    fn sync_status_reports_the_last_pass_and_the_unseen_warnings() {
        let f = Fixture::new();
        f.write_remote_state(
            "p2",
            "git_peer.json",
            json!({
                "enabled": true,
                "status": "desynchronized",
                "detail": "both sides moved",
                "localHead": { "kind": "branch", "name": "main", "sha": "abcdef1234567890" },
                "remoteHead": { "kind": "detached", "sha": "0123456789abcdef" },
                "lastSyncTs": 1_789_603_200,
            }),
        );
        f.write_remote_state(
            "p2",
            "sync.json",
            json!({
                "data/big.csv": { "selected": true, "is_dir": false, "last_pull_ts": 1_789_500_000, "auto_sync": true },
                "data": { "selected": true, "is_dir": true },
                "scratch": { "selected": false, "is_dir": true, "excluded": true },
            }),
        );
        f.write_remote_state(
            "p2",
            "local_loss.json",
            json!([
                { "ts": 1_789_600_000, "source": "git", "kind": "deleted", "op": "fast-forward from the host",
                  "paths": ["a.rs", "b.rs"], "total": 2, "recovery": "git checkout HEAD@{1}", "acked": false },
                { "ts": 1_789_000_000, "source": "sync", "kind": "overwritten", "op": "manual pull",
                  "paths": ["notes.md"], "total": 1, "recovery": null, "acked": true },
            ]),
        );

        let (r, changes) = f.call("sync_status", json!({}));
        assert!(changes.is_empty());
        let out = text(&r);
        assert_eq!(out["local_projects_skipped"], 1, "a local project has no host to be in step with");
        let row = &out["remote_projects"][0];
        assert_eq!((row["id"].as_str(), row["host"].as_str()), (Some("p2"), Some("h")));
        assert_eq!(row["lockstep"]["status"], "desynchronized");
        assert_eq!(row["lockstep"]["local_head"], "main @ abcdef12");
        assert_eq!(row["lockstep"]["remote_head"], "detached @ 01234567");
        assert_eq!(row["lockstep"]["last_pass"], "2026-09-17T00:00:00Z");
        assert_eq!(row["lockstep"]["blocked_by_pairing_conflict"], false);
        assert_eq!(row["byte_sync"]["tracked_files"], 1);
        assert_eq!(row["byte_sync"]["tracked_folders"], 1);
        assert_eq!(row["byte_sync"]["auto_paths"], 1);
        assert_eq!(row["byte_sync"]["excluded_paths"], 1);
        assert!(row["byte_sync"]["last_push"].is_null(), "never pushed is not 1970");
        let warnings = row["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 1, "an acknowledged warning is not raised again");
        assert_eq!(warnings[0]["source"], "git");
        assert_eq!(warnings[0]["kind"], "deleted");
        assert_eq!(warnings[0]["total"], 2);

        let (r, _) = f.call("sync_status", json!({ "include_acked": true }));
        assert_eq!(text(&r)["remote_projects"][0]["warnings"].as_array().unwrap().len(), 2);

        // A remote project with no recorded state is still listed, at its defaults.
        let f = Fixture::new();
        let (r, _) = f.call("sync_status", json!({ "project": "Beta" }));
        let row = text(&r)["remote_projects"][0].clone();
        assert_eq!(row["lockstep"]["enabled"], false);
        assert_eq!(row["byte_sync"]["tracked_files"], 0);
        assert!(row["warnings"].as_array().unwrap().is_empty());
    }
}
