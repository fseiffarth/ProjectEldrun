//! Accept-side bounds for the mobile host.
//!
//! `axum::serve` applies none of its own: hyper has no default header-read
//! timeout and nothing capped concurrent connections, so an unauthenticated
//! tailnet peer could open thousands of dribbling connections and exhaust the
//! sidecar's file descriptors without ever authenticating.
//!
//! Two bounds, both on the raw stream so they apply *before* any handler runs:
//!
//! * a semaphore permit per accepted connection, released when the stream drops;
//! * a handshake deadline that fires while the server has not yet written a
//!   single byte. Completing a request lifts it, so long-lived WebSockets are
//!   untouched, while a connection that never finishes its headers dies.

use std::{
    future::Future,
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{sleep, Sleep},
};

/// Generous next to a phone's handful of sockets, small enough that the process
/// stays far below any sane file-descriptor limit.
pub const MAX_CONNECTIONS: usize = 256;
/// A real client completes its request headers in milliseconds over loopback.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

pub struct GuardedListener {
    inner: TcpListener,
    permits: Arc<Semaphore>,
}

impl GuardedListener {
    pub fn new(inner: TcpListener) -> Self {
        Self {
            inner,
            permits: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
        }
    }
}

impl axum::serve::Listener for GuardedListener {
    type Io = GuardedStream;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            // Wait for a slot *before* accepting, so an overload leaves
            // connections queued in the kernel rather than held open by us.
            let Ok(permit) = self.permits.clone().acquire_owned().await else {
                std::future::pending::<()>().await;
                unreachable!("the semaphore is never closed");
            };
            match self.inner.accept().await {
                Ok((stream, addr)) => return (GuardedStream::new(stream, permit), addr),
                // Matches axum's own behaviour: a per-connection accept error
                // must never take the listener down.
                Err(_) => continue,
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

pub struct GuardedStream {
    inner: TcpStream,
    _permit: OwnedSemaphorePermit,
    deadline: Option<Pin<Box<Sleep>>>,
}

impl GuardedStream {
    fn new(inner: TcpStream, permit: OwnedSemaphorePermit) -> Self {
        Self {
            inner,
            _permit: permit,
            deadline: Some(Box::pin(sleep(HANDSHAKE_TIMEOUT))),
        }
    }
}

impl AsyncRead for GuardedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        // Polling the timer here is what makes it fire on a silent connection:
        // it registers our waker, so a peer that sends nothing still wakes us at
        // the deadline instead of parking forever on `Poll::Pending`.
        if let Some(deadline) = self.deadline.as_mut() {
            if deadline.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "handshake timeout",
                )));
            }
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for GuardedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let written = Pin::new(&mut self.inner).poll_write(cx, buf);
        // The server has answered, so this is a real client: lift the deadline
        // rather than tearing down an idle WebSocket or a slow download.
        if matches!(written, Poll::Ready(Ok(_))) {
            self.deadline = None;
        }
        written
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let written = Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        if matches!(written, Poll::Ready(Ok(_))) {
            self.deadline = None;
        }
        written
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn listener() -> (GuardedListener, SocketAddr) {
        let inner = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind");
        let address = inner.local_addr().expect("addr");
        (GuardedListener::new(inner), address)
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_connection_is_dropped_at_the_handshake_deadline() {
        use axum::serve::Listener;
        let (mut guarded, address) = listener().await;
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.expect("connect");
            // Never send anything, as a slowloris would.
            let mut buffer = [0u8; 1];
            let _ = stream.read(&mut buffer).await;
        });
        let (stream, _) = guarded.accept().await;
        let mut stream = stream;
        let mut buffer = [0u8; 64];
        let error = stream.read(&mut buffer).await.expect_err("timed out");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        drop(stream);
        client.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn answering_the_client_lifts_the_deadline() {
        use axum::serve::Listener;
        let (mut guarded, address) = listener().await;
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.expect("connect");
            stream.write_all(b"hello").await.expect("write");
            let mut buffer = [0u8; 2];
            let _ = stream.read_exact(&mut buffer).await;
            // Then idle well past the handshake window.
            tokio::time::sleep(HANDSHAKE_TIMEOUT * 4).await;
            stream.write_all(b"more").await
        });
        let (mut stream, _) = guarded.accept().await;
        let mut buffer = [0u8; 5];
        stream.read_exact(&mut buffer).await.expect("read request");
        stream.write_all(b"ok").await.expect("respond");
        let mut rest = [0u8; 4];
        stream.read_exact(&mut rest).await.expect("still open");
        assert_eq!(&rest, b"more");
        client.await.expect("client task").expect("client write");
    }

    #[tokio::test]
    async fn connections_beyond_the_cap_wait_for_a_slot() {
        use axum::serve::Listener;
        let (mut guarded, address) = listener().await;
        assert_eq!(guarded.permits.available_permits(), MAX_CONNECTIONS);
        let _client = TcpStream::connect(address).await.expect("connect");
        let (held, _) = guarded.accept().await;
        assert_eq!(guarded.permits.available_permits(), MAX_CONNECTIONS - 1);
        drop(held);
        assert_eq!(guarded.permits.available_permits(), MAX_CONNECTIONS);
    }
}
