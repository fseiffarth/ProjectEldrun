/**
 * The bare Super key belongs to the desktop, not to the OS.
 *
 * `useKeyboard` binds a lone Meta/Super keydown to the panel toggle. That is
 * only correct where the shell leaves the key to the focused window. GNOME and
 * KDE do not — they answer it themselves and forward a lone "Meta" keydown
 * ahead of every Super+<key> shell shortcut, which silently toggled the panels
 * (and with them the reveal handle) out of the window. The gate is therefore a
 * backend answer about the running desktop, with F9 always available.
 *
 * Covered here: the binding follows the probe in both directions, an
 * unanswered probe keeps the pre-existing behavior (a frontend routinely runs
 * ahead of the backend in this repo), and the shortcut sheet advertises
 * whichever key is actually live.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { SUPER_RELEASE_SETTLE_MS, useKeyboard } from "../hooks/useKeyboard";
import { FIXED_KEYS } from "../lib/shortcuts";
import {
  desktopOwnsSuperKey,
  probeSuperKeyOwnership,
  resetSuperKeyOwnership,
} from "../lib/superKey";

let toggles = 0;

function Harness() {
  useKeyboard({ onTogglePanels: () => void toggles++ });
  return null;
}

function down(k: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: k }));
  });
}
function up(k: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: k }));
  });
}
/** A lone press: down, up, and the release settle the toggle waits out. */
function key(k: string) {
  down(k);
  up(k);
  settle();
}
function settle() {
  act(() => {
    vi.advanceTimersByTime(SUPER_RELEASE_SETTLE_MS + 1);
  });
}
function blur() {
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
}

/** Mount the hook and let its one-shot ownership probe settle. */
async function mountAndSettle() {
  render(<Harness />);
  await act(async () => {
    await probeSuperKeyOwnership();
  });
  vi.useFakeTimers();
}

function panelKeys(): string {
  return FIXED_KEYS.find((k) => k.labelKey === "fixedKeys.panels.label")!.keys;
}

describe("lone Super key ownership", () => {
  beforeEach(() => {
    vi.useRealTimers();
    cleanup();
    resetSuperKeyOwnership();
    invoke.mockReset();
    toggles = 0;
  });

  it("leaves the key alone on a desktop that claims it (GNOME, KDE)", async () => {
    invoke.mockResolvedValue(true);
    await mountAndSettle();

    expect(desktopOwnsSuperKey()).toBe(true);
    key("Meta");
    key("Super");
    expect(toggles).toBe(0);

    // F9 is the way in on every desktop, and the only one advertised here.
    key("F9");
    expect(toggles).toBe(1);
    expect(panelKeys()).toBe("F9");
  });

  it("keeps the binding on a desktop that leaves it free (Cinnamon, XFCE)", async () => {
    invoke.mockResolvedValue(false);
    await mountAndSettle();

    expect(desktopOwnsSuperKey()).toBe(false);
    key("Meta");
    expect(toggles).toBe(1);
    key("Super");
    expect(toggles).toBe(2);
    expect(panelKeys()).toBe("Super");
  });

  it("keeps the binding when the backend cannot answer", async () => {
    // A window whose backend predates the command: `src/` hot-reloads and
    // `src-tauri/` does not, so a rejected probe must not take the Super key
    // away from the desktops it works on.
    invoke.mockRejectedValue(new Error("unknown command"));
    await mountAndSettle();

    expect(desktopOwnsSuperKey()).toBe(false);
    key("Meta");
    expect(toggles).toBe(1);
    expect(panelKeys()).toBe("Super");
  });

  // The rest is what makes that fallback survivable on a desktop the probe
  // could not classify: the toggle fires on a LONE release, never on the
  // keydown a shell forwards ahead of its own shortcuts.

  it("toggles on release, not on the keydown", async () => {
    invoke.mockResolvedValue(false);
    await mountAndSettle();

    down("Meta");
    expect(toggles).toBe(0);
    up("Meta");
    expect(toggles).toBe(0);
    settle();
    expect(toggles).toBe(1);
  });

  it("does not toggle for a chord (Super+Tab, Super+1, Super+arrow)", async () => {
    invoke.mockRejectedValue(new Error("unknown command"));
    await mountAndSettle();

    down("Meta");
    down("Tab");
    up("Tab");
    up("Meta");
    settle();
    expect(toggles).toBe(0);

    // A held key auto-repeats its keydown; that is still one lone press.
    down("Meta");
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Meta", repeat: true }),
      );
    });
    up("Meta");
    settle();
    expect(toggles).toBe(1);
  });

  it("does not toggle when the desktop takes focus on the press (the overview)", async () => {
    invoke.mockRejectedValue(new Error("unknown command"));
    await mountAndSettle();

    // Focus leaves while Super is still down …
    down("Meta");
    blur();
    up("Meta");
    settle();
    expect(toggles).toBe(0);

    // … or right after the release, inside the settle.
    down("Meta");
    up("Meta");
    blur();
    settle();
    expect(toggles).toBe(0);

    // The next lone press, with focus kept, still works.
    key("Meta");
    expect(toggles).toBe(1);
  });

  it("asks the backend once per session", async () => {
    invoke.mockResolvedValue(true);
    await mountAndSettle();
    await probeSuperKeyOwnership();
    await probeSuperKeyOwnership();

    const asks = invoke.mock.calls.filter((c) => c[0] === "desktop_owns_super_key");
    expect(asks).toHaveLength(1);
  });
});
