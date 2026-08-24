use std::{
    collections::HashSet,
    io::{Read, Write},
    path::PathBuf,
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
    TerminalControl, MAX_COLS, MAX_INPUT_FRAME, MAX_OUTPUT_QUEUE, MAX_ROWS, MIN_COLS, MIN_ROWS,
};
use super::{auth::AuthStore, discovery::CatalogCache};

#[derive(Clone, Default)]
pub struct TerminalRegistry {
    busy: Arc<Mutex<HashSet<String>>>,
}

struct BusyGuard {
    name: String,
    busy: Arc<Mutex<HashSet<String>>>,
}
impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.busy.lock().unwrap().remove(&self.name);
    }
}

impl TerminalRegistry {
    pub fn is_busy(&self, name: &str) -> bool {
        self.busy.lock().unwrap().contains(name)
    }

    fn acquire(&self, name: &str) -> Result<BusyGuard, String> {
        let mut busy = self.busy.lock().unwrap();
        if !busy.insert(name.to_string()) {
            return Err("session_busy".into());
        }
        Ok(BusyGuard {
            name: name.into(),
            busy: self.busy.clone(),
        })
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
    let _guard = registry.acquire(&tmux_name)?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let mut command = CommandBuilder::new("tmux");
    command.args(["attach-session", "-t", &tmux_name]);
    let mut child = pair
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
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut authorization_tick = tokio::time::interval(std::time::Duration::from_secs(1));
    let mut last_client_message = std::time::Instant::now();
    let result = loop {
        tokio::select! {
            _ = authorization_tick.tick() => {
                if last_client_message.elapsed() > std::time::Duration::from_secs(60) { break Ok(()); }
                let (authorized, key) = {
                    let mut auth = auth.lock().unwrap();
                    (auth.authenticate(&token).is_some(), auth.host_key().to_vec())
                };
                let still_allowed = authorized && catalog.lock().unwrap().load(&state_dir, &key).ok()
                    .and_then(|catalog| catalog.tab(&tab_id).map(|(_, tab)| tab.public.available && tab.tmux_name == tmux_name))
                    .unwrap_or(false);
                if !still_allowed { break Ok(()); }
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
                    let control: TerminalControl = serde_json::from_str(&text).map_err(|_| "invalid_terminal_control")?;
                    match control {
                        TerminalControl::Resize { cols, rows } => {
                            if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) { break Err("invalid_terminal_size".into()); }
                            master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
                        }
                        TerminalControl::Ping => { if ws_tx.send(Message::Text("{\"type\":\"pong\"}".into())).await.is_err() { break Ok(()); } }
                        TerminalControl::Detached => break Ok(()),
                        TerminalControl::Ready => {}
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break Ok(()),
                _ => {}
            }
        }
    };
    let _ = child.kill();
    output_task.abort();
    result
}
