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
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match ClientOptions::new().open(&name) {
                Ok(client) => return Ok(client),
                Err(error) => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(error.to_string());
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
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

#[cfg(unix)]
pub async fn admin_call(socket: &Path, request: &AdminRequest) -> Result<AdminResponse, String> {
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::UnixStream::connect(socket),
    )
    .await
    .map_err(|_| "mobile host connection timed out")?
    .map_err(|e| e.to_string())?;
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
    // A first message open may need a bounded IMAP BODY.PEEK fetch. The other
    // control calls should still fail fast when the desktop is wedged.
    let response_timeout = if matches!(request, DesktopRequest::MailMessage { .. }) {
        std::time::Duration::from_secs(35)
    } else {
        std::time::Duration::from_secs(10)
    };
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::UnixStream::connect(socket),
    )
    .await
    .map_err(|_| "desktop_unavailable")?
    .map_err(|_| "desktop_unavailable")?;
    write_frame(&mut stream, request).await?;
    tokio::time::timeout(response_timeout, read_frame(&mut stream))
        .await
        .map_err(|_| "desktop_unavailable")?
}

#[cfg(windows)]
pub async fn desktop_call(
    socket: &Path,
    request: &DesktopRequest,
) -> Result<DesktopResponse, String> {
    let response_timeout = if matches!(request, DesktopRequest::MailMessage { .. }) {
        std::time::Duration::from_secs(35)
    } else {
        std::time::Duration::from_secs(10)
    };
    let token = pipe::read_token(socket).map_err(|_| "desktop_unavailable")?;
    let mut stream = pipe::connect(socket).await.map_err(|_| "desktop_unavailable")?;
    write_frame(&mut stream, &token).await?;
    write_frame(&mut stream, request).await?;
    tokio::time::timeout(response_timeout, read_frame(&mut stream))
        .await
        .map_err(|_| "desktop_unavailable")?
}

#[cfg(not(any(unix, windows)))]
pub async fn desktop_call(_: &Path, _: &DesktopRequest) -> Result<DesktopResponse, String> {
    Err("desktop_unavailable".into())
}

pub fn io_other(message: String) -> io::Error {
    io::Error::other(message)
}
