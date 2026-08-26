use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::mpsc;

use super::protocol::{
    TerminalControl, TerminalEvent, MAX_COLS, MAX_INPUT_FRAME, MAX_OUTPUT_QUEUE, MAX_ROWS,
    MIN_COLS, MIN_ROWS,
};
use super::{auth::AuthStore, discovery::CatalogCache};

#[derive(Clone, Default)]
pub struct TerminalRegistry {
    busy: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

struct BusyGuard {
    name: String,
    evicted: Arc<AtomicBool>,
    busy: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}
impl BusyGuard {
    fn evicted(&self) -> bool {
        self.evicted.load(Ordering::Acquire)
    }
}
impl Drop for BusyGuard {
    fn drop(&mut self) {
        let mut busy = self.busy.lock().unwrap();
        // Only clear the slot if it is still ours: an evicting acquire may
        // already have installed its own flag under this name.
        if busy
            .get(&self.name)
            .is_some_and(|flag| Arc::ptr_eq(flag, &self.evicted))
        {
            busy.remove(&self.name);
        }
    }
}

/// How long a reconnecting viewer waits for the previous one to notice it has
/// been evicted. The incumbent checks on its one-second authorization tick.
const EVICTION_WAIT: std::time::Duration = std::time::Duration::from_millis(2_500);

impl TerminalRegistry {
    pub fn is_busy(&self, name: &str) -> bool {
        self.busy.lock().unwrap().contains_key(name)
    }

    /// Claims the tab, displacing an existing viewer if there is one.
    ///
    /// A phone that is backgrounded before its `detached` frame flushes leaves
    /// the slot held until the 60-second idle reaper fires, and the user was
    /// locked out of their own agent for up to a minute after glancing at
    /// another app. The newest viewer wins instead.
    async fn acquire(&self, name: &str) -> Result<BusyGuard, String> {
        let deadline = tokio::time::Instant::now() + EVICTION_WAIT;
        loop {
            {
                let mut busy = self.busy.lock().unwrap();
                match busy.get(name) {
                    None => {
                        let evicted = Arc::new(AtomicBool::new(false));
                        busy.insert(name.to_string(), evicted.clone());
                        return Ok(BusyGuard {
                            name: name.into(),
                            evicted,
                            busy: self.busy.clone(),
                        });
                    }
                    Some(incumbent) => incumbent.store(true, Ordering::Release),
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("session_busy".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
}

fn tmux_attach_command(tmux_name: &str) -> CommandBuilder {
    let mut command = CommandBuilder::new("tmux");
    // `-u` forces UTF-8. The sidecar is a headless systemd user service with no
    // guaranteed LANG/LC_CTYPE, and a non-UTF-8 tmux client replaces every
    // `✓ ✗ ⚠ ● ⏺ └ ❯` — the exact glyphs the reading view classifies on — so the
    // whole structured view would silently degrade to undifferentiated prose.
    command.args(["-u", "attach-session", "-t", tmux_name]);
    // The mobile host normally runs as a headless systemd user service and
    // therefore has no useful inherited TERM. `vt100` has the cursor/clear
    // capabilities tmux requires *without* `smcup`: xterm's normal buffer is
    // deliberately retained so the replayed tmux history is scrollable. This
    // describes only tmux's outer client; panes retain their own TERM.
    command.env("TERM", "vt100");
    command.env("COLORTERM", "truecolor");
    command
}

/// A tmux attach only redraws its current screen. Capture the pane first so a
/// phone's xterm buffer actually contains the shell history it is asked to
/// scroll. Keep this equal to the browser terminal's `scrollback` setting.
const MOBILE_SCROLLBACK_LINES: usize = 4_000;

fn tmux_capture_command(tmux_name: &str) -> Command {
    let mut command = Command::new("tmux");
    command.args([
        "-u",
        "capture-pane",
        "-p",
        "-e",
        "-J",
        "-S",
        &format!("-{MOBILE_SCROLLBACK_LINES}"),
        // Stop one line above the visible screen. Without `-E`, capture ends at
        // the bottom of the *visible* pane, so the attach that follows redrew
        // that same screen and the phone appended a second copy of it on every
        // reconnect. `-J` joins tmux-side wrapped lines so the replay arrives as
        // the logical lines the process actually emitted.
        "-E",
        "-1",
        "-t",
        tmux_name,
    ]);
    command
}

/// The tmux *window* geometry, which is what the pane is actually rendered at.
fn tmux_window_size_command(tmux_name: &str) -> Command {
    let mut command = Command::new("tmux");
    command.args([
        "-u",
        "display-message",
        "-p",
        "-t",
        tmux_name,
        "#{window_width}x#{window_height}",
    ]);
    command
}

fn parse_window_size(raw: &str) -> Option<(u16, u16)> {
    let (cols, rows) = raw.trim().split_once('x')?;
    let cols: u16 = cols.trim().parse().ok()?;
    let rows: u16 = rows.trim().parse().ok()?;
    if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
        return None;
    }
    Some((cols, rows))
}

/// `window-size largest` sizes a window to the widest attached client, and tmux
/// then *pans* any smaller client across it — so a phone fitted to its own
/// viewport received a ~44-column moving slice of a ~180-column pane with every
/// line silently truncated. The phone adopts the window geometry instead: its
/// xterm is an offscreen emulator whose column count never had to match the
/// physical screen, and the reading view re-wraps for display.
fn window_size(tmux_name: &str) -> Option<(u16, u16)> {
    let output = tmux_window_size_command(tmux_name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_window_size(&String::from_utf8_lossy(&output.stdout))
}

/// How often the window geometry is re-checked. The desktop can widen the window
/// at any time, which would silently reintroduce the pan.
const WINDOW_POLL: std::time::Duration = std::time::Duration::from_secs(5);

fn captured_scrollback(tmux_name: &str) -> Vec<u8> {
    let Ok(output) = tmux_capture_command(tmux_name).output() else {
        return Vec::new();
    };
    if !output.status.success() || output.stdout.is_empty() {
        return Vec::new();
    }
    normalize_scrollback(output.stdout)
}

fn normalize_scrollback(output: Vec<u8>) -> Vec<u8> {
    // `capture-pane -p` writes Unix newlines. xterm's ordinary output uses
    // CRLF; without the CR, lines retain the previous column and a wrapped
    // history becomes unreadable. Preserve any CR that is already present.
    let mut history = Vec::with_capacity(output.len() + 1);
    let mut previous_was_cr = false;
    for byte in output {
        if byte == b'\n' && !previous_was_cr {
            history.push(b'\r');
        }
        history.push(byte);
        previous_was_cr = byte == b'\r';
    }
    if !history.ends_with(b"\n") {
        if !history.ends_with(b"\r") {
            history.push(b'\r');
        }
        history.push(b'\n');
    }
    history
}

/// Every exit from the loop below must kill the tmux client and unblock the
/// reader thread. Two `?` operators used to return past that cleanup, leaking a
/// process, a PTY pair and a blocking-pool thread per malformed control frame —
/// enough of them exhausts the pool and wedges the terminal for every device.
struct PtySession {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    output_task: tokio::task::JoinHandle<()>,
    window_task: tokio::task::JoinHandle<()>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Kill and reap first. The reader is parked in a blocking read on a
        // cloned master fd, so it unblocks only once the child is gone and the
        // remaining write ends close; `abort()` cannot interrupt a blocking task.
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.output_task.abort();
        self.window_task.abort();
    }
}

pub async fn attach(
    socket: WebSocket,
    tmux_name: String,
    registry: TerminalRegistry,
    auth: Arc<Mutex<AuthStore>>,
    token: String,
    state_dir: PathBuf,
    tab_id: String,
    catalog: Arc<Mutex<CatalogCache>>,
) -> Result<(), String> {
    let guard = registry.acquire(&tmux_name).await?;
    // Do this before the live attach starts redrawing. The browser receives it
    // before every PTY byte below, and tmux's clear/redraw then leaves these
    // lines in xterm's normal scrollback buffer above the live screen. The
    // geometry probe rides along in the same blocking hop.
    let probe_name = tmux_name.clone();
    let (history, initial_window) =
        tokio::task::spawn_blocking(move || (captured_scrollback(&probe_name), window_size(&probe_name)))
            .await
            .unwrap_or_default();
    // Open at the real window size so the very first redraw is already correctly
    // shaped, instead of a guaranteed mis-sized 24x80 frame on every attach.
    let (open_cols, open_rows) = initial_window.unwrap_or((80, 24));
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: open_rows,
            cols: open_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let command = tmux_attach_command(&tmux_name);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = pair.master;
    const OUTPUT_CHUNK: usize = 16 * 1024;
    let (output_tx, mut output_rx) = mpsc::channel::<Vec<u8>>(MAX_OUTPUT_QUEUE / OUTPUT_CHUNK);
    let output_backpressure = Arc::new(AtomicBool::new(false));
    let reader_backpressure = output_backpressure.clone();
    let output_task = tokio::task::spawn_blocking(move || loop {
        let mut bytes = vec![0; OUTPUT_CHUNK];
        let Ok(read) = reader.read(&mut bytes) else {
            break;
        };
        if read == 0 {
            break;
        }
        bytes.truncate(read);
        if output_tx.try_send(bytes).is_err() {
            reader_backpressure.store(true, Ordering::Release);
            break;
        }
    });
    // The desktop can widen the window at any moment, which would silently start
    // panning the phone again. Poll it off the main loop so the fork never
    // stalls output delivery.
    let (window_tx, mut window_rx) = mpsc::channel::<(u16, u16)>(1);
    let window_name = tmux_name.clone();
    let window_task = tokio::spawn(async move {
        let mut last = initial_window;
        let mut tick = tokio::time::interval(WINDOW_POLL);
        tick.tick().await;
        loop {
            tick.tick().await;
            let probe = window_name.clone();
            let Ok(size) = tokio::task::spawn_blocking(move || window_size(&probe)).await else {
                break;
            };
            let Some(size) = size else { continue };
            if last == Some(size) {
                continue;
            }
            last = Some(size);
            if window_tx.send(size).await.is_err() {
                break;
            }
        }
    });
    let session = PtySession {
        child,
        output_task,
        window_task,
    };
    let (mut ws_tx, mut ws_rx) = socket.split();
    // An explicit replay boundary. The client keeps its last rendered screen
    // while reconnecting, so without this marker the replayed history and the
    // attach redraw were appended to it — one extra copy of the session per
    // reconnect, which on a flaky link made one agent turn look like several.
    let mut opening = vec![TerminalEvent::Replay.to_frame()];
    if let Some((cols, rows)) = initial_window {
        opening.push(TerminalEvent::Window { cols, rows }.to_frame());
    }
    for frame in opening {
        if ws_tx.send(Message::Text(frame.into())).await.is_err() {
            return Ok(());
        }
    }
    if !history.is_empty() && ws_tx.send(Message::Binary(history.into())).await.is_err() {
        return Ok(());
    }
    let mut authorization_tick = tokio::time::interval(std::time::Duration::from_secs(1));
    let mut last_client_message = std::time::Instant::now();
    let result: Result<(), String> = loop {
        tokio::select! {
            _ = authorization_tick.tick() => {
                if guard.evicted() { break Err("replaced".into()); }
                if last_client_message.elapsed() > std::time::Duration::from_secs(60) {
                    break Err("idle_timeout".into());
                }
                let (authorized, key) = {
                    let mut auth = auth.lock().unwrap();
                    (auth.authenticate(&token).is_some(), auth.host_key().to_vec())
                };
                let still_allowed = authorized && catalog.lock().unwrap().load(&state_dir, &key).ok()
                    .and_then(|catalog| catalog.tab(&tab_id).map(|(_, tab)| tab.public.available && tab.tmux_name == tmux_name))
                    .unwrap_or(false);
                if !still_allowed { break Err("access_revoked".into()); }
            }
            Some((cols, rows)) = window_rx.recv() => {
                if ws_tx.send(Message::Text(TerminalEvent::Window { cols, rows }.to_frame().into())).await.is_err() { break Ok(()); }
            }
            output = output_rx.recv() => match output {
                Some(bytes) => if ws_tx.send(Message::Binary(bytes.into())).await.is_err() { break Ok(()); },
                None => {
                    if output_backpressure.load(Ordering::Acquire) {
                        let _ = ws_tx.send(Message::Close(Some(CloseFrame {
                            code: 1013,
                            reason: "output_backpressure".into(),
                        }))).await;
                    }
                    break Ok(())
                },
            },
            incoming = ws_rx.next() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    last_client_message = std::time::Instant::now();
                    if bytes.len() > MAX_INPUT_FRAME { break Err("input_frame_too_large".into()); }
                    if writer.write_all(&bytes).is_err() || writer.flush().is_err() { break Ok(()); }
                }
                Some(Ok(Message::Text(text))) => {
                    last_client_message = std::time::Instant::now();
                    // `break`, never `?`: returning here would skip the cleanup
                    // that PtySession::drop performs.
                    let Ok(control) = serde_json::from_str::<TerminalControl>(&text) else {
                        break Err("invalid_terminal_control".into());
                    };
                    match control {
                        TerminalControl::Resize { cols, rows } => {
                            if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) { break Err("invalid_terminal_size".into()); }
                            if master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).is_err() {
                                break Err("resize_failed".into());
                            }
                        }
                        TerminalControl::Ping => { if ws_tx.send(Message::Text(TerminalEvent::Pong.to_frame().into())).await.is_err() { break Ok(()); } }
                        TerminalControl::Detached => break Ok(()),
                        TerminalControl::Ready => {}
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break Ok(()),
                _ => {}
            }
        }
    };
    // Tell the phone *why*. Without this every rejection arrived as a bare
    // close and was rendered as "reconnecting…" forever, including revocation.
    if let Err(reason) = &result {
        // `replaced` means another viewer took over; that client must not fight
        // its way back in a reconnect loop.
        let retry = reason == "idle_timeout";
        let frame = TerminalEvent::Closing {
            reason: reason.clone(),
            retry,
        }
        .to_frame();
        let _ = ws_tx.send(Message::Text(frame.into())).await;
    }
    // Kill first, then release the remaining write ends so the reader unblocks.
    drop(session);
    drop(writer);
    drop(master);
    result
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_scrollback, parse_window_size, tmux_attach_command, tmux_capture_command,
        tmux_window_size_command, MOBILE_SCROLLBACK_LINES,
    };
    use crate::services::mobile_control::protocol::TerminalEvent;
    use std::ffi::OsStr;

    #[tokio::test]
    async fn a_reconnecting_viewer_evicts_the_previous_one() {
        use super::TerminalRegistry;
        let registry = TerminalRegistry::default();
        let first = registry.acquire("eldrun-p--agent-1").await.expect("first");
        assert!(registry.is_busy("eldrun-p--agent-1"));
        assert!(!first.evicted());
        let waiter = {
            let registry = registry.clone();
            tokio::spawn(async move { registry.acquire("eldrun-p--agent-1").await })
        };
        // The incumbent is asked to leave; releasing hands the slot over.
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        assert!(first.evicted(), "incumbent should have been signalled");
        drop(first);
        let second = waiter.await.expect("join").expect("second viewer");
        assert!(!second.evicted());
        assert!(registry.is_busy("eldrun-p--agent-1"));
        drop(second);
        assert!(!registry.is_busy("eldrun-p--agent-1"));
    }

    #[tokio::test]
    async fn an_incumbent_that_never_leaves_still_yields_session_busy() {
        use super::TerminalRegistry;
        let registry = TerminalRegistry::default();
        let _held = registry.acquire("eldrun-p--agent-2").await.expect("first");
        match registry.acquire("eldrun-p--agent-2").await {
            Ok(_) => panic!("a held slot must not be handed over"),
            Err(reason) => assert_eq!(reason, "session_busy"),
        }
    }

    #[test]
    fn tmux_attach_uses_a_non_alternate_screen_mobile_client() {
        let command = tmux_attach_command("eldrun-project--shell-test");
        assert_eq!(command.get_env("TERM"), Some(OsStr::new("vt100")));
        assert_eq!(command.get_env("COLORTERM"), Some(OsStr::new("truecolor")));
        assert_eq!(
            command.get_argv(),
            &["tmux", "-u", "attach-session", "-t", "eldrun-project--shell-test"].map(OsStr::new)
        );
    }

    #[test]
    fn tmux_capture_replays_the_same_depth_as_mobile_xterm() {
        let command = tmux_capture_command("eldrun-project--shell-test");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "-u",
                "capture-pane",
                "-p",
                "-e",
                "-J",
                "-S",
                &format!("-{MOBILE_SCROLLBACK_LINES}"),
                "-E",
                "-1",
                "-t",
                "eldrun-project--shell-test",
            ]
            .map(OsStr::new)
        );
    }

    #[test]
    fn capture_stops_above_the_visible_screen_the_attach_will_redraw() {
        let command = tmux_capture_command("eldrun-project--shell-test");
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        // Without `-E -1` the capture ends at the bottom of the visible pane and
        // the attach redraw duplicates that screen on every reconnect.
        let end = args.iter().position(|a| a == "-E").expect("-E");
        assert_eq!(args[end + 1], "-1");
    }

    #[test]
    fn window_size_is_probed_from_the_window_not_the_client() {
        let command = tmux_window_size_command("eldrun-project--shell-test");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "-u",
                "display-message",
                "-p",
                "-t",
                "eldrun-project--shell-test",
                "#{window_width}x#{window_height}",
            ]
            .map(OsStr::new)
        );
    }

    #[test]
    fn window_sizes_outside_the_protocol_range_are_rejected() {
        assert_eq!(parse_window_size("180x48\n"), Some((180, 48)));
        assert_eq!(parse_window_size(" 80x24 "), Some((80, 24)));
        assert_eq!(parse_window_size("0x24"), None);
        assert_eq!(parse_window_size("4000x24"), None);
        assert_eq!(parse_window_size("180"), None);
        assert_eq!(parse_window_size(""), None);
        assert_eq!(parse_window_size("axb"), None);
    }

    #[test]
    fn terminal_events_serialize_as_the_client_expects() {
        assert_eq!(TerminalEvent::Pong.to_frame(), r#"{"type":"pong"}"#);
        assert_eq!(TerminalEvent::Replay.to_frame(), r#"{"type":"replay"}"#);
        assert_eq!(
            TerminalEvent::Window { cols: 180, rows: 48 }.to_frame(),
            r#"{"type":"window","cols":180,"rows":48}"#
        );
        assert_eq!(
            TerminalEvent::Closing { reason: "access_revoked".into(), retry: false }.to_frame(),
            r#"{"type":"closing","reason":"access_revoked","retry":false}"#
        );
    }

    #[test]
    fn captured_scrollback_uses_terminal_line_endings() {
        assert_eq!(
            normalize_scrollback(b"one\ntwo\r\nthree".to_vec()),
            b"one\r\ntwo\r\nthree\r\n"
        );
    }
}
