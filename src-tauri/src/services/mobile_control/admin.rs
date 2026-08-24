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
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
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
            let response = match request {
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
                Ok(AdminRequest::Revoke { device_id }) => {
                    match auth.lock().unwrap().revoke(&device_id) {
                        Ok(()) => AdminResponse::Ok,
                        Err(message) => AdminResponse::Error { message },
                    }
                }
                Ok(AdminRequest::ForgetAll) => match auth.lock().unwrap().forget_all() {
                    Ok(()) => AdminResponse::Ok,
                    Err(message) => AdminResponse::Error { message },
                },
                Ok(AdminRequest::Shutdown) => {
                    let _ = shutdown.send(true);
                    AdminResponse::Ok
                }
                Err(message) => AdminResponse::Error { message },
            };
            let _ = write_frame(&mut stream, &response).await;
        });
    }
}

#[cfg(not(unix))]
pub async fn serve(
    _: &Path,
    _: Arc<Mutex<AuthStore>>,
    _: u16,
    _: Option<String>,
    _: tokio::sync::watch::Sender<bool>,
) -> Result<(), String> {
    Err("Eldrun Mobile host requires Unix sockets".into())
}

#[cfg(unix)]
pub async fn admin_call(socket: &Path, request: &AdminRequest) -> Result<AdminResponse, String> {
    let mut stream = tokio::net::UnixStream::connect(socket)
        .await
        .map_err(|e| e.to_string())?;
    write_frame(&mut stream, request).await?;
    read_frame(&mut stream).await
}

#[cfg(not(unix))]
pub async fn admin_call(_: &Path, _: &AdminRequest) -> Result<AdminResponse, String> {
    Err("unsupported platform".into())
}

#[cfg(unix)]
pub async fn desktop_call(
    socket: &Path,
    request: &DesktopRequest,
) -> Result<DesktopResponse, String> {
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::UnixStream::connect(socket),
    )
    .await
    .map_err(|_| "desktop_unavailable")?
    .map_err(|_| "desktop_unavailable")?;
    write_frame(&mut stream, request).await?;
    tokio::time::timeout(std::time::Duration::from_secs(10), read_frame(&mut stream))
        .await
        .map_err(|_| "desktop_unavailable")?
}

#[cfg(not(unix))]
pub async fn desktop_call(_: &Path, _: &DesktopRequest) -> Result<DesktopResponse, String> {
    Err("desktop_unavailable".into())
}

pub fn io_other(message: String) -> io::Error {
    io::Error::other(message)
}
