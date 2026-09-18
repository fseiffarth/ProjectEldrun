//! One language server per consented project: handshake, document sync,
//! completion, feedback and teardown. Transport-generic so tests drive a duplex
//! instead of a process. Tokens and protocol payloads never leave this module:
//! callers see opaque candidate ids, a device code and coarse error codes.
use super::documents::{DocumentTicket, Documents, Position};
use super::process::ManagedProcess;
use super::rpc::{RpcClient, RpcError};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex as AsyncMutex;

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(30);
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(15);
const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(30);
/// The device flow waits for the user's browser; GitHub expires the code itself.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_ITEMS: usize = 8;
const MAX_STARTS: usize = 3;
const START_WINDOW: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The server's own `didChangeStatus` kind (Normal/Warning/Error/Inactive).
    pub kind: String,
    /// Account, quota and billing text is the server's to word; shown verbatim.
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub user_code: String,
    pub verification_uri: String,
}

pub struct CompletionRequest<'a> {
    pub uri: &'a str,
    pub editor: &'a str,
    pub client_version: u64,
    pub text: &'a str,
    pub language: &'a str,
    pub position: Position,
    pub automatic: bool,
    pub tab_size: u32,
    pub insert_spaces: bool,
}

pub fn error_code(error: RpcError) -> String {
    match error {
        RpcError::Server(1000) => "copilot_not_signed_in",
        RpcError::Cancelled | RpcError::Server(-32800) => "copilot_cancelled",
        RpcError::Timeout => "copilot_timeout",
        RpcError::Closed | RpcError::InvalidFrame => "copilot_server_closed",
        RpcError::Server(_) => "copilot_server_error",
    }
    .into()
}

/// The caret must name a real UTF-16 boundary of the text being synchronized;
/// a position past a line's end would let the server complete unrelated text.
fn position_in(text: &str, position: Position) -> bool {
    let Some(line) = text.split('\n').nth(position.line as usize) else {
        return false;
    };
    let line = line.strip_suffix('\r').unwrap_or(line);
    let mut units = 0u32;
    if position.character == 0 {
        return true;
    }
    for char in line.chars() {
        units += char.len_utf16() as u32;
        if units == position.character {
            return true;
        }
        if units > position.character {
            return false;
        }
    }
    false
}

struct Offer {
    editor: String,
    ticket: DocumentTicket,
    item: Value,
}

pub struct Session {
    rpc: Arc<RpcClient>,
    root: PathBuf,
    documents: AsyncMutex<Documents>,
    inflight: Mutex<HashMap<String, u64>>,
    offers: Mutex<HashMap<String, Offer>>,
    status: Arc<Mutex<Status>>,
    pending_sign_in: Mutex<Option<Value>>,
    process: Option<ManagedProcess>,
    events: tokio::task::JoinHandle<()>,
}

impl Session {
    pub async fn start<R, W>(
        reader: R,
        writer: W,
        process: Option<ManagedProcess>,
        root: &Path,
    ) -> Result<Self, String>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (rpc, mut receive) = RpcClient::connect(reader, writer);
        let rpc = Arc::new(rpc);
        let status = Arc::new(Mutex::new(Status::default()));
        let (replies, seen) = (rpc.clone(), status.clone());
        let events = tokio::spawn(async move {
            while let Some(message) = receive.recv().await {
                let method = message.get("method").and_then(Value::as_str).unwrap_or("");
                let params = message.get("params");
                if method == "didChangeStatus" {
                    let text = |key: &str| params.and_then(|p| p.get(key)).and_then(Value::as_str);
                    *seen.lock().unwrap() = Status {
                        kind: text("kind").unwrap_or("").chars().take(32).collect(),
                        message: text("message").map(|m| m.chars().take(500).collect()),
                    };
                }
                // The server blocks on its own requests. Answer every one, and
                // grant nothing: no editor settings, no opening documents.
                if let Some(id) = message.get("id").cloned() {
                    let result = match method {
                        "workspace/configuration" => {
                            let items = params.and_then(|p| p.get("items")).and_then(Value::as_array);
                            json!(vec![Value::Null; items.map_or(0, Vec::len)])
                        }
                        "window/showDocument" => json!({"success": false}),
                        _ => Value::Null,
                    };
                    if replies.reply(id, result).await.is_err() {
                        break;
                    }
                }
            }
        });
        let session = Self {
            rpc,
            root: root.to_owned(),
            documents: AsyncMutex::default(),
            inflight: Mutex::default(),
            offers: Mutex::default(),
            status,
            pending_sign_in: Mutex::default(),
            process,
            events,
        };
        let uri = url::Url::from_directory_path(root).map_err(|_| "copilot_invalid_project")?;
        let version = env!("CARGO_PKG_VERSION");
        session
            .request("initialize", json!({
                "processId": std::process::id(),
                "workspaceFolders": [{"uri": uri.as_str(), "name": "project"}],
                "capabilities": {"workspace": {"workspaceFolders": true}},
                "initializationOptions": {
                    "editorInfo": {"name": "Eldrun", "version": version},
                    "editorPluginInfo": {"name": "Eldrun autocomplete", "version": version},
                },
            }), INITIALIZE_TIMEOUT)
            .await?;
        session.notify("initialized", json!({})).await?;
        session
            .notify("workspace/didChangeConfiguration", json!({
                "settings": {"telemetry": {"telemetryLevel": "off"}},
            }))
            .await?;
        Ok(session)
    }

    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.rpc.next_id();
        self.rpc.request(id, method, params, timeout).await.map_err(error_code)
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.rpc.notify(method, params).await.map_err(error_code)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn alive(&self) -> bool {
        !self.rpc.is_closed() && self.process.as_ref().is_none_or(ManagedProcess::alive)
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    /// Returns `{id, insertText, range}` per candidate. The untouched server
    /// item stays here, keyed by that id, for shown/accepted feedback.
    pub async fn complete(&self, request: CompletionRequest<'_>) -> Result<Vec<Value>, String> {
        if !position_in(request.text, request.position) {
            return Err("copilot_invalid_position".into());
        }
        let (ticket, id) = {
            // Hold the lock across the writes: two editors' notifications must
            // reach the server in the order their versions were allocated.
            let mut documents = self.documents.lock().await;
            let (ticket, notifications) = documents.synchronize(
                request.uri, request.editor, request.client_version, request.text, request.language)?;
            for (method, params) in notifications {
                self.notify(method, params).await?;
            }
            (ticket, self.rpc.next_id())
        };
        let previous = self.inflight.lock().unwrap().insert(request.editor.to_owned(), id);
        if let Some(previous) = previous {
            let _ = self.rpc.cancel(previous).await;
        }
        self.offers.lock().unwrap().retain(|_, offer| offer.editor != request.editor);
        let reply = self.rpc.request(id, "textDocument/inlineCompletion", json!({
            "textDocument": {"uri": ticket.uri, "version": ticket.server_version},
            "position": request.position,
            "context": {"triggerKind": if request.automatic { 2 } else { 1 }},
            "formattingOptions": {"tabSize": request.tab_size, "insertSpaces": request.insert_spaces},
        }), COMPLETION_TIMEOUT).await;
        {
            let mut inflight = self.inflight.lock().unwrap();
            if inflight.get(request.editor) == Some(&id) {
                inflight.remove(request.editor);
            }
        }
        let reply = reply.map_err(error_code)?;
        if !self.documents.lock().await.current(&ticket) {
            return Err("copilot_stale_document".into());
        }
        let items = reply.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut offers = self.offers.lock().unwrap();
        Ok(items.into_iter().take(MAX_ITEMS).enumerate().filter_map(|(index, item)| {
            let text = item.get("insertText")?.as_str()?.to_owned();
            let candidate = format!("{id}:{index}");
            let result = json!({"id": candidate, "insertText": text, "range": item.get("range")});
            offers.insert(candidate, Offer { editor: request.editor.to_owned(), ticket: ticket.clone(), item });
            Some(result)
        }).collect())
    }

    pub async fn cancel(&self, editor: &str) {
        let id = self.inflight.lock().unwrap().remove(editor);
        if let Some(id) = id {
            let _ = self.rpc.cancel(id).await;
        }
    }

    /// Hidden pane, closed tab, provider change: the server forgets the text.
    pub async fn close_editor(&self, editor: &str) {
        self.cancel(editor).await;
        self.offers.lock().unwrap().retain(|_, offer| offer.editor != editor);
        let closed = self.documents.lock().await.close_editor(editor);
        for params in closed {
            let _ = self.notify("textDocument/didClose", params).await;
        }
    }

    async fn offered(&self, editor: &str, candidate: &str) -> Option<Value> {
        let (ticket, item) = {
            let offers = self.offers.lock().unwrap();
            let offer = offers.get(candidate).filter(|offer| offer.editor == editor)?;
            (offer.ticket.clone(), offer.item.clone())
        };
        self.documents.lock().await.current(&ticket).then_some(item)
    }

    pub async fn shown(&self, editor: &str, candidate: &str) -> Result<(), String> {
        let Some(item) = self.offered(editor, candidate).await else { return Ok(()); };
        self.notify("textDocument/didShowCompletion", json!({"item": item})).await
    }

    /// `accepted_length` counts UTF-16 units of the original `insertText`;
    /// `None` is the full acceptance, reported once through the item's command.
    pub async fn accepted(&self, editor: &str, candidate: &str, accepted_length: Option<u32>) -> Result<(), String> {
        let Some(item) = self.offered(editor, candidate).await else { return Ok(()); };
        if let Some(accepted_length) = accepted_length {
            return self.notify("textDocument/didPartiallyAcceptCompletion",
                json!({"item": item, "acceptedLength": accepted_length})).await;
        }
        self.offers.lock().unwrap().remove(candidate);
        let Some(command) = item.get("command") else { return Ok(()); };
        self.request("workspace/executeCommand", json!({
            "command": command.get("command"), "arguments": command.get("arguments"),
        }), ACCOUNT_TIMEOUT).await.map(|_| ())
    }

    pub async fn account(&self) -> Result<Value, String> {
        let reply = self.request("checkStatus", json!({}), ACCOUNT_TIMEOUT).await?;
        Ok(json!({"status": reply.get("status"), "user": reply.get("user")}))
    }

    /// Step one of the device flow. The finishing command stays in the backend.
    pub async fn sign_in(&self) -> Result<Option<DeviceCode>, String> {
        let reply = self.request("signIn", json!({}), ACCOUNT_TIMEOUT).await?;
        let text = |key: &str| reply.get(key).and_then(Value::as_str).map(str::to_owned);
        let (Some(user_code), Some(verification_uri)) = (text("userCode"), text("verificationUri")) else {
            return Ok(None); // already signed in
        };
        if !verification_uri.starts_with("https://github.com/") {
            return Err("copilot_server_error".into());
        }
        *self.pending_sign_in.lock().unwrap() = reply.get("command").cloned();
        Ok(Some(DeviceCode { user_code, verification_uri }))
    }

    /// Step two: resolves once the user approved the code in their browser.
    pub async fn finish_sign_in(&self) -> Result<(), String> {
        let command = self.pending_sign_in.lock().unwrap().take().ok_or("copilot_no_sign_in")?;
        self.request("workspace/executeCommand", json!({
            "command": command.get("command"), "arguments": command.get("arguments"),
        }), SIGN_IN_TIMEOUT).await.map(|_| ())
    }

    pub async fn sign_out(&self) -> Result<(), String> {
        self.request("signOut", json!({}), ACCOUNT_TIMEOUT).await.map(|_| ())
    }

    pub fn stop(&self) {
        self.rpc.close();
        self.events.abort();
        if let Some(process) = &self.process {
            process.stop();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Project id → running session. Revoked consent and app exit stop processes
/// here; a server that keeps dying is not restarted forever.
#[derive(Default)]
pub struct Sessions {
    entries: AsyncMutex<HashMap<String, Arc<Session>>>,
    starts: Mutex<HashMap<String, VecDeque<Instant>>>,
}

pub fn sessions() -> &'static Sessions {
    static SESSIONS: OnceLock<Sessions> = OnceLock::new();
    SESSIONS.get_or_init(Sessions::default)
}

impl Sessions {
    fn allow_start(&self, project_id: &str, now: Instant) -> bool {
        let mut starts = self.starts.lock().unwrap();
        let recent = starts.entry(project_id.to_owned()).or_default();
        while recent.front().is_some_and(|at| now.duration_since(*at) > START_WINDOW) {
            recent.pop_front();
        }
        if recent.len() >= MAX_STARTS {
            return false;
        }
        recent.push_back(now);
        true
    }

    /// `root` is the directory `policy::authorize_project` just returned.
    pub async fn get_or_start(&self, project_id: &str, root: &Path) -> Result<Arc<Session>, String> {
        let mut entries = self.entries.lock().await;
        if let Some(session) = entries.get(project_id) {
            if session.alive() && session.root() == root {
                return Ok(session.clone());
            }
            session.stop();
            entries.remove(project_id);
        }
        if !self.allow_start(project_id, Instant::now()) {
            return Err("copilot_restart_limit".into());
        }
        let (process, output, input) = ManagedProcess::launch(root)?;
        let session = Arc::new(Session::start(output, input, Some(process), root).await?);
        entries.insert(project_id.to_owned(), session.clone());
        Ok(session)
    }

    pub async fn existing(&self, project_id: &str) -> Option<Arc<Session>> {
        self.entries.lock().await.get(project_id).cloned()
    }

    /// Consent withdrawn, provider changed, project closed or made remote.
    pub async fn stop(&self, project_id: &str) {
        if let Some(session) = self.entries.lock().await.remove(project_id) {
            session.stop();
        }
        self.starts.lock().unwrap().remove(project_id);
    }

    pub async fn stop_all(&self) {
        for (_, session) in self.entries.lock().await.drain() {
            session.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::rpc::{read_frame, write_frame};
    use super::*;
    use tokio::io::{duplex, split, BufReader, DuplexStream, ReadHalf, WriteHalf};

    struct Server {
        read: BufReader<ReadHalf<DuplexStream>>,
        write: WriteHalf<DuplexStream>,
    }

    impl Server {
        async fn next(&mut self) -> Value {
            read_frame(&mut self.read).await.unwrap()
        }
        async fn expect(&mut self, method: &str) -> Value {
            let message = self.next().await;
            assert_eq!(message["method"], method);
            message
        }
        async fn result(&mut self, id: &Value, result: Value) {
            write_frame(&mut self.write, &json!({"jsonrpc":"2.0", "id":id, "result":result})).await.unwrap();
        }
    }

    async fn connected() -> (Arc<Session>, Server) {
        let (client, server) = duplex(64 * 1024);
        let (read, write) = split(server);
        let mut server = Server { read: BufReader::new(read), write };
        let (read, write) = split(client);
        let root = std::env::temp_dir();
        let start = tokio::spawn(async move { Session::start(read, write, None, &root).await });
        let initialize = server.expect("initialize").await;
        assert!(initialize["params"]["workspaceFolders"][0]["uri"].as_str().unwrap().starts_with("file:///"));
        server.result(&initialize["id"], json!({"capabilities": {}})).await;
        server.expect("initialized").await;
        server.expect("workspace/didChangeConfiguration").await;
        (Arc::new(start.await.unwrap().unwrap()), server)
    }

    fn request<'a>(editor: &'a str, version: u64, text: &'a str) -> CompletionRequest<'a> {
        CompletionRequest {
            uri: "file:///project/a.rs", editor, client_version: version, text, language: "rust",
            position: super::super::documents::position(text), automatic: true, tab_size: 4, insert_spaces: true,
        }
    }

    #[test]
    fn caret_must_be_a_utf16_boundary_inside_its_line() {
        let at = |line, character| position_in("a😀\r\nxy", Position { line, character });
        assert!(at(0, 0) && at(0, 1) && at(0, 3) && at(1, 2));
        assert!(!at(0, 2), "inside the surrogate pair");
        assert!(!at(0, 4), "on the carriage return");
        assert!(!at(1, 3) && !at(2, 0));
    }

    #[tokio::test]
    async fn completion_keeps_server_items_behind_opaque_ids() {
        let (session, mut server) = connected().await;
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.complete(request("main:1", 1, "fn a")).await });
        assert_eq!(server.expect("textDocument/didOpen").await["params"]["textDocument"]["text"], "fn a");
        server.expect("textDocument/didFocus").await;
        let call = server.expect("textDocument/inlineCompletion").await;
        assert_eq!(call["params"]["position"], json!({"line":0, "character":4}));
        assert_eq!(call["params"]["context"]["triggerKind"], 2);
        let command = json!({"command":"accept", "arguments":["secret-uuid"]});
        server.result(&call["id"], json!({"items":[{"insertText":"fn add()", "command":command}]})).await;
        let items = work.await.unwrap().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["insertText"], "fn add()");
        assert!(items[0].get("command").is_none());
        let id = items[0]["id"].as_str().unwrap().to_owned();

        session.shown("other:1", &id).await.unwrap(); // not this editor's offer
        session.shown("main:1", &id).await.unwrap();
        let shown = server.expect("textDocument/didShowCompletion").await;
        assert_eq!(shown["params"]["item"]["command"], command);
        session.accepted("main:1", &id, Some(3)).await.unwrap();
        assert_eq!(server.expect("textDocument/didPartiallyAcceptCompletion").await["params"]["acceptedLength"], 3);
        let worker = session.clone();
        let accepted = id.clone();
        let work = tokio::spawn(async move { worker.accepted("main:1", &accepted, None).await });
        let call = server.expect("workspace/executeCommand").await;
        assert_eq!(call["params"]["arguments"][0], "secret-uuid");
        server.result(&call["id"], Value::Null).await;
        work.await.unwrap().unwrap();
        session.accepted("main:1", &id, None).await.unwrap(); // reported once
        session.close_editor("main:1").await;
        server.expect("textDocument/didClose").await;
    }

    #[tokio::test]
    async fn newer_request_cancels_older_and_closing_makes_a_reply_stale() {
        let (session, mut server) = connected().await;
        let worker = session.clone();
        let first = tokio::spawn(async move { worker.complete(request("main:1", 1, "a")).await });
        server.expect("textDocument/didOpen").await;
        server.expect("textDocument/didFocus").await;
        let first_call = server.expect("textDocument/inlineCompletion").await;
        let worker = session.clone();
        let second = tokio::spawn(async move { worker.complete(request("main:1", 2, "ab")).await });
        server.expect("textDocument/didChange").await;
        server.expect("textDocument/didFocus").await;
        assert_eq!(server.expect("$/cancelRequest").await["params"]["id"], first_call["id"]);
        assert_eq!(first.await.unwrap(), Err("copilot_cancelled".into()));
        let second_call = server.expect("textDocument/inlineCompletion").await;
        session.close_editor("main:1").await;
        assert_eq!(second.await.unwrap(), Err("copilot_cancelled".into()));
        server.expect("$/cancelRequest").await;
        server.expect("textDocument/didClose").await;
        server.result(&second_call["id"], json!({"items":[{"insertText":"late"}]})).await;
    }

    #[tokio::test]
    async fn server_requests_are_answered_without_granting_anything() {
        let (session, mut server) = connected().await;
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "id":"s1", "method":"workspace/configuration",
            "params":{"items":[{}, {}]}})).await.unwrap();
        let reply = server.next().await;
        assert_eq!((&reply["id"], &reply["result"]), (&json!("s1"), &json!([null, null])));
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "id":7, "method":"window/showDocument",
            "params":{"uri":"https://example.invalid"}})).await.unwrap();
        assert_eq!(server.next().await["result"], json!({"success": false}));
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "method":"didChangeStatus",
            "params":{"kind":"Warning", "message":"quota"}})).await.unwrap();
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "id":8, "method":"unknown/request"})).await.unwrap();
        assert_eq!(server.next().await["result"], Value::Null);
        assert_eq!(session.status(), Status { kind: "Warning".into(), message: Some("quota".into()) });
    }

    #[tokio::test]
    async fn device_flow_keeps_its_finishing_command_in_the_backend() {
        let (session, mut server) = connected().await;
        assert_eq!(session.finish_sign_in().await, Err("copilot_no_sign_in".into()));
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.sign_in().await });
        let call = server.expect("signIn").await;
        server.result(&call["id"], json!({"userCode":"AB-12", "verificationUri":"https://github.com/login/device",
            "command":{"command":"finish", "arguments":[]}})).await;
        assert_eq!(work.await.unwrap().unwrap().unwrap().user_code, "AB-12");
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.finish_sign_in().await });
        let call = server.expect("workspace/executeCommand").await;
        assert_eq!(call["params"]["command"], "finish");
        server.result(&call["id"], json!({"status":"OK"})).await;
        work.await.unwrap().unwrap();

        let worker = session.clone();
        let work = tokio::spawn(async move { worker.sign_in().await });
        let call = server.expect("signIn").await;
        server.result(&call["id"], json!({"userCode":"AB-12", "verificationUri":"https://example.invalid/x"})).await;
        assert_eq!(work.await.unwrap(), Err("copilot_server_error".into()));
    }

    #[tokio::test]
    async fn unauthenticated_and_dead_servers_report_coarse_codes() {
        let (session, mut server) = connected().await;
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.complete(request("main:1", 1, "a")).await });
        server.expect("textDocument/didOpen").await;
        server.expect("textDocument/didFocus").await;
        let call = server.expect("textDocument/inlineCompletion").await;
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "id":call["id"],
            "error":{"code":1000, "message":"token detail that must not travel"}})).await.unwrap();
        assert_eq!(work.await.unwrap(), Err("copilot_not_signed_in".into()));
        drop(server);
        assert_eq!(session.complete(request("main:1", 2, "ab")).await, Err("copilot_server_closed".into()));
        assert!(!session.alive());
    }

    /// The real pinned server inside the real fence; needs an installation:
    /// `ELDRUN_COPILOT_INSTALL=/dir cargo test --lib copilot -- --ignored`.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore]
    async fn fenced_server_initializes_and_refuses_unauthenticated_completion() {
        let install = std::env::var("ELDRUN_COPILOT_INSTALL").expect("ELDRUN_COPILOT_INSTALL");
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        std::fs::write(root.join("a.py"), "def square(x):\n    return ").unwrap();
        let (process, output, input) = ManagedProcess::launch_installed(Path::new(&install), &root).unwrap();
        let session = Session::start(output, input, Some(process), &root).await.unwrap();
        assert!(session.alive());
        let uri = url::Url::from_file_path(root.join("a.py")).unwrap();
        let text = "def square(x):\n    return ";
        let result = session.complete(CompletionRequest {
            uri: uri.as_str(), editor: "main:1", client_version: 1, text, language: "python",
            position: super::super::documents::position(text), automatic: false, tab_size: 4, insert_spaces: true,
        }).await;
        assert_eq!(result, Err("copilot_not_signed_in".into()));
        session.stop();
        assert!(!session.alive());
    }

    #[test]
    fn a_crashing_server_is_not_restarted_forever() {
        let sessions = Sessions::default();
        let now = Instant::now();
        for _ in 0..MAX_STARTS {
            assert!(sessions.allow_start("one", now));
        }
        assert!(!sessions.allow_start("one", now));
        assert!(sessions.allow_start("two", now));
        assert!(sessions.allow_start("one", now + START_WINDOW + Duration::from_secs(1)));
    }
}
