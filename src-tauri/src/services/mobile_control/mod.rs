//! Eldrun Mobile's AppHandle-free control plane.
//!
//! The sidecar reads only the state-dir project/session snapshots, resolves all
//! client ids through a keyed catalog, and attaches only to exact tmux sessions
//! discovered locally. Tauri-specific lifecycle and event routing live in
//! `commands::mobile_control`.

pub mod admin;
pub mod auth;
pub mod config;
pub mod discovery;
pub mod host;
pub mod protocol;
pub mod pty_bridge;
pub mod store;
