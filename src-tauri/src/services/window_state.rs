//! Startup geometry for the MAIN window: decide where to reopen it from the
//! rect saved on the last run (`settings.window_state`).
//!
//! Pure and `AppHandle`-free so every rule below is unit-tested on any OS; the
//! Tauri calls that consume the result live in `lib.rs`'s `setup`.
//!
//! The job is *not* "apply the saved rect". It is "apply the saved rect only if a
//! currently-connected monitor can still host it". A user who saved Eldrun on an
//! external display and then undocked would otherwise get a window mapped at
//! x=2400 on a laptop whose only screen ends at 1920 — off-screen, unreachable,
//! and indistinguishable from "Eldrun didn't start". Whenever we can't place the
//! rect confidently we return `None`, which means "leave the window exactly as
//! `tauri.conf.json` configured it" (maximized, WM's choice of monitor) — i.e. we
//! degrade to today's behaviour rather than to a broken one.
//!
//! All coordinates are PHYSICAL desktop pixels (see `schema::settings::WindowState`).

use crate::schema::settings::WindowState;

/// One connected monitor's position and size in physical desktop px, as reported
/// by Tauri's `available_monitors()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// How much of the saved window must still land on a real monitor for us to trust
/// it. Sized to be a grabbable strip of title bar — enough that the user can
/// always drag the window back into view. Below this we discard the saved rect
/// entirely rather than place a window the user can't reach.
const MIN_VISIBLE_W: i64 = 200;
const MIN_VISIBLE_H: i64 = 80;

/// Floor for a restored window, matching `minWidth`/`minHeight` in
/// `tauri.conf.json`. A corrupt or hand-edited `settings.json` can't shrink the
/// window to nothing.
const MIN_W: u32 = 800;
const MIN_H: u32 = 600;

/// The geometry to apply to the main window at startup, or `None` to leave it as
/// `tauri.conf.json` configured it.
///
/// `None` is returned when there is nothing saved, when Tauri reports no monitors
/// (it can return an empty list on a compositor that hasn't settled — guessing
/// from a saved rect we can't validate is worse than the default), or when the
/// saved rect no longer meaningfully overlaps any connected monitor.
///
/// Otherwise the rect is fitted to the monitor it overlaps most: clamped to that
/// monitor's size and shifted so it sits fully inside it. `maximized` passes
/// straight through — a maximized window still needs its rect resolved, because
/// that rect is what decides *which monitor* it re-maximizes on.
pub fn resolve_startup_geometry(
    saved: Option<WindowState>,
    monitors: &[MonitorRect],
) -> Option<WindowState> {
    let saved = saved?;
    if monitors.is_empty() {
        return None;
    }
    // A zero/negative-sized saved rect can't be intersected meaningfully.
    if saved.w == 0 || saved.h == 0 {
        return None;
    }

    let best = monitors
        .iter()
        .max_by_key(|m| overlap_area(&saved, m))
        .copied()?;

    let (ow, oh) = overlap_dims(&saved, &best);
    if ow < MIN_VISIBLE_W || oh < MIN_VISIBLE_H {
        return None;
    }

    // Fit to the monitor: never wider/taller than the screen, never below the
    // configured minimum, then slid back inside if it hangs off an edge.
    let w = saved.w.clamp(MIN_W.min(best.w), best.w);
    let h = saved.h.clamp(MIN_H.min(best.h), best.h);
    let x = saved.x.clamp(best.x, best.x + best.w as i32 - w as i32);
    let y = saved.y.clamp(best.y, best.y + best.h as i32 - h as i32);

    Some(WindowState {
        x,
        y,
        w,
        h,
        maximized: saved.maximized,
    })
}

/// Geometry to re-apply to a DETACHED popout on project switch-back (#42).
///
/// The switch path hides an inactive project's popouts and re-shows them on
/// switch-back; `hide()`/`show()` lets the WM move the window — typically onto
/// the primary monitor — so the geometry captured just before hiding must be
/// re-applied, or a multi-monitor popout lands on the wrong screen. This
/// validates that captured rect against the CURRENTLY connected monitors (the
/// same monitor-fit the main window uses at startup) so a monitor unplugged
/// while the project was inactive can't strand the popout off-screen.
///
/// Two things differ from [`resolve_startup_geometry`]:
///   * An **empty** monitor list re-applies the captured rect unchanged rather
///     than giving up — mid-session the rect is known-good (the popout was just
///     visible there) and a transient empty read is no reason to leave it
///     WM-misplaced.
///   * It imposes **no minimum size**. A borderless popout has no configured
///     `minWidth`/`minHeight` (the main window does), so growing it to 800×600
///     would silently resize a deliberately small popout.
///
/// Returns `None` only when the captured rect is degenerate, or when it no
/// longer meaningfully overlaps any connected monitor (the display it lived on
/// was unplugged) — in which case the caller leaves the WM's placement rather
/// than flinging the window off-screen.
pub fn resolve_detached_geometry(
    saved: WindowState,
    monitors: &[MonitorRect],
) -> Option<WindowState> {
    if saved.w == 0 || saved.h == 0 {
        return None;
    }
    if monitors.is_empty() {
        return Some(saved);
    }

    let best = monitors
        .iter()
        .max_by_key(|m| overlap_area(&saved, m))
        .copied()?;

    let (ow, oh) = overlap_dims(&saved, &best);
    if ow < MIN_VISIBLE_W || oh < MIN_VISIBLE_H {
        return None;
    }

    // Fit to the monitor WITHOUT a minimum-size floor: never larger than the
    // screen, then slid back inside if it hangs off an edge.
    let w = saved.w.min(best.w);
    let h = saved.h.min(best.h);
    let x = saved.x.clamp(best.x, best.x + best.w as i32 - w as i32);
    let y = saved.y.clamp(best.y, best.y + best.h as i32 - h as i32);
    Some(WindowState { x, y, w, h, maximized: false })
}

/// Width/height of the intersection between a saved window rect and a monitor, in
/// physical px. `i64` because `x + w` on two `i32`s can overflow in principle and
/// these feed a comparison, not a coordinate.
fn overlap_dims(s: &WindowState, m: &MonitorRect) -> (i64, i64) {
    let (sx, sy) = (s.x as i64, s.y as i64);
    let (sx2, sy2) = (sx + s.w as i64, sy + s.h as i64);
    let (mx, my) = (m.x as i64, m.y as i64);
    let (mx2, my2) = (mx + m.w as i64, my + m.h as i64);
    let w = (sx2.min(mx2) - sx.max(mx)).max(0);
    let h = (sy2.min(my2) - sy.max(my)).max(0);
    (w, h)
}

fn overlap_area(s: &WindowState, m: &MonitorRect) -> i64 {
    let (w, h) = overlap_dims(s, m);
    w * h
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The dev desk this feature was written for: two 1920x1080 monitors side by
    /// side, DP-6 at the origin and DP-7 to its right.
    fn two_monitors() -> Vec<MonitorRect> {
        vec![
            MonitorRect { x: 0, y: 0, w: 1920, h: 1080 },
            MonitorRect { x: 1920, y: 0, w: 1920, h: 1080 },
        ]
    }

    fn only_primary() -> Vec<MonitorRect> {
        vec![MonitorRect { x: 0, y: 0, w: 1920, h: 1080 }]
    }

    fn ws(x: i32, y: i32, w: u32, h: u32) -> WindowState {
        WindowState { x, y, w, h, maximized: false }
    }

    #[test]
    fn nothing_saved_keeps_the_configured_default() {
        assert_eq!(resolve_startup_geometry(None, &two_monitors()), None);
    }

    #[test]
    fn no_monitors_reported_keeps_the_configured_default() {
        // Rather than trust a rect we cannot validate against anything.
        assert_eq!(resolve_startup_geometry(Some(ws(0, 0, 1400, 900)), &[]), None);
    }

    #[test]
    fn window_on_the_secondary_monitor_is_returned_unchanged() {
        // THE core case: Eldrun was on DP-7, it must come back on DP-7.
        let saved = ws(2200, 100, 1400, 900);
        assert_eq!(
            resolve_startup_geometry(Some(saved), &two_monitors()),
            Some(saved)
        );
    }

    #[test]
    fn unplugging_the_saved_monitor_falls_back_to_the_default() {
        // Saved on DP-7 (x=2200), which is now gone. The rect overlaps the
        // remaining monitor by nothing at all, so we must NOT place the window
        // there-ish — we hand back None and let the config maximize it.
        let saved = ws(2200, 100, 1400, 900);
        assert_eq!(resolve_startup_geometry(Some(saved), &only_primary()), None);
    }

    #[test]
    fn a_sliver_of_overlap_is_not_enough_to_trust_the_rect() {
        // 20px of the window pokes onto the primary monitor — far too little to
        // grab. Treated the same as the monitor being gone.
        let saved = ws(1900, 100, 1400, 900);
        assert_eq!(resolve_startup_geometry(Some(saved), &only_primary()), None);
    }

    #[test]
    fn a_window_hanging_off_an_edge_is_slid_back_inside() {
        // Mostly on the primary monitor but running past its right edge.
        let saved = ws(1000, 400, 1400, 900);
        let got = resolve_startup_geometry(Some(saved), &only_primary()).unwrap();
        assert_eq!(got.w, 1400, "size is fine, only the origin was wrong");
        assert_eq!(got.h, 900);
        assert_eq!(got.x, 520, "flush against the monitor's right edge");
        assert_eq!(got.y, 180, "flush against its bottom edge");
    }

    #[test]
    fn a_window_larger_than_its_monitor_is_shrunk_to_fit() {
        // e.g. saved on a 4K screen, reopened on a 1080p one.
        let saved = ws(0, 0, 3840, 2160);
        let got = resolve_startup_geometry(Some(saved), &only_primary()).unwrap();
        assert_eq!((got.x, got.y, got.w, got.h), (0, 0, 1920, 1080));
    }

    #[test]
    fn a_maximized_window_still_resolves_its_rect() {
        // The rect is what decides WHICH monitor it re-maximizes on, so it must
        // survive even though the window will immediately be maximized over it.
        let saved = WindowState { x: 2200, y: 100, w: 1400, h: 900, maximized: true };
        let got = resolve_startup_geometry(Some(saved), &two_monitors()).unwrap();
        assert!(got.maximized);
        assert_eq!(got.x, 2200, "still on DP-7, so it maximizes there and not on DP-6");
    }

    #[test]
    fn a_degenerate_saved_rect_is_ignored() {
        // A hand-edited or truncated settings.json must not produce a 0-px window.
        assert_eq!(resolve_startup_geometry(Some(ws(0, 0, 0, 900)), &only_primary()), None);
        assert_eq!(resolve_startup_geometry(Some(ws(0, 0, 1400, 0)), &only_primary()), None);
    }

    #[test]
    fn a_tiny_saved_rect_is_discarded_rather_than_grown() {
        // 100x50 is smaller than the grabbable minimum however it is placed, so it
        // fails the visibility check and we fall back to the default. We never
        // invent a geometry the user never had.
        assert_eq!(
            resolve_startup_geometry(Some(ws(10, 10, 100, 50)), &only_primary()),
            None
        );
    }

    #[test]
    fn an_ordinary_rect_well_inside_a_monitor_is_left_alone() {
        let got = resolve_startup_geometry(Some(ws(10, 10, 900, 700)), &only_primary()).unwrap();
        assert_eq!((got.x, got.y, got.w, got.h), (10, 10, 900, 700));
    }

    #[test]
    fn the_monitor_with_the_most_overlap_wins() {
        // Straddling the seam, but mostly on DP-7 → fitted onto DP-7.
        let saved = ws(1800, 100, 1400, 900);
        let got = resolve_startup_geometry(Some(saved), &two_monitors()).unwrap();
        assert_eq!(got.x, 1920, "slid right, flush with DP-7's left edge");
        assert_eq!(got.w, 1400, "not resized — it fits DP-7 fine");
    }

    // ── resolve_detached_geometry (#42 switch-back popout restore) ──────────

    #[test]
    fn detached_popout_on_the_secondary_monitor_is_restored_there() {
        // THE bug: switching back must land the popout on DP-7, not DP-6.
        let saved = ws(2200, 150, 900, 640);
        assert_eq!(
            resolve_detached_geometry(saved, &two_monitors()),
            Some(saved),
        );
    }

    #[test]
    fn detached_empty_monitor_list_reapplies_the_captured_rect() {
        // Mid-session the captured rect was valid moments ago; a transient empty
        // monitor read is no reason to leave the popout WM-misplaced. Unlike the
        // startup resolver, which returns None here.
        let saved = ws(2200, 150, 900, 640);
        assert_eq!(resolve_detached_geometry(saved, &[]), Some(saved));
    }

    #[test]
    fn detached_small_popout_is_not_grown_to_a_minimum() {
        // A borderless popout has no configured minimum size — a deliberately
        // small one must come back the same size, not grown to 800×600 the way
        // the main-window resolver would.
        let saved = ws(300, 300, 420, 320);
        let got = resolve_detached_geometry(saved, &only_primary()).unwrap();
        assert_eq!((got.w, got.h), (420, 320), "kept its small size");
        assert_eq!((got.x, got.y), (300, 300));
    }

    #[test]
    fn detached_popout_on_an_unplugged_monitor_falls_back_to_wm_placement() {
        // The display it lived on is gone → None, so the caller leaves the WM's
        // placement rather than flinging it off-screen.
        let saved = ws(2200, 150, 900, 640);
        assert_eq!(resolve_detached_geometry(saved, &only_primary()), None);
    }

    #[test]
    fn detached_popout_hanging_off_an_edge_is_slid_back_inside() {
        let saved = ws(1600, 800, 900, 640);
        let got = resolve_detached_geometry(saved, &only_primary()).unwrap();
        assert_eq!(got.w, 900, "size fine, only origin was off");
        assert_eq!(got.x, 1020, "flush against the monitor's right edge");
        assert_eq!(got.y, 440, "flush against its bottom edge");
    }

    #[test]
    fn detached_degenerate_rect_is_ignored() {
        assert_eq!(resolve_detached_geometry(ws(0, 0, 0, 640), &only_primary()), None);
        assert_eq!(resolve_detached_geometry(ws(0, 0, 900, 0), &only_primary()), None);
    }
}
