//! Accept-side bounds for the mobile host.
//!
//! `axum::serve` applies none of its own: hyper has no default header-read
//! timeout and nothing capped concurrent connections, so an unauthenticated
//! tailnet peer could open thousands of dribbling connections and exhaust the
//! sidecar's file descriptors without ever authenticating.
//!
//! Three bounds, all on the raw stream so they apply *before* any handler runs:
//!
//! * a semaphore permit per accepted connection, released when the stream drops;
//! * a handshake deadline that fires while the server has not yet written a
//!   single byte, so a connection that never finishes its headers dies;
//! * once the server has answered, an idle deadline re-armed by every byte read
//!   or written. Without it, 256 sockets held open after one completed request
//!   — from any tailnet node, or any local process, since the agent fence
//!   shares the network namespace — sat on every permit for as long as the
//!   kernel kept them, and the phone could not connect at all. A live
//!   WebSocket is never idle this long: the phone pings every 20 s in the
//!   foreground and about once a minute throttled in the background.

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
/// How long an answered connection may carry no byte in either direction.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

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
    /// The handshake deadline until the server has answered, the idle deadline
    /// after — re-armed by every byte that then crosses.
    deadline: Pin<Box<Sleep>>,
    /// Whether the server has written anything yet. Only then do reads re-arm
    /// the deadline: a slowloris dribbling one header byte per second must not
    /// be able to keep the handshake window open.
    answered: bool,
}

impl GuardedStream {
    fn new(inner: TcpStream, permit: OwnedSemaphorePermit) -> Self {
        Self {
            inner,
            _permit: permit,
            deadline: Box::pin(sleep(HANDSHAKE_TIMEOUT)),
            answered: false,
        }
    }

    fn rearm_idle(&mut self) {
        self.deadline
            .as_mut()
            .reset(tokio::time::Instant::now() + IDLE_TIMEOUT);
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
        if self.deadline.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                if self.answered { "idle timeout" } else { "handshake timeout" },
            )));
        }
        let before = buf.filled().len();
        let read = Pin::new(&mut self.inner).poll_read(cx, buf);
        if self.answered && matches!(read, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.rearm_idle();
        }
        read
    }
}

impl AsyncWrite for GuardedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let written = Pin::new(&mut self.inner).poll_write(cx, buf);
        // The server has answered, so this is a real client: the handshake
        // deadline gives way to the idle one, which every byte re-arms.
        if matches!(written, Poll::Ready(Ok(_))) {
            self.answered = true;
            self.rearm_idle();
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
            self.answered = true;
            self.rearm_idle();
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

    // The first exchange runs on the real clock: a paused clock auto-advances
    // whenever the runtime waits on socket I/O, so the handshake deadline could
    // fire before `hello` arrives (it did, on macOS CI). The clock is paused
    // only once the server has answered, for the long idle.
    #[tokio::test]
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
        tokio::time::pause();
        let mut rest = [0u8; 4];
        stream.read_exact(&mut rest).await.expect("still open");
        assert_eq!(&rest, b"more");
        client.await.expect("client task").expect("client write");
    }

    // Same shape as the test above: real clock for the exchange, paused for
    // the idle. A client that answered once and then held the socket open
    // without a byte used to keep its permit until the kernel gave up on it.
    #[tokio::test]
    async fn an_answered_connection_that_falls_silent_is_closed_after_the_idle_window() {
        use axum::serve::Listener;
        let (mut guarded, address) = listener().await;
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.expect("connect");
            stream.write_all(b"hello").await.expect("write");
            let mut buffer = [0u8; 2];
            let _ = stream.read_exact(&mut buffer).await;
            // Then hold the socket open and say nothing, ever.
            let mut rest = [0u8; 1];
            let _ = stream.read(&mut rest).await;
        });
        let (mut stream, _) = guarded.accept().await;
        let mut buffer = [0u8; 5];
        stream.read_exact(&mut buffer).await.expect("read request");
        stream.write_all(b"ok").await.expect("respond");
        tokio::time::pause();
        let started = tokio::time::Instant::now();
        let mut rest = [0u8; 4];
        let error = stream.read(&mut rest).await.expect_err("idle timeout");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= IDLE_TIMEOUT);
        // Well past the handshake window, which no longer applies here.
        assert!(started.elapsed() > HANDSHAKE_TIMEOUT * 4);
        drop(stream);
        client.abort();
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
