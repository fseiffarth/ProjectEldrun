/**
 * A stray OS fullscreen is what makes a popout stop moving: the WM takes
 * `_NET_WM_ACTION_MOVE` off a fullscreen window, so `startDragging`'s
 * `_NET_WM_MOVERESIZE` is refused and the title-bar drag no-ops with nothing on
 * screen to say why. These cover the two pure halves of the rescue — who is
 * allowed to clear it, and the free viewport test that stands in for the
 * `isFullscreen()` read that lies (see `lib/strayFullscreen`).
 */

import { describe, expect, it } from "vitest";
import { fillsScreen, mayClearStrayFullscreen } from "../lib/strayFullscreen";

describe("mayClearStrayFullscreen", () => {
  it("clears an unexplained fullscreen — the state that makes a popout immovable", () => {
    expect(
      mayClearStrayFullscreen({ platform: "linux", domFullscreen: false, presenting: 0 }),
    ).toBe(true);
    expect(
      mayClearStrayFullscreen({ platform: "windows", domFullscreen: false, presenting: 0 }),
    ).toBe(true);
  });

  it("leaves the page's own fullscreen alone — a video is not a stray state", () => {
    expect(
      mayClearStrayFullscreen({ platform: "linux", domFullscreen: true, presenting: 0 }),
    ).toBe(false);
  });

  it("leaves a talk in progress fullscreen", () => {
    expect(
      mayClearStrayFullscreen({ platform: "linux", domFullscreen: false, presenting: 1 }),
    ).toBe(false);
  });

  it("never touches macOS, where fullscreen is the platform's own Space", () => {
    expect(
      mayClearStrayFullscreen({ platform: "macos", domFullscreen: false, presenting: 0 }),
    ).toBe(false);
  });

  it("rescues the DOM fullscreen whose element is gone (the leak case)", () => {
    // The tab holding the fullscreen element closed mid-video: WebKitGTK left the
    // toplevel fullscreen, but `document.fullscreenElement` is null again.
    expect(
      mayClearStrayFullscreen({ platform: "linux", domFullscreen: false, presenting: 0 }),
    ).toBe(true);
  });
});

describe("fillsScreen", () => {
  it("recognises a window covering its whole monitor", () => {
    expect(fillsScreen({ w: 3840, h: 2160 }, { w: 3840, h: 2160 })).toBe(true);
  });

  it("tolerates a pixel or two of rounding", () => {
    expect(fillsScreen({ w: 3839, h: 2160 }, { w: 3840, h: 2160 })).toBe(true);
  });

  it("says no for an ordinary window — the fast drag path must stay untouched", () => {
    expect(fillsScreen({ w: 900, h: 640 }, { w: 3840, h: 2160 })).toBe(false);
    expect(fillsScreen({ w: 3840, h: 1200 }, { w: 3840, h: 2160 })).toBe(false);
  });

  it("says no rather than guessing when the screen reports nothing", () => {
    expect(fillsScreen({ w: 0, h: 0 }, { w: 0, h: 0 })).toBe(false);
  });
});
