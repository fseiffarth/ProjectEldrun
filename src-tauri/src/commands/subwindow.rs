//! Detached subwindow commands (#42).
//!
//! A tiling subwindow (a tab group) is "popped out" into its own borderless
//! Tauri `WebviewWindow` rendering the same React bundle under a
//! `?detached=<project>:<group>` query. The detached window is registered as a
//! project-owned `TrackedWindow` (origin `detached_subwindow`) and its resolved
//! native id (X11 window on Linux, HWND on Windows) is opted into the workspace
//! backend's parkable override, so the existing `project_runtime::switch`
//! hide/show path parks it when its project goes inactive and re-shows it on
//! switch-back — no parallel parking path.
//!
//! Persistence is session-only: a detached group re-docks into the main layout
//! on restart (no OS-window respawn). The MAIN window owns project.json writes;
//! the detached window never persists.

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, PhysicalSize, State, WebviewWindowBuilder, WebviewUrl};

use crate::commands::apps::{TrackedWindow, WindowRegistryState, ORIGIN_DETACHED_SUBWINDOW};
use crate::commands::workspace::WorkspaceStateArc;

/// Stable Tauri window label for a detached group. One window per (project,
/// group); the label is also how `attach_subwindow` finds the window to close.
pub fn detached_label(scope: &str, group_id: &str) -> String {
    format!("detached-{scope}-{group_id}")
}

/// Unique `_NET_WM_NAME` title for a detached window — the resolver in
/// `platform::x11::find_window_for_title` matches on this exact string. The
/// embedded `scope:group` avoids title collisions across detached windows.
pub fn detached_title(scope: &str, group_id: &str) -> String {
    format!("Eldrun — {scope} — {group_id}")
}

/// The query string the DetachedApp renderer reads to mount a single group.
pub fn detached_query(scope: &str, group_id: &str) -> String {
    format!("index.html?detached={scope}:{group_id}")
}

/// Pop a tab group out into its own borderless OS window bound to `project_id`.
///
/// Resolves the window's native id *before returning* so the
/// registry always carries a `window_id` before the window is usable — an
/// unresolved id would float across projects until resolved (reviewer Finding 7).
/// Returns the registry id the frontend uses to later dock it back.
#[tauri::command]
pub fn detach_subwindow(
    app: AppHandle,
    workspace: State<'_, WorkspaceStateArc>,
    win_registry: State<'_, WindowRegistryState>,
    project_id: String,
    group_id: String,
    // Optional restore geometry (physical px). When all four are present (a popout
    // re-opened on restart), the window is placed/sized to its prior bounds;
    // otherwise it opens at the default size, WM-placed.
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    let label = detached_label(&project_id, &group_id);
    let title = detached_title(&project_id, &group_id);

    // If a window with this label already exists, treat the call as idempotent.
    if app.get_webview_window(&label).is_some() {
        return Ok(label);
    }

    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(detached_query(&project_id, &group_id).into()),
    )
    .title(&title)
    .decorations(false);
    // Windows: a freshly runtime-created WebView2 window commonly presents a blank
    // WHITE surface until it is shown/focused or genuinely resized — and the rapid
    // +1/-1px resize nudge that fixes the analogous BLACK WebKitGTK surface tends
    // to coalesce without a repaint here. Build it HIDDEN and reveal it once the
    // webview has initialized (the deferred thread below): toggling visibility
    // forces WebView2's first composite. Linux keeps building visible so the X11
    // title-based id resolver can find the mapped window.
    #[cfg(target_os = "windows")]
    {
        builder = builder.visible(false);
    }
    match (width, height) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => {
            builder = builder.inner_size(w, h);
        }
        _ => {
            builder = builder.inner_size(900.0, 640.0);
        }
    }
    if let (Some(x), Some(y)) = (x, y) {
        builder = builder.position(x, y);
    }
    builder
        .build()
        .map_err(|e| format!("build detached window: {e}"))?;

    // Resolve the native window id so the switch path can park this popout. On
    // X11 we match the unique title (bypasses the protected filter); on Windows
    // we read the HWND straight off the Tauri window by its label.
    let window_id = resolve_detached_window_id(&app, &label, &title);

    if let Some(wid) = window_id {
        // Opt the detached window into the parkable override so the switch path
        // can actually park it despite its `eldrun` WM_CLASS. The MAIN window id
        // can never enter this set (structural guard in the backend).
        workspace.lock().unwrap().backend.set_parkable(wid);
    }

    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let win = TrackedWindow {
        id: label.clone(),
        exec: "eldrun-detached".to_string(),
        file: None,
        pid: std::process::id(),
        project_id: Some(project_id),
        role: Some(group_id),
        opened_at,
        window_id,
        origin: ORIGIN_DETACHED_SUBWINDOW.to_string(),
    };
    win_registry
        .lock()
        .unwrap()
        .windows
        .insert(label.clone(), win);

    // Force the detached webview's first paint shortly after creation, deferred on
    // a thread so the webview has mounted. The window stays mapped throughout, so
    // the X11 id resolved above remains valid.
    //
    // - Linux/WebKitGTK: a freshly-created second webview presents an unpainted
    //   (BLACK) GL surface until a real OS-level size change forces the compositor
    //   to allocate and paint it — the main window only avoids this because its
    //   startup fullscreen transition is itself such a resize. The borderless
    //   detached window gets no such resize, so nudge its size by 1px and back.
    // - Windows/WebView2: the same window instead presents a blank WHITE surface
    //   and the resize nudge is unreliable (rapid +1/-1 resizes coalesce without a
    //   repaint). The window was built HIDDEN above; show()+set_focus() here
    //   toggles WebView2's visibility, which forces the first composite. The resize
    //   nudge is kept as a belt-and-suspenders kick.
    let nudge_app = app.clone();
    let nudge_label = label.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if let Some(w) = nudge_app.get_webview_window(&nudge_label) {
            #[cfg(target_os = "windows")]
            {
                let _ = w.show();
                let _ = w.set_focus();
            }
            if let Ok(sz) = w.inner_size() {
                let _ = w.set_size(PhysicalSize::new(sz.width + 1, sz.height));
                std::thread::sleep(std::time::Duration::from_millis(50));
                let _ = w.set_size(sz);
            }
        }
    });

    Ok(label)
}

/// Close a detached subwindow and remove it from the registry + parkable
/// override. Idempotent: a missing window/registry entry is not an error (the
/// group still docks back in the frontend store).
#[tauri::command]
pub fn attach_subwindow(
    app: AppHandle,
    workspace: State<'_, WorkspaceStateArc>,
    win_registry: State<'_, WindowRegistryState>,
    registry_id: String,
) -> Result<(), String> {
    // Drop the parkable override first so a stray park can't target a closing id.
    let removed = win_registry.lock().unwrap().windows.remove(&registry_id);
    if let Some(win) = removed {
        if let Some(wid) = win.window_id {
            workspace.lock().unwrap().backend.unset_parkable(wid);
        }
    }
    if let Some(window) = app.get_webview_window(&registry_id) {
        // `destroy()` (not `close()`) so the removal is immediate: `close()` fires
        // the detached window's `onCloseRequested`, which preventDefaults and waits
        // out a 1500ms dock-back grace — leaving the popout visible alongside the
        // freshly-docked group for ~1s. `destroy()` bypasses that handler entirely.
        let _ = window.destroy();
    }
    Ok(())
}

/// Whether the detached window registered under `registry_id` is the front-most
/// window at the current pointer location. The frontend calls this on a file
/// drop that lands over a popout's bounds: if the popout is occluded (behind the
/// main window or another app) it is NOT at front, so the drop must open a new
/// window instead of merging into a window the user can't see (#42).
///
/// Defaults to `true` (allow the merge) when the popout has no resolved X11 id
/// or on non-Linux, so a missing occlusion signal never suppresses a legit dock.
#[tauri::command]
pub fn detached_window_frontmost(
    win_registry: State<'_, WindowRegistryState>,
    registry_id: String,
) -> bool {
    let wid = win_registry
        .lock()
        .unwrap()
        .windows
        .get(&registry_id)
        .and_then(|w| w.window_id);
    match wid {
        None => true,
        Some(wid) => {
            #[cfg(target_os = "linux")]
            {
                crate::platform::x11::frontmost_window_under_pointer()
                    .map(|top| top == wid)
                    .unwrap_or(false)
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = wid;
                true
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn resolve_detached_window_id(_app: &AppHandle, _label: &str, title: &str) -> Option<u64> {
    crate::platform::x11::find_window_for_title(title, 20)
}

/// Windows: read the popout's HWND directly from the Tauri window by its stable
/// label (more robust than title enumeration, and the window is already built),
/// so the parkable override (#42) is reachable on Windows too — not X11-only.
#[cfg(target_os = "windows")]
fn resolve_detached_window_id(app: &AppHandle, label: &str, _title: &str) -> Option<u64> {
    let win = app.get_webview_window(label)?;
    let hwnd = win.hwnd().ok()?;
    Some(hwnd.0 as usize as u64)
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn resolve_detached_window_id(_app: &AppHandle, _label: &str, _title: &str) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_and_title_embed_scope_and_group() {
        assert_eq!(detached_label("p1", "g-3"), "detached-p1-g-3");
        assert_eq!(detached_title("p1", "g-3"), "Eldrun — p1 — g-3");
        // Different groups produce different titles (no collision).
        assert_ne!(detached_title("p1", "g-3"), detached_title("p1", "g-4"));
        assert_ne!(detached_title("p1", "g-3"), detached_title("p2", "g-3"));
    }

    #[test]
    fn query_carries_the_detached_param() {
        assert_eq!(detached_query("p1", "g-3"), "index.html?detached=p1:g-3");
        assert_eq!(detached_query("root", "g-1"), "index.html?detached=root:g-1");
    }
}
