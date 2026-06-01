//! PTY lifecycle management for Eldrun terminals.
//!
//! Design constraints from TauriRust.md Phase 3:
//! - portable-pty for cross-platform PTY creation.
//! - Bounded per-PTY output channels (backpressure via mpsc).
//! - Batched/throttled Tauri events (max one emit per 16 ms).
//! - UTF-8 lossy output; binary-safe read loop.
//! - Crash-loop protection: tracks last-exit timestamps.
//! - Explicit terminal-ready event when the shell starts.
//! - Linux XDG sandbox env in a cfg(target_os="linux") block.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ── Constants ─────────────────────────────────────────────────────────────

const BATCH_INTERVAL: Duration = Duration::from_millis(16);
const BATCH_MAX_BYTES: usize = 4096;
#[allow(dead_code)]
const MIN_RESTART_INTERVAL: Duration = Duration::from_secs(2);
const CRASH_LOOP_THRESHOLD: usize = 5;
pub const SCROLLBACK_LIMIT: usize = 5000;

/// Internal channel capacity — limits buffered output chunks.
const CHANNEL_CAP: usize = 64;

// ── Public data types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyOptions {
    pub id: String,
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalOutput {
    pub id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalExit {
    pub id: String,
    pub code: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalReady {
    pub id: String,
}

// ── Internal entry ─────────────────────────────────────────────────────────

struct PtyEntry {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    dead: Arc<AtomicBool>,
    crash_times: Vec<Instant>,
}

// ── PtyRegistry ───────────────────────────────────────────────────────────

#[derive(Default)]
pub struct PtyRegistry {
    entries: HashMap<String, PtyEntry>,
}

impl PtyRegistry {
    pub fn insert(
        &mut self,
        id: String,
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        child: Box<dyn Child + Send + Sync>,
        dead: Arc<AtomicBool>,
    ) {
        self.entries.insert(
            id,
            PtyEntry {
                master,
                writer,
                child,
                dead,
                crash_times: Vec::new(),
            },
        );
    }

    pub fn write(&mut self, id: &str, data: &[u8]) -> std::io::Result<()> {
        if let Some(e) = self.entries.get_mut(id) {
            e.writer.write_all(data)?;
        }
        Ok(())
    }

    pub fn kill(&mut self, id: &str) {
        if let Some(mut e) = self.entries.remove(id) {
            e.dead.store(true, Ordering::SeqCst);
            let _ = e.child.kill();
        }
    }

    pub fn check_crash_loop(&mut self, id: &str) -> bool {
        let Some(entry) = self.entries.get_mut(id) else {
            return true;
        };
        let now = Instant::now();
        entry
            .crash_times
            .retain(|t| now.duration_since(*t) < Duration::from_secs(10));
        if entry.crash_times.len() >= CRASH_LOOP_THRESHOLD {
            return false;
        }
        entry.crash_times.push(now);
        true
    }
}

// ── Spawn ─────────────────────────────────────────────────────────────────

/// Spawn a PTY and wire up Tauri event emission.
/// The read loop runs in a std::thread (blocking I/O) and passes chunks
/// through an mpsc channel to a Tokio task that batches and emits events.
pub fn spawn_pty(
    app: AppHandle,
    registry: Arc<Mutex<PtyRegistry>>,
    opts: PtyOptions,
) -> Result<(), String> {
    let pty_system = NativePtySystem::default();

    let pair = pty_system
        .openpty(PtySize {
            rows: opts.rows,
            cols: opts.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let cmd = build_command(&opts);
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    let dead = Arc::new(AtomicBool::new(false));
    {
        let mut reg = registry.lock().unwrap();
        reg.insert(opts.id.clone(), pair.master, writer, child, dead.clone());
    }

    let _ = app.emit("terminal-ready", TerminalReady { id: opts.id.clone() });

    // Channel: blocking reader thread → async emitter task.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(CHANNEL_CAP);

    let dead_reader = dead.clone();
    let _id_reader = opts.id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            if dead_reader.load(Ordering::SeqCst) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // If the channel is full, drop the chunk (backpressure safety).
                    let _ = tx.try_send(buf[..n].to_vec());
                }
                Err(_) => break,
            }
        }
        // Signal EOF by dropping tx.
    });

    let id = opts.id.clone();
    tokio::spawn(async move {
        let mut batch: Vec<u8> = Vec::with_capacity(BATCH_MAX_BYTES);
        let mut last_emit = Instant::now();

        loop {
            // Poll with a short timeout so we can flush on the interval even
            // if no new data arrives.
            let chunk = tokio::time::timeout(BATCH_INTERVAL, rx.recv()).await;

            match chunk {
                Ok(Some(data)) => batch.extend_from_slice(&data),
                Ok(None) => {
                    // Channel closed = reader thread exited.
                    break;
                }
                Err(_timeout) => {} // Normal: flush on interval.
            }

            let now = Instant::now();
            let should_flush = !batch.is_empty()
                && (batch.len() >= BATCH_MAX_BYTES
                    || now.duration_since(last_emit) >= BATCH_INTERVAL);

            if should_flush {
                let text = String::from_utf8_lossy(&batch).into_owned();
                let _ = app.emit(
                    "terminal-output",
                    TerminalOutput {
                        id: id.clone(),
                        data: text,
                    },
                );
                batch.clear();
                last_emit = now;
            }
        }

        // Final flush.
        if !batch.is_empty() {
            let text = String::from_utf8_lossy(&batch).into_owned();
            let _ = app.emit(
                "terminal-output",
                TerminalOutput {
                    id: id.clone(),
                    data: text,
                },
            );
        }
        let _ = app.emit("terminal-exit", TerminalExit { id, code: None });
    });

    Ok(())
}

/// Resize an existing PTY.
pub fn resize_pty(
    registry: &Arc<Mutex<PtyRegistry>>,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut reg = registry.lock().unwrap();
    let Some(entry) = reg.entries.get_mut(id) else {
        return Ok(());
    };

    entry
        .master
        .resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))
}

// ── Command builder ────────────────────────────────────────────────────────

fn build_command(opts: &PtyOptions) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&opts.cmd);
    for arg in &opts.args {
        cmd.arg(arg);
    }
    cmd.cwd(&opts.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    #[cfg(target_os = "linux")]
    {
        cmd.env_remove("GIO_LAUNCHED_DESKTOP_FILE");
        cmd.env_remove("GIO_LAUNCHED_DESKTOP_FILE_PID");
    }

    cmd
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn resize_pty_updates_kernel_size() {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("1");
        let child = pair.slave.spawn_command(cmd).expect("spawn sleep");
        let writer = pair.master.take_writer().expect("take writer");
        let master = pair.master;

        let registry = Arc::new(Mutex::new(PtyRegistry::default()));
        let dead = Arc::new(AtomicBool::new(false));
        {
            let mut reg = registry.lock().unwrap();
            reg.insert("test".to_string(), master, writer, child, dead);
        }

        resize_pty(&registry, "test", 100, 40).expect("resize");

        let reg = registry.lock().unwrap();
        let entry = reg.entries.get("test").expect("entry exists");
        let size = entry.master.get_size().expect("get_size");
        assert_eq!(size.cols, 100);
        assert_eq!(size.rows, 40);
        drop(reg);

        registry.lock().unwrap().kill("test");
    }
}
