//! The deck presenter's **audience window** (TODO M#90, `docs/deck_presenter_plan.md`).
//!
//! A talk wants two surfaces: the slide the room sees, and the notes/timer the
//! speaker sees. The second one is an OS window rendering the same React bundle
//! under `?present=<label>`, which the frontend drives entirely over Tauri events
//! (`src/lib/viewers/deck/present.ts`) — this module only opens it, puts it on
//! the right monitor, and closes it.
//!
//! Deliberately NOT a detached subwindow (#42): a popout is a tab group with a
//! layout, a seed protocol, dock-back, parking and persistence. None of that
//! applies here — an audience window has no tabs, must survive nothing, and above
//! all must **not be parked**: `project_runtime::switch` hides a project-owned
//! window when its project goes inactive, which mid-talk would blank the
//! projector. So it is registered nowhere and owned only by the presenter that
//! opened it.

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

/// A monitor's placement, in physical desktop px — the shape both the real
/// `tauri::Monitor` and the unit tests reduce to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// Whether `label` is one this command may open.
///
/// The label comes from the frontend and becomes both a window label and a URL
/// query value, so it is validated rather than trusted. The `present-` prefix is
/// also what `capabilities/default.json` grants window permissions by, so a
/// label outside this shape would open a window that cannot call anything.
pub fn valid_presenter_label(label: &str) -> bool {
    label.len() <= 64
        && label.starts_with("present-")
        && label.len() > "present-".len()
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The query the audience renderer reads.
pub fn presenter_query(label: &str) -> String {
    format!("index.html?present={label}")
}

/// Which monitor the audience window should take over, if any.
///
/// The whole point of the feature is "audience there, notes here", so a single
/// monitor yields `None` — the window then opens ordinary and windowed, which the
/// speaker can drag wherever they like. With two or more, take the first monitor
/// that is not the one the main window is on. `main` unknown falls back to the
/// *second* monitor rather than the first: the first is nearly always the
/// built-in panel the presenter is sitting at.
pub fn choose_audience_monitor(
    monitors: &[MonitorRect],
    main: Option<MonitorRect>,
) -> Option<MonitorRect> {
    if monitors.len() < 2 {
        return None;
    }
    match main {
        Some(m) => monitors
            .iter()
            .find(|c| (c.x, c.y) != (m.x, m.y))
            .copied()
            .or_else(|| monitors.get(1).copied()),
        None => monitors.get(1).copied(),
    }
}

/// Open (or focus) the audience window for a deck.
///
/// MUST be `async`, for the same reason `detach_subwindow` is: a synchronous
/// Tauri command runs on the main thread, and `WebviewWindowBuilder::build()` on
/// Windows blocks on the main-thread event loop pumping WebView2's controller
/// callback — which the in-flight sync command is itself blocking (wry#583 /
/// tauri#4121), surfacing as a blank window that never renders.
#[tauri::command]
pub async fn open_presenter_window(app: AppHandle, label: String) -> Result<String, String> {
    if !valid_presenter_label(&label) {
        return Err("invalid presenter window label".into());
    }

    // Idempotent: presenting the same deck twice re-uses (and re-focuses) the
    // window already on the projector rather than stacking a second one on it.
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
        return Ok(label);
    }

    let target = audience_monitor(&app);

    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(presenter_query(&label).into()),
    )
    .title("Eldrun — Presentation")
    // Decorated on purpose, unlike a popout: with one monitor this window is
    // dragged to a projector by hand, and a borderless window is awkward to move
    // and impossible to close if the renderer never seeds.
    .decorations(true);
    // LOGICAL default size only; any monitor geometry below is PHYSICAL and is
    // applied through the physical setters after the build.
    builder = builder.inner_size(960.0, 600.0);
    #[cfg(target_os = "windows")]
    {
        // Same first-paint story as the detached window: a fresh WebView2 surface
        // shows blank white until it is shown/focused, so build hidden and reveal
        // it in the deferred kick below.
        builder = builder.visible(false);
    }

    let win = builder
        .build()
        .map_err(|e| format!("build presenter window: {e}"))?;

    // Physical setters, never the builder's logical ones: a monitor's origin/size
    // are PHYSICAL px, and feeding those to a logical setter multiplies them by
    // the display scale — the bug that put a detached window off-screen on every
    // scaled display (#42).
    if let Some(m) = target {
        let _ = win.set_position(PhysicalPosition::new(m.x, m.y));
        let _ = win.set_size(PhysicalSize::new(m.w, m.h));
        // Fullscreen AFTER placing it, so the WM makes *that* monitor fullscreen
        // and not the one the window was born on.
        let _ = win.set_fullscreen(true);
    }

    // Force the first paint, deferred so the webview has mounted. Same two
    // platform quirks the detached path documents: WebKitGTK presents an
    // unpainted BLACK GL surface until a genuine OS-level resize, WebView2 a
    // blank WHITE one until it is shown/focused.
    let nudge_app = app.clone();
    let nudge_label = label.clone();
    std::thread::spawn(move || {
        let kick = |app: AppHandle, label: String, reveal: bool| {
            let app_main = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(w) = app_main.get_webview_window(&label) {
                    #[cfg(target_os = "windows")]
                    if reveal {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    // A fullscreen window must not be resized — that would drop it
                    // out of fullscreen. Showing/focusing is enough there, and on
                    // Linux the fullscreen transition is itself the resize that
                    // paints the surface.
                    if let Ok(false) = w.is_fullscreen() {
                        if let Ok(sz) = w.inner_size() {
                            let delta: i32 = if reveal { 1 } else { -1 };
                            let next = (sz.width as i32 + delta).max(1) as u32;
                            let _ = w.set_size(PhysicalSize::new(next, sz.height));
                        }
                    }
                }
            });
        };
        std::thread::sleep(std::time::Duration::from_millis(250));
        kick(nudge_app.clone(), nudge_label.clone(), true);
        std::thread::sleep(std::time::Duration::from_millis(50));
        kick(nudge_app, nudge_label, false);
    });

    Ok(label)
}

/// Close the audience window. Idempotent — a window already gone is the state the
/// caller wanted, so it is not an error (the presenter closes on unmount too,
/// which races the user closing it from the WM).
#[tauri::command]
pub fn close_presenter_window(app: AppHandle, label: String) -> Result<(), String> {
    if !valid_presenter_label(&label) {
        return Err("invalid presenter window label".into());
    }
    if let Some(win) = app.get_webview_window(&label) {
        // `destroy()`, not `close()`: `close()` fires the audience window's
        // `onCloseRequested`, which reports back that it went away — a message the
        // presenter that just asked for this does not need.
        let _ = win.destroy();
    }
    Ok(())
}

/// Resolve the monitor to hand the audience window, from the live app.
fn audience_monitor(app: &AppHandle) -> Option<MonitorRect> {
    let to_rect = |m: &tauri::Monitor| MonitorRect {
        x: m.position().x,
        y: m.position().y,
        w: m.size().width,
        h: m.size().height,
    };
    let monitors: Vec<MonitorRect> = app
        .available_monitors()
        .ok()?
        .iter()
        .map(to_rect)
        .collect();
    let main = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .map(|m| to_rect(&m));
    choose_audience_monitor(&monitors, main)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32) -> MonitorRect {
        MonitorRect { x, y, w: 1920, h: 1080 }
    }

    #[test]
    fn labels_are_validated() {
        assert!(valid_presenter_label("present-1a2b3c"));
        assert!(valid_presenter_label("present-A_b-9"));
        // Not a presenter window at all.
        assert!(!valid_presenter_label("main"));
        assert!(!valid_presenter_label("detached-p-g1"));
        // The prefix alone is not a label.
        assert!(!valid_presenter_label("present-"));
        // Path/query injection into the window URL.
        assert!(!valid_presenter_label("present-../../etc"));
        assert!(!valid_presenter_label("present-x?y=1"));
        assert!(!valid_presenter_label(&format!("present-{}", "x".repeat(80))));
    }

    #[test]
    fn query_carries_the_label() {
        assert_eq!(presenter_query("present-zz"), "index.html?present=present-zz");
    }

    #[test]
    fn one_monitor_means_no_takeover() {
        assert_eq!(choose_audience_monitor(&[rect(0, 0)], Some(rect(0, 0))), None);
        assert_eq!(choose_audience_monitor(&[], None), None);
    }

    #[test]
    fn picks_the_monitor_the_main_window_is_not_on() {
        let ms = [rect(0, 0), rect(1920, 0)];
        assert_eq!(choose_audience_monitor(&ms, Some(rect(0, 0))), Some(rect(1920, 0)));
        assert_eq!(choose_audience_monitor(&ms, Some(rect(1920, 0))), Some(rect(0, 0)));
    }

    #[test]
    fn unknown_main_monitor_falls_back_to_the_second() {
        // Not the first: that is nearly always the built-in panel the speaker is
        // sitting at, i.e. the one surface the audience must NOT get.
        let ms = [rect(0, 0), rect(1920, 0), rect(3840, 0)];
        assert_eq!(choose_audience_monitor(&ms, None), Some(rect(1920, 0)));
    }

    #[test]
    fn main_on_an_unknown_monitor_still_yields_one() {
        // The main window reported a monitor that is not in the list (a hot-plug
        // between the two reads). Any second screen beats refusing to open.
        let ms = [rect(0, 0), rect(1920, 0)];
        assert_eq!(choose_audience_monitor(&ms, Some(rect(-1080, 0))), Some(rect(0, 0)));
    }
}
