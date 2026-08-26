/**
 * The interactive half of the lessons: a step carrying a `StepTask` waits for
 * the user to actually do the thing, rewards it with a `:)`, and advances on
 * its own. These tests drive `TourHost` through that loop in jsdom — the pure
 * catalog checks live in `Lessons.test.ts`.
 *
 * Every step here is anchorless on purpose: an anchored step would start the
 * host's `requestAnimationFrame` settle loop, which has nothing to measure in
 * jsdom (every rect is zero) and nothing to do with what's under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import { TourHost } from "../components/layout/TourHost";
import { useTourStore } from "../stores/tour";
import type { TourStep } from "../lib/tour";

/** Two steps: the first waits on the user, the second is plain narration. */
function steps(task: TourStep["task"]): TourStep[] {
  return [
    {
      id: "do-it",
      anchor: null,
      placement: "bottom",
      titleKey: "lessons.addProject.addButtonTitle",
      bodyKey: "lessons.addProject.addButtonBody",
      task,
    },
    {
      id: "after",
      anchor: null,
      placement: "bottom",
      titleKey: "lessons.addProject.addMenuTitle",
      bodyKey: "lessons.addProject.addMenuBody",
    },
  ];
}

const COPY = {
  promptKey: "lessons.addProject.addButtonTask",
  hintKey: "lessons.addProject.addButtonTaskHint",
} as const;

function start(task: TourStep["task"]) {
  act(() => {
    useTourStore.getState().startLesson(steps(task));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => useTourStore.setState({ active: false }));
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("a lesson task", () => {
  it("opens the overlay up so the click it asks for reaches the app", () => {
    render(<TourHost />);
    start({ ...COPY, click: ".lesson-target" });
    // Both full-screen layers stand aside, not just the blocker: the overlay
    // box is `inset: 0` too, and on its own would swallow the very click the
    // step just asked for.
    expect(document.querySelector(".tour-overlay--pass")).not.toBeNull();
    expect(document.querySelector(".tour-blocker--pass")).not.toBeNull();
    // The narrated step that follows blocks again.
    act(() => useTourStore.getState().next());
    expect(document.querySelector(".tour-overlay--pass")).toBeNull();
    expect(document.querySelector(".tour-blocker--pass")).toBeNull();
  });

  it("rewards the click with a :) and then moves on by itself", () => {
    render(<TourHost />);
    document.body.insertAdjacentHTML("beforeend", '<button class="lesson-target">go</button>');
    start({ ...COPY, click: ".lesson-target" });

    expect(document.body.textContent).toContain("Open the add menu");
    expect(document.querySelector(".tour-reward")).toBeNull();

    act(() => {
      fireEvent.click(document.querySelector(".lesson-target")!);
    });
    expect(document.querySelector(".tour-reward-face")?.textContent).toBe(":)");
    // Still this step — the praise is on screen before the lesson advances.
    expect(useTourStore.getState().index).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(useTourStore.getState().index).toBe(1);
    expect(document.querySelector(".tour-reward")).toBeNull();
  });

  it("counts a click inside the target, not just on it", () => {
    render(<TourHost />);
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button class="lesson-target"><span class="label">go</span></button>',
    );
    start({ ...COPY, click: ".lesson-target" });
    act(() => {
      fireEvent.click(document.querySelector(".label")!);
    });
    expect(document.querySelector(".tour-reward")).not.toBeNull();
  });

  it("waits for an `appear` target to actually appear", () => {
    render(<TourHost />);
    start({ ...COPY, appear: ".lesson-menu" });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector(".tour-reward")).toBeNull();

    document.body.insertAdjacentHTML("beforeend", '<div class="lesson-menu"></div>');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector(".tour-reward")).not.toBeNull();
  });

  it("does not congratulate the user for something already on screen", () => {
    render(<TourHost />);
    // The menu is open before the step starts (a previous step left it up).
    document.body.insertAdjacentHTML("beforeend", '<div class="lesson-menu"></div>');
    start({ ...COPY, appear: ".lesson-menu" });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(document.querySelector(".tour-reward")).toBeNull();

    // Closing and reopening it is the real action, and does count.
    document.querySelector(".lesson-menu")!.remove();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    document.body.insertAdjacentHTML("beforeend", '<div class="lesson-menu"></div>');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector(".tour-reward")).not.toBeNull();
  });

  it("solves a `grow` task only once a new element shows up", () => {
    render(<TourHost />);
    document.body.insertAdjacentHTML("beforeend", '<div class="lesson-pill"></div>');
    start({ ...COPY, grow: ".lesson-pill" });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector(".tour-reward")).toBeNull();

    document.body.insertAdjacentHTML("beforeend", '<div class="lesson-pill"></div>');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector(".tour-reward")).not.toBeNull();
  });
});

describe("a lesson hint", () => {
  it("unfolds on demand and folds back", () => {
    render(<TourHost />);
    start({ ...COPY, click: ".lesson-target" });
    const hintBtn = document.querySelector(".tour-hint-btn") as HTMLButtonElement;
    expect(hintBtn).not.toBeNull();
    expect(document.querySelector(".tour-hint")).toBeNull();

    act(() => fireEvent.click(hintBtn));
    expect(document.querySelector(".tour-hint")?.textContent).toContain("top header");
    act(() => fireEvent.click(document.querySelector(".tour-hint-btn")!));
    expect(document.querySelector(".tour-hint")).toBeNull();
  });

  it("asks to be pressed, then opens itself, when the step sits unsolved", () => {
    render(<TourHost />);
    start({ ...COPY, click: ".lesson-target" });
    expect(document.querySelector(".tour-hint-btn.nudge")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(13000);
    });
    expect(document.querySelector(".tour-hint-btn.nudge")).not.toBeNull();
    expect(document.querySelector(".tour-hint")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(13000);
    });
    expect(document.querySelector(".tour-hint")).not.toBeNull();
  });

  it("is gone once the task is done", () => {
    render(<TourHost />);
    document.body.insertAdjacentHTML("beforeend", '<button class="lesson-target">go</button>');
    start({ ...COPY, click: ".lesson-target" });
    act(() => fireEvent.click(document.querySelector(".lesson-target")!));
    expect(document.querySelector(".tour-hint-btn")).toBeNull();
  });
});
