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

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, State,
    WebviewWindowBuilder, WebviewUrl,
};

use crate::commands::apps::{
    TrackedWindow, WindowRegistry, WindowRegistryState, ORIGIN_DETACHED_SUBWINDOW,
};
use crate::commands::workspace::WorkspaceStateArc;

/// Stable Tauri window label for a detached group. One window per (project,
/// group); the label is also how `attach_subwindow` finds the window to close.
pub fn detached_label(scope: &str, group_id: &str) -> String {
    format!("detached-{scope}-{group_id}")
}

/// Human-friendly, per-session-unique OS window title for a detached group,
/// e.g. "Eldrun win-1". This string is load-bearing on X11: the resolver in
/// `platform::x11::find_window_for_title` matches on it exactly to recover the
/// native window id, so it must stay unique among live detached windows.
/// Uniqueness comes from the caller assigning a distinct sequence number per
/// live window (lowest free positive int); see `detach_subwindow`.
pub fn detached_title(seq: u32) -> String {
    format!("Eldrun win-{seq}")
}

/// The query string the DetachedApp renderer reads to mount a single group.
pub fn detached_query(scope: &str, group_id: &str) -> String {
    format!("index.html?detached={scope}:{group_id}")
}

pub fn detached_decorations(os: crate::paths::OsKind) -> bool {
    os == crate::paths::OsKind::Macos
}

/// Reserve the lowest free display number for `label` (the N in "Eldrun
/// win-N"). Must run under the registry lock so a concurrent detach (or a
/// restart batch respawning several popouts) can't pick the same one.
pub fn reserve_detached_seq(reg: &mut WindowRegistry, label: &str) -> u32 {
    let used: std::collections::HashSet<u32> = reg.detached_seqs.values().copied().collect();
    let n = (1u32..).find(|n| !used.contains(n)).expect("a free u32 always exists");
    reg.detached_seqs.insert(label.to_string(), n);
    n
}

/// Drop a detached window's registry footprint: its display number (so the
/// next detach can reuse it — "the second window is always win-1") and its
/// `TrackedWindow`. Returns the native window id (if one was resolved) so the
/// caller can unset the parkable override. Idempotent: a label with no
/// footprint is a no-op returning `None`, which is what makes it safe to call
/// from BOTH `attach_subwindow` and the `WindowEvent::Destroyed` hook — the
/// dock-back path fires it twice.
pub fn release_detached_entry(reg: &mut WindowRegistry, label: &str) -> Option<u64> {
    reg.detached_seqs.remove(label);
    // Drop any captured switch-back geometry too, so a docked/closed label never
    // leaves a stale bounds entry a reused label could later pick up (#42).
    reg.detached_bounds.remove(label);
    reg.windows.remove(label).and_then(|w| w.window_id)
}

/// PHYSICAL-pixel position to apply to a freshly-built detached window from the
/// optional restore-geometry args, or `None` to let the WM place it.
///
/// The frontend's bounds are PHYSICAL desktop px (the canonical cross-window
/// space — `src/lib/coords.ts`), so they MUST be applied via the `Physical`
/// dpi variant. The builder's `.position()` takes LOGICAL px; feeding physical
/// numbers to it multiplied them by the display scale, placing the window
/// off-screen on every scale != 1.0 display — invisible on a scaled Windows
/// display, while harmless on the scale-1.0 Linux dev box (#42).
pub fn detached_position(x: Option<f64>, y: Option<f64>) -> Option<Position> {
    match (x, y) {
        (Some(x), Some(y)) => Some(Position::Physical(PhysicalPosition::new(x as i32, y as i32))),
        _ => None,
    }
}

/// PHYSICAL-pixel size to apply to a freshly-built detached window, or `None`
/// to keep the default size. Same physical-vs-logical rationale as
/// [`detached_position`] (the builder's `.inner_size()` is LOGICAL). Non-positive
/// dimensions are rejected so a stale/zero payload can never yield a 0×0 window.
pub fn detached_size(width: Option<f64>, height: Option<f64>) -> Option<Size> {
    match (width, height) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => {
            Some(Size::Physical(PhysicalSize::new(w as u32, h as u32)))
        }
        _ => None,
    }
}

/// Pop a tab group out into its own borderless OS window bound to `project_id`.
///
/// Resolves the window's native id *before returning* so the
/// registry always carries a `window_id` before the window is usable — an
/// unresolved id would float across projects until resolved (reviewer Finding 7).
/// Returns the registry id the frontend uses to later dock it back.
///
/// MUST be `async`. A synchronous Tauri command runs on the main (UI) thread, and
/// `WebviewWindowBuilder::build()` on Windows blocks waiting for the main-thread
/// event loop to pump WebView2's `create_controller` callback — which the in-flight
/// sync command is itself blocking → deadlock (wry#583 / tauri#4121), surfacing as
/// a blank white popout that never renders. An `async` command is driven off the
/// main thread, so `.build()` can dispatch to and await the (now free) event loop.
/// This body holds no lock guard across an `.await` (it has none), so the future
/// stays `Send`. On Linux/macOS the loop isn't blocked the same way, which is why a
/// sync command worked on the dev box but not on Windows (#42).
#[tauri::command]
pub async fn detach_subwindow(
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

    // If a window with this label already exists, treat the call as idempotent.
    // (Before reserving a number, so re-detaching a live label never burns one.)
    if app.get_webview_window(&label).is_some() {
        return Ok(label);
    }

    // Reserve the lowest free display number. It becomes the OS title
    // "Eldrun win-N" and, on X11, the resolver key — hence it must be unique per
    // live window. It's freed on dock-back/close (`attach_subwindow`) AND on any
    // other destruction via the `WindowEvent::Destroyed` hook in `lib.rs` (the
    // popout self-destroys on seed timeout, last-tab close and the WM-close
    // safety net without ever calling attach), so freed numbers get reused and a
    // lone popout is always "win-1".
    let seq = reserve_detached_seq(&mut win_registry.lock().unwrap(), &label);
    let title = detached_title(seq);

    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(detached_query(&project_id, &group_id).into()),
    )
    .title(&title)
    .decorations(detached_decorations(crate::paths::OsKind::current()));
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
    // Default LOGICAL size only. Any caller-supplied geometry is PHYSICAL px
    // (frontend canonical space, `src/lib/coords.ts`) and is applied AFTER build
    // via the physical setters below — routing it through the builder's LOGICAL
    // `.position()`/`.inner_size()` placed/sized the window wrong on every
    // scale != 1.0 display, which is why detach worked on the scale-1.0 Linux dev
    // box but spawned an invisible, off-screen window on scaled Windows (#42).
    builder = builder.inner_size(900.0, 640.0);
    let win = match builder.build() {
        Ok(win) => win,
        Err(e) => {
            // Release the reserved number so a rare failed build doesn't
            // permanently skip a slot.
            release_detached_entry(&mut win_registry.lock().unwrap(), &label);
            return Err(format!("build detached window: {e}"));
        }
    };

    // Apply restore geometry in PHYSICAL px. Missing/zero bounds keep the logical
    // default size and let the WM place the window. Size before position so a
    // resize can't shift the placement. Best-effort: a failed setter still leaves
    // a usable (default-placed) window rather than aborting the detach.
    if let Some(size) = detached_size(width, height) {
        let _ = win.set_size(size);
    }
    if let Some(pos) = detached_position(x, y) {
        let _ = win.set_position(pos);
    }

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
        // Marshal every window op onto the main (UI) thread. Tauri window methods
        // are `Send` so they compile from a worker thread, but on Windows calling
        // show()/set_focus()/set_size() off the thread that owns the HWND is
        // unreliable — it can no-op the repaint or deadlock against the event loop
        // — so dispatch through `run_on_main_thread`.
        let kick = |app: AppHandle, label: String, reveal: bool| {
            let app_main = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(w) = app_main.get_webview_window(&label) {
                    #[cfg(target_os = "windows")]
                    if reveal {
                        // Built hidden on Windows; toggling visibility forces
                        // WebView2's first composite (a fresh runtime-created
                        // window otherwise shows a blank white surface until it is
                        // shown/focused).
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    if let Ok(sz) = w.inner_size() {
                        // A real ±1px size change forces the compositor to allocate
                        // and paint the surface (WebKitGTK's second webview is an
                        // unpainted BLACK GL surface until a genuine OS resize).
                        let delta: i32 = if reveal { 1 } else { -1 };
                        let next = (sz.width as i32 + delta).max(1) as u32;
                        let _ = w.set_size(PhysicalSize::new(next, sz.height));
                    }
                }
            });
        };
        std::thread::sleep(std::time::Duration::from_millis(250));
        kick(nudge_app.clone(), nudge_label.clone(), true);
        // A short gap so the grow then restore aren't coalesced into a no-op.
        std::thread::sleep(std::time::Duration::from_millis(50));
        kick(nudge_app, nudge_label, false);
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
    // Free the display number in the same critical section so it can be reused.
    let wid = release_detached_entry(&mut win_registry.lock().unwrap(), &registry_id);
    if let Some(wid) = wid {
        workspace.lock().unwrap().backend.unset_parkable(wid);
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
/// Defaults to `true` (allow the merge) when the popout has no resolved native
/// window id or on platforms without an occlusion probe (currently everything
/// but Linux/X11 and Windows), so a missing occlusion signal never suppresses a
/// legit dock.
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
            #[cfg(target_os = "windows")]
            {
                crate::platform::windows::frontmost_window_under_cursor()
                    .map(|top| top == wid)
                    .unwrap_or(false)
            }
            // macOS: future-proofing — `resolve_detached_window_id` stays None
            // on macOS v1, so this arm is only reached once popouts learn their
            // CGWindowID.
            #[cfg(target_os = "macos")]
            {
                crate::platform::macos::frontmost_window_under_pointer()
                    .map(|top| top == wid)
                    .unwrap_or(false)
            }
            #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
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
    fn label_embeds_scope_and_group() {
        assert_eq!(detached_label("p1", "g-3"), "detached-p1-g-3");
    }

    #[test]
    fn title_is_a_human_friendly_sequence_name() {
        assert_eq!(detached_title(1), "Eldrun win-1");
        assert_eq!(detached_title(2), "Eldrun win-2");
        // Distinct numbers produce distinct titles (the X11 resolver key must be
        // unique per live window).
        assert_ne!(detached_title(1), detached_title(2));
    }

    #[test]
    fn query_carries_the_detached_param() {
        assert_eq!(detached_query("p1", "g-3"), "index.html?detached=p1:g-3");
        assert_eq!(detached_query("root", "g-1"), "index.html?detached=root:g-1");
    }

    #[test]
    fn only_macos_detached_windows_use_native_decorations() {
        assert!(detached_decorations(crate::paths::OsKind::Macos));
        assert!(!detached_decorations(crate::paths::OsKind::Windows));
        assert!(!detached_decorations(crate::paths::OsKind::Unix));
    }

    #[test]
    fn restore_geometry_is_applied_as_physical_pixels() {
        // The frontend ships PHYSICAL desktop px (`src/lib/coords.ts`); a detached
        // window MUST apply them via the `Physical` dpi variant, NOT the builder's
        // LOGICAL setters — otherwise it lands off-screen on any scale != 1.0
        // display (the #42 Windows regression). Pin both the variant and value so a
        // revert to logical (or to LogicalPosition/LogicalSize) fails the build.
        match detached_position(Some(1500.0), Some(820.0)) {
            Some(Position::Physical(p)) => {
                assert_eq!(p.x, 1500);
                assert_eq!(p.y, 820);
            }
            other => panic!("expected a physical position, got {other:?}"),
        }
        match detached_size(Some(900.0), Some(640.0)) {
            Some(Size::Physical(s)) => {
                assert_eq!(s.width, 900);
                assert_eq!(s.height, 640);
            }
            other => panic!("expected a physical size, got {other:?}"),
        }
    }

    fn tracked(label: &str, window_id: Option<u64>) -> TrackedWindow {
        TrackedWindow {
            id: label.to_string(),
            exec: "eldrun-detached".to_string(),
            file: None,
            pid: 1,
            project_id: Some("p1".to_string()),
            role: Some("g-1".to_string()),
            opened_at: 0.0,
            window_id,
            origin: ORIGIN_DETACHED_SUBWINDOW.to_string(),
        }
    }

    #[test]
    fn released_numbers_are_reused_lowest_first() {
        // The user-visible guarantee: a lone popout is always "win-1". Reserve
        // three, release the first two (whichever way their windows died), and
        // the next detach must take 1 — not climb to 4.
        let mut reg = WindowRegistry::default();
        assert_eq!(reserve_detached_seq(&mut reg, "detached-p1-g-1"), 1);
        assert_eq!(reserve_detached_seq(&mut reg, "detached-p1-g-2"), 2);
        assert_eq!(reserve_detached_seq(&mut reg, "detached-p1-g-3"), 3);
        release_detached_entry(&mut reg, "detached-p1-g-1");
        release_detached_entry(&mut reg, "detached-p1-g-2");
        assert_eq!(reserve_detached_seq(&mut reg, "detached-p1-g-4"), 1);
        // 3 is still live, so the one after takes 2, never a duplicate 3.
        assert_eq!(reserve_detached_seq(&mut reg, "detached-p1-g-5"), 2);
    }

    #[test]
    fn release_is_idempotent_and_returns_the_native_id() {
        // The Destroyed hook fires after `attach_subwindow` already freed the
        // entry, so a second release of the same label must be a clean no-op.
        let mut reg = WindowRegistry::default();
        let label = "detached-p1-g-1";
        reserve_detached_seq(&mut reg, label);
        reg.windows.insert(label.to_string(), tracked(label, Some(42)));
        assert_eq!(release_detached_entry(&mut reg, label), Some(42));
        assert!(reg.detached_seqs.is_empty());
        assert!(reg.windows.is_empty());
        // Second release (and a never-registered label): no-op, no id.
        assert_eq!(release_detached_entry(&mut reg, label), None);
        assert_eq!(release_detached_entry(&mut reg, "detached-p1-g-9"), None);
    }

    #[test]
    fn release_without_native_id_still_frees_the_number() {
        // A popout whose native id never resolved (e.g. macOS) must still give
        // its display number back.
        let mut reg = WindowRegistry::default();
        let label = "detached-p1-g-1";
        reserve_detached_seq(&mut reg, label);
        reg.windows.insert(label.to_string(), tracked(label, None));
        assert_eq!(release_detached_entry(&mut reg, label), None);
        assert_eq!(reserve_detached_seq(&mut reg, "detached-p1-g-2"), 1);
    }

    #[test]
    fn missing_or_invalid_geometry_keeps_the_default() {
        // A partial position is ignored (WM places the window).
        assert!(detached_position(Some(10.0), None).is_none());
        assert!(detached_position(None, Some(10.0)).is_none());
        assert!(detached_position(None, None).is_none());
        // Non-positive or partial size keeps the logical default — never a 0×0 or
        // negative window from a stale/garbage payload.
        assert!(detached_size(Some(0.0), Some(640.0)).is_none());
        assert!(detached_size(Some(900.0), Some(0.0)).is_none());
        assert!(detached_size(Some(900.0), Some(-1.0)).is_none());
        assert!(detached_size(None, Some(640.0)).is_none());
        assert!(detached_size(Some(900.0), None).is_none());
    }
}
