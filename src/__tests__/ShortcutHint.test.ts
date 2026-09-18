/**
 * Tooltip shortcut hints (`lib/shortcuts/shortcutHint`): the hint says the chord the user
 * actually has — the built-in default while settings are unloaded, the rebound
 * chord once they carry one — and a fixed editor chord passed as a descriptor
 * is rendered through the same platform labeller and the one i18n key.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";

import { useChordHint, useShortcutOverrides } from "../lib/shortcuts/shortcutHint";
import { useI18nStore } from "../lib/i18n";
import { useSettingsStore } from "../stores/settings";

beforeEach(() => {
  useI18nStore.setState({ lang: "en" });
  useSettingsStore.setState({ settings: null, loaded: false });
});

describe("useShortcutOverrides", () => {
  it("is undefined until settings carry a map", () => {
    const { result } = renderHook(() => useShortcutOverrides());
    expect(result.current).toBeUndefined();
    act(() => {
      useSettingsStore.setState({ settings: { keyboard_shortcuts: { closeTab: { key: "q", ctrl: true } } }, loaded: true });
    });
    expect(result.current).toEqual({ closeTab: { key: "q", ctrl: true } });
  });
});

describe("useChordHint", () => {
  it("falls back to the built-in chord while settings are still loading", () => {
    const { result } = renderHook(() => useChordHint());
    expect(result.current("Close tab", "closeTab")).toBe("Close tab (Ctrl+W)");
  });

  it("says the chord the user rebound, and re-mints the hint when it changes", () => {
    const { result } = renderHook(() => useChordHint());
    const before = result.current;
    act(() => {
      useSettingsStore.setState({
        settings: { keyboard_shortcuts: { closeTab: { key: "q", ctrl: true, shift: true } } },
        loaded: true,
      });
    });
    expect(result.current).not.toBe(before);
    expect(result.current("Close tab", "closeTab")).toBe("Close tab (Ctrl+Shift+Q)");
    // An unrelated action keeps its default under a partial map.
    expect(result.current("Fullscreen", "toggleFullscreen")).toMatch(/^Fullscreen \(.+\)$/);
  });

  it("renders a fixed editor chord through the same labeller", () => {
    const { result } = renderHook(() => useChordHint());
    expect(result.current("Save", { key: "s", ctrl: true })).toBe("Save (Ctrl+S)");
    expect(result.current("Undo", { key: "z", ctrl: true, alt: true })).toBe("Undo (Ctrl+Alt+Z)");
  });

  it("keeps one function identity across renders that change nothing", () => {
    const { result, rerender } = renderHook(() => useChordHint());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
