/**
 * The two cross-tree presentation facts (`stores/viewers/presentation`). Counters, not
 * booleans: a main window and a popout can each arm a tool or present a deck,
 * and whichever unmounts second must not clear the other's state. The floor at
 * zero keeps an unbalanced disarm from leaving a negative count that the next
 * arm cannot bring back above zero.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { isToolArmed, usePresentationStore } from "../../stores/viewers/presentation";

beforeEach(() => {
  usePresentationStore.setState({ armed: 0, presenting: 0 });
});

describe("armed", () => {
  it("stays armed while any overlay still holds a tool", () => {
    const s = usePresentationStore.getState();
    expect(isToolArmed()).toBe(false);
    s.setArmed(true);
    s.setArmed(true);
    s.setArmed(false);
    expect(isToolArmed()).toBe(true);
    s.setArmed(false);
    expect(isToolArmed()).toBe(false);
  });

  it("never goes below zero, so a stray disarm cannot mask the next arm", () => {
    const s = usePresentationStore.getState();
    s.setArmed(false);
    expect(usePresentationStore.getState().armed).toBe(0);
    s.setArmed(true);
    expect(isToolArmed()).toBe(true);
  });
});

describe("presenting", () => {
  it("counts presenters independently of armed tools", () => {
    const s = usePresentationStore.getState();
    s.setPresenting(true);
    s.setArmed(true);
    expect(usePresentationStore.getState()).toMatchObject({ presenting: 1, armed: 1 });
    s.setPresenting(false);
    s.setPresenting(false);
    expect(usePresentationStore.getState()).toMatchObject({ presenting: 0, armed: 1 });
  });
});
