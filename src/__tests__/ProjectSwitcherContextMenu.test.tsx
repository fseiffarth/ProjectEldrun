/**
 * Test for #12 (Group D.4): the project switcher suppresses the default webview
 * context menu (Reload/Inspect). The `.project-switcher` container calls
 * preventDefault on contextmenu, so a right-click anywhere on it is cancelled
 * (our own pill menu is what surfaces instead).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, createEvent, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));

import { ProjectSwitcher } from "../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../stores/projects";

describe("#12 project switcher context menu suppression", () => {
  beforeEach(() => {
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  });

  it("cancels the default contextmenu event on the project switcher", async () => {
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open={true} />));
    });

    const bar = container!.querySelector(".project-switcher") as HTMLElement;
    expect(bar).toBeTruthy();

    const evt = createEvent.contextMenu(bar);
    fireEvent(bar, evt);
    expect(evt.defaultPrevented).toBe(true);
  });
});
