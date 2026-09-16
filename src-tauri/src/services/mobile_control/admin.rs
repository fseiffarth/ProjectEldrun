use std::{
    io,
    path::Path,
    sync::{Arc, Mutex},
};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{
    auth::AuthStore,
    protocol::{AdminRequest, AdminResponse, DesktopRequest, DesktopResponse, MAX_CONTROL_MESSAGE},
};

pub async fn write_frame<T: serde::Serialize>(
    stream: &mut (impl AsyncWriteExt + Unpin),
    value: &T,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_CONTROL_MESSAGE {
        return Err("control message too large".into());
    }
    stream
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|e| e.to_string())?;
    stream.write_all(&bytes).await.map_err(|e| e.to_string())
}

pub async fn read_frame<T: serde::de::DeserializeOwned>(
    stream: &mut (impl AsyncReadExt + Unpin),
) -> Result<T, String> {
    let len = stream.read_u32().await.map_err(|e| e.to_string())? as usize;
    if len == 0 || len > MAX_CONTROL_MESSAGE {
        return Err("invalid control message length".into());
    }
    let mut bytes = vec![0; len];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// The admin plane's request/response mapping, shared by every transport.
fn admin_response(
    request: Result<AdminRequest, String>,
    auth: &Arc<Mutex<AuthStore>>,
    port: u16,
    origin: Option<String>,
    shutdown: &tokio::sync::watch::Sender<bool>,
) -> AdminResponse {
    match request {
        Ok(AdminRequest::Status) => AdminResponse::Host {
            running: true,
            port,
            origin,
            version: Some(env!("CARGO_PKG_VERSION").into()),
        },
        Ok(AdminRequest::PairingCode) => match auth.lock().unwrap().create_pairing_code() {
            Ok((code, expires_at)) => AdminResponse::PairingCode { code, expires_at },
            Err(message) => AdminResponse::Error { message },
        },
        Ok(AdminRequest::Devices) => AdminResponse::Devices {
            devices: auth.lock().unwrap().devices(),
        },
        Ok(AdminRequest::Revoke { device_id }) => match auth.lock().unwrap().revoke(&device_id) {
            Ok(()) => AdminResponse::Ok,
            Err(message) => AdminResponse::Error { message },
        },
        Ok(AdminRequest::ForgetAll) => match auth.lock().unwrap().forget_all() {
            Ok(()) => AdminResponse::Ok,
            Err(message) => AdminResponse::Error { message },
        },
        Ok(AdminRequest::Shutdown) => {
            let _ = shutdown.send(true);
            AdminResponse::Ok
        }
        Err(message) => AdminResponse::Error { message },
    }
}

#[cfg(unix)]
fn trusted_peer(stream: &tokio::net::UnixStream) -> bool {
    stream
        .peer_cred()
        .ok()
        .map(|c| c.uid())
        .is_some_and(|uid| uid == unsafe { libc::geteuid() })
}

#[cfg(unix)]
pub async fn serve(
    socket: &Path,
    auth: Arc<Mutex<AuthStore>>,
    port: u16,
    origin: Option<String>,
    shutdown: tokio::sync::watch::Sender<bool>,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::remove_file(socket);
    let listener =
        tokio::net::UnixListener::bind(socket).map_err(|e| format!("bind admin socket: {e}"))?;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    loop {
        // One transient accept failure (EMFILE, ECONNABORTED) must not take the
        // admin plane down permanently — that is how the desktop reaches the
        // sidecar to pair, revoke, and shut it down.
        let Ok((mut stream, _)) = listener.accept().await else {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            continue;
        };
        if !trusted_peer(&stream) {
            continue;
        }
        let auth = auth.clone();
        let origin = origin.clone();
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            let request = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                read_frame::<AdminRequest>(&mut stream),
            )
            .await
            .unwrap_or_else(|_| Err("control message timed out".into()));
            let response = admin_response(request, &auth, port, origin, &shutdown);
            let _ = write_frame(&mut stream, &response).await;
        });
    }
}

/// Windows control-plane transport: a named pipe plus a same-user token.
///
/// `tokio::net::UnixStream` does not exist on Windows, so the same
/// length-prefixed JSON frames ride a named pipe instead. A named pipe's
/// default DACL is broader than a 0o600 socket, and tokio exposes no peer
/// identity to check — so the peer proves itself with a random token the
/// listener writes beside the nominal socket path (inside the per-user
/// profile, whose ACL restricts it to the same user, matching the state dir's
/// existing posture). The first frame of every connection is that token;
/// everything after it is the ordinary protocol.
#[cfg(windows)]
pub mod pipe {
    use std::path::{Path, PathBuf};

    /// Stable per-path pipe name so two Eldrun state dirs never collide.
    pub fn pipe_name(socket: &Path) -> String {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(socket.to_string_lossy().as_bytes());
        let mut hex = String::with_capacity(32);
        for byte in &digest[..16] {
            use std::fmt::Write;
            let _ = write!(hex, "{byte:02x}");
        }
        format!(r"\\.\pipe\eldrun-control-{hex}")
    }

    pub fn token_path(socket: &Path) -> PathBuf {
        socket.with_extension("token")
    }

    /// Mint and persist the listener-side token.
    pub fn create_token(socket: &Path) -> Result<String, String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| format!("no system randomness: {e}"))?;
        let mut token = String::with_capacity(64);
        for byte in &bytes {
            use std::fmt::Write;
            let _ = write!(token, "{byte:02x}");
        }
        if let Some(parent) = socket.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(token_path(socket), &token)
            .map_err(|e| format!("write control token: {e}"))?;
        Ok(token)
    }

    pub fn read_token(socket: &Path) -> Result<String, String> {
        std::fs::read_to_string(token_path(socket))
            .map(|token| token.trim().to_string())
            .map_err(|e| format!("read control token: {e}"))
    }

    pub fn token_matches(presented: &str, expected: &str) -> bool {
        use subtle::ConstantTimeEq;
        presented.as_bytes().ct_eq(expected.as_bytes()).into()
    }

    /// Open a client connection, riding out the tiny window where every pipe
    /// instance is taken (the listener re-creates the next instance right
    /// after each accept).
    pub async fn connect(
        socket: &Path,
    ) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String> {
        use tokio::net::windows::named_pipe::ClientOptions;
        let name = pipe_name(socket);
        // `ERROR_PIPE_BUSY`: every instance is taken — the one condition a
        // retry can resolve, since the listener creates the next instance right
        // after each accept.
        const ERROR_PIPE_BUSY: i32 = 231;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match ClientOptions::new().open(&name) {
                Ok(client) => return Ok(client),
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(error.to_string());
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                // Anything else — above all "no such pipe", the desktop or the
                // host simply not running — is the answer, not a wait: retrying
                // it made every bridge call with the desktop closed sit out the
                // whole deadline before it could say `desktop_unavailable`.
                Err(error) => return Err(error.to_string()),
            }
        }
    }
}

#[cfg(windows)]
pub async fn serve(
    socket: &Path,
    auth: Arc<Mutex<AuthStore>>,
    port: u16,
    origin: Option<String>,
    shutdown: tokio::sync::watch::Sender<bool>,
) -> Result<(), String> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = pipe::pipe_name(socket);
    let token = pipe::create_token(socket)?;
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&name)
        .map_err(|e| format!("bind admin pipe: {e}"))?;
    loop {
        // Mirror the Unix loop: a transient failure must not take the admin
        // plane down permanently.
        if server.connect().await.is_err() {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            continue;
        }
        let Ok(next) = ServerOptions::new().create(&name) else {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            continue;
        };
        let mut stream = std::mem::replace(&mut server, next);
        let auth = auth.clone();
        let origin = origin.clone();
        let shutdown = shutdown.clone();
        let token = token.clone();
        tokio::spawn(async move {
            let presented = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                read_frame::<String>(&mut stream),
            )
            .await;
            let authorized =
                matches!(&presented, Ok(Ok(value)) if pipe::token_matches(value, &token));
            if !authorized {
                return;
            }
            let request = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                read_frame::<AdminRequest>(&mut stream),
            )
            .await
            .unwrap_or_else(|_| Err("control message timed out".into()));
            let response = admin_response(request, &auth, port, origin, &shutdown);
            let _ = write_frame(&mut stream, &response).await;
        });
    }
}

#[cfg(not(any(unix, windows)))]
pub async fn serve(
    _: &Path,
    _: Arc<Mutex<AuthStore>>,
    _: u16,
    _: Option<String>,
    _: tokio::sync::watch::Sender<bool>,
) -> Result<(), String> {
    Err("Eldrun Mobile host is not supported on this platform".into())
}

/// The sidecar's most common state — not running — reaching a caller as a
/// sentence rather than an errno.
///
/// A stopped host leaves its socket *file* behind, so connecting to it fails
/// with `ECONNREFUSED`; passing that through rendered the whole feature's
/// ordinary down state in the Mobile menu as `Connection refused (os error
/// 111)`, which names neither Eldrun Mobile nor anything the reader can act on.
/// `NotFound` is the same state with the socket file already gone.
pub const NOT_RUNNING_ERROR: &str = "The Eldrun Mobile host is not running";

#[cfg(unix)]
fn connect_error(error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound => {
            NOT_RUNNING_ERROR.to_string()
        }
        _ => error.to_string(),
    }
}

#[cfg(unix)]
pub async fn admin_call(socket: &Path, request: &AdminRequest) -> Result<AdminResponse, String> {
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::UnixStream::connect(socket),
    )
    .await
    .map_err(|_| "mobile host connection timed out")?
    .map_err(connect_error)?;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        write_frame(&mut stream, request).await?;
        read_frame(&mut stream).await
    })
    .await
    .map_err(|_| "mobile host response timed out")?
}

#[cfg(windows)]
pub async fn admin_call(socket: &Path, request: &AdminRequest) -> Result<AdminResponse, String> {
    let token = pipe::read_token(socket)?;
    let mut stream = pipe::connect(socket).await?;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        write_frame(&mut stream, &token).await?;
        write_frame(&mut stream, request).await?;
        read_frame(&mut stream).await
    })
    .await
    .map_err(|_| "mobile host response timed out")?
}

#[cfg(not(any(unix, windows)))]
pub async fn admin_call(_: &Path, _: &AdminRequest) -> Result<AdminResponse, String> {
    Err("unsupported platform".into())
}

#[cfg(unix)]
pub async fn desktop_call(
    socket: &Path,
    request: &DesktopRequest,
) -> Result<DesktopResponse, String> {
    // Per-request: a mail open and an agent-status read each outlive the
    // control-message SLA for their own reason (see `DesktopRequest`).
    let response_timeout = request.response_timeout();
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::UnixStream::connect(socket),
    )
    .await
    .map_err(|_| "desktop_unavailable")?
    .map_err(|_| "desktop_unavailable")?;
    // The request write sits inside the deadline too: a desktop that accepted
    // the connection and then stopped reading is as gone as one that never
    // answered.
    tokio::time::timeout(response_timeout, async {
        write_frame(&mut stream, request).await?;
        read_frame(&mut stream).await
    })
    .await
    .map_err(|_| "desktop_unavailable")?
}

#[cfg(windows)]
pub async fn desktop_call(
    socket: &Path,
    request: &DesktopRequest,
) -> Result<DesktopResponse, String> {
    let response_timeout = request.response_timeout();
    let token = pipe::read_token(socket).map_err(|_| "desktop_unavailable")?;
    let mut stream = pipe::connect(socket).await.map_err(|_| "desktop_unavailable")?;
    tokio::time::timeout(response_timeout, async {
        write_frame(&mut stream, &token).await?;
        write_frame(&mut stream, request).await?;
        read_frame(&mut stream).await
    })
    .await
    .map_err(|_| "desktop_unavailable")?
}

#[cfg(not(any(unix, windows)))]
pub async fn desktop_call(_: &Path, _: &DesktopRequest) -> Result<DesktopResponse, String> {
    Err("desktop_unavailable".into())
}

/// Whether a desktop is *answering* on its control socket, as opposed to
/// having left the socket file behind.
///
/// `socket.exists()` was the check, and it was wrong both ways: on Unix the
/// file outlives a desktop exit — and every crash — so the phone was told the
/// desktop was there for as long as it stayed closed; on Windows the nominal
/// path is never a file at all, so it was never told. A connect to a Unix
/// socket nobody listens on fails with `ECONNREFUSED` at once, and the
/// desktop's accept loop reads an EOF from the probe and moves on.
#[cfg(unix)]
pub async fn desktop_reachable(socket: &Path) -> bool {
    matches!(
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            tokio::net::UnixStream::connect(socket),
        )
        .await,
        Ok(Ok(_))
    )
}

#[cfg(windows)]
pub async fn desktop_reachable(socket: &Path) -> bool {
    pipe::connect(socket).await.is_ok()
}

#[cfg(not(any(unix, windows)))]
pub async fn desktop_reachable(_: &Path) -> bool {
    false
}

pub fn io_other(message: String) -> io::Error {
    io::Error::other(message)
}

#[cfg(all(test, unix))]
mod tests {
    use super::desktop_reachable;

    #[tokio::test]
    async fn a_desktop_is_reachable_only_while_something_listens_on_its_socket() {
        let dir = tempfile::tempdir().expect("control dir");
        let socket = dir.path().join("desktop-control.sock");
        assert!(!desktop_reachable(&socket).await, "no socket at all");
        // The file a desktop leaves behind when it exits — or crashes.
        std::fs::write(&socket, b"").expect("stale socket file");
        assert!(
            !desktop_reachable(&socket).await,
            "a stale socket file is not a desktop"
        );
        std::fs::remove_file(&socket).expect("remove stale file");
        let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
        assert!(desktop_reachable(&socket).await);
        drop(listener);
    }
}

#[cfg(test)]
mod frame_tests {
    use super::*;

    /// A frame is a big-endian u32 length followed by that many JSON bytes;
    /// what one side writes the other reads back unchanged.
    #[tokio::test]
    async fn frames_round_trip_through_a_length_prefix() {
        let mut wire: Vec<u8> = Vec::new();
        write_frame(&mut wire, &AdminRequest::Revoke { device_id: "d1".into() })
            .await
            .unwrap();
        let body = serde_json::to_vec(&AdminRequest::Revoke { device_id: "d1".into() }).unwrap();
        assert_eq!(&wire[..4], (body.len() as u32).to_be_bytes());
        assert_eq!(&wire[4..], &body[..]);
        let mut reader: &[u8] = &wire;
        let back: AdminRequest = read_frame(&mut reader).await.unwrap();
        assert!(matches!(back, AdminRequest::Revoke { device_id } if device_id == "d1"));
        assert!(reader.is_empty(), "nothing left over after one frame");
    }

    /// An oversized message is refused before a single byte goes out — a
    /// partial length prefix would desynchronize the peer.
    #[tokio::test]
    async fn an_oversized_frame_is_refused_before_anything_is_written() {
        let mut wire: Vec<u8> = Vec::new();
        let huge = "x".repeat(MAX_CONTROL_MESSAGE + 1);
        let err = write_frame(&mut wire, &huge).await.unwrap_err();
        assert_eq!(err, "control message too large");
        assert!(wire.is_empty());
        let fits = "x".repeat(MAX_CONTROL_MESSAGE - 16);
        write_frame(&mut wire, &fits).await.unwrap();
        assert_eq!(wire.len(), 4 + MAX_CONTROL_MESSAGE - 16 + 2);
    }

    /// The reader trusts no length: zero and anything above the cap are
    /// rejected without allocating for the body, and a body shorter than its
    /// prefix is an error rather than a hang or a partial parse.
    #[tokio::test]
    async fn the_reader_rejects_bad_lengths_and_truncated_bodies() {
        let mut zero: &[u8] = &0u32.to_be_bytes();
        let err = read_frame::<AdminRequest>(&mut zero).await.unwrap_err();
        assert_eq!(err, "invalid control message length");

        let mut too_big: &[u8] = &u32::MAX.to_be_bytes();
        let err = read_frame::<AdminRequest>(&mut too_big).await.unwrap_err();
        assert_eq!(err, "invalid control message length");

        let mut short = 10u32.to_be_bytes().to_vec();
        short.extend_from_slice(b"\"ab");
        let mut short: &[u8] = &short;
        assert!(read_frame::<String>(&mut short).await.is_err());

        let mut not_json = 2u32.to_be_bytes().to_vec();
        not_json.extend_from_slice(b"{]");
        let mut not_json: &[u8] = &not_json;
        assert!(read_frame::<AdminRequest>(&mut not_json).await.is_err());
    }

    /// The admin plane's mapping, transport aside: status reports the port and
    /// version, an unknown device is an error not a silent no-op, forget-all
    /// and shutdown answer `Ok`, and shutdown actually flips the watch.
    #[test]
    fn admin_requests_map_to_their_responses() {
        let dir = tempfile::tempdir().unwrap();
        let auth = AuthStore::open(&dir.path().join("mobile-control"), "https://desk.example".into())
            .expect("auth store");
        let auth = Arc::new(Mutex::new(auth));
        let (shutdown, watch) = tokio::sync::watch::channel(false);
        let respond =
            |request| admin_response(request, &auth, 8443, Some("https://desk.example".into()), &shutdown);

        match respond(Ok(AdminRequest::Status)) {
            AdminResponse::Host { running, port, origin, version } => {
                assert!(running);
                assert_eq!(port, 8443);
                assert_eq!(origin.as_deref(), Some("https://desk.example"));
                assert_eq!(version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
            }
            other => panic!("status answered {other:?}"),
        }
        assert!(matches!(respond(Ok(AdminRequest::Devices)), AdminResponse::Devices { devices } if devices.is_empty()));
        assert!(matches!(
            respond(Ok(AdminRequest::Revoke { device_id: "nope".into() })),
            AdminResponse::Error { message } if message == "unknown device"
        ));
        assert!(matches!(
            respond(Ok(AdminRequest::PairingCode)),
            AdminResponse::PairingCode { code, expires_at } if code.len() == 8 && expires_at > 0
        ));
        assert!(matches!(respond(Ok(AdminRequest::ForgetAll)), AdminResponse::Ok));
        assert!(matches!(
            respond(Err("control message timed out".into())),
            AdminResponse::Error { message } if message == "control message timed out"
        ));
        assert!(!*watch.borrow());
        assert!(matches!(respond(Ok(AdminRequest::Shutdown)), AdminResponse::Ok));
        assert!(*watch.borrow());
    }

    /// A host that is not running — socket refused or already gone — reaches
    /// the menu as the sentence, and any other failure keeps its own text.
    #[cfg(unix)]
    #[test]
    fn a_stopped_host_reads_as_not_running_and_other_errors_keep_their_text() {
        use std::io::{Error, ErrorKind};
        assert_eq!(connect_error(Error::from(ErrorKind::ConnectionRefused)), NOT_RUNNING_ERROR);
        assert_eq!(connect_error(Error::from(ErrorKind::NotFound)), NOT_RUNNING_ERROR);
        let denied = connect_error(Error::new(ErrorKind::PermissionDenied, "socket is 0600"));
        assert_ne!(denied, NOT_RUNNING_ERROR);
        assert!(denied.contains("0600"));
    }
}
