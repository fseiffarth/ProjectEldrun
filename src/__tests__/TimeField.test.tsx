/**
 * The clock-entry field as the user meets it: two segments typed into, spun
 * with the arrows, and an AM/PM toggle on a 12-hour face.
 *
 * What it is there to prove is that the field shows the clock the *setting*
 * chose — the one thing the native `<input type="time">` it replaces could not
 * be told, since that widget reads its face off the engine's locale — while
 * still handing its caller the same plain `"HH:MM"` the native one did, and
 * while being incapable of holding anything that is not a time.
 */
import { useState } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TimeField } from "../components/common/TimeField";
import { useSettingsStore } from "../stores/settings";

function setClock(use24h: boolean) {
  useSettingsStore.setState({ settings: { time_format_24h: use24h }, loaded: true });
}

/**
 * Rendered the way the dialogs render it — controlled, with the new value fed
 * straight back in. A fixed `value` prop would test a component that does not
 * exist: every caller here stores what it is handed.
 */
function field(initial: string, onChange = vi.fn()) {
  function Harness() {
    const [v, setV] = useState(initial);
    return (
      <TimeField
        value={v}
        onChange={(next) => {
          onChange(next);
          setV(next);
        }}
        aria-label="due"
      />
    );
  }
  const r = render(<Harness />);
  return {
    hour: r.getByLabelText("due (h)") as HTMLInputElement,
    minute: r.getByLabelText("due (min)") as HTMLInputElement,
    meridiem: r.queryByRole("button"),
    box: r.getByRole("group"),
    onChange,
  };
}

beforeEach(() => setClock(true));
afterEach(cleanup);

describe("TimeField", () => {
  it("shows the clock the setting chose, not the engine's", () => {
    const day = field("17:30");
    expect([day.hour.value, day.minute.value]).toEqual(["17", "30"]);
    expect(day.meridiem).toBeNull();
    cleanup();
    setClock(false);
    const half = field("17:30");
    expect([half.hour.value, half.minute.value]).toEqual(["5", "30"]);
    expect(half.meridiem?.textContent).toBe("PM");
  });

  it("shows nothing for a deadline with no hour", () => {
    const { hour, minute } = field("");
    expect([hour.value, minute.value]).toEqual(["", ""]);
  });

  it("commits HH:MM once both segments are filled, and not before", () => {
    const { hour, minute, onChange } = field("");
    fireEvent.change(hour, { target: { value: "17" } });
    // Half a time is not a time: nothing is written until the minute exists.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(minute, { target: { value: "30" } });
    expect(onChange).toHaveBeenCalledWith("17:30");
  });

  it("takes digits only, and rereads an overshooting second one as a first", () => {
    const { hour, onChange } = field("00:00");
    // Focused, as it is when anybody types into it: that is what stops the
    // stored value from being read back over the digits mid-edit.
    hour.focus();
    fireEvent.change(hour, { target: { value: "1x7" } });
    expect(hour.value).toBe("17");
    expect(onChange).toHaveBeenLastCalledWith("17:00");
    // 2 then 5 cannot be an hour, so the 5 starts over — the native habit.
    fireEvent.change(hour, { target: { value: "25" } });
    expect(hour.value).toBe("5");
  });

  it("keeps a 12-hour face's hour in 1–12 and folds AM/PM into the stored hour", () => {
    setClock(false);
    const { hour, minute, meridiem, onChange } = field("");
    fireEvent.change(hour, { target: { value: "5" } });
    fireEvent.change(minute, { target: { value: "30" } });
    expect(onChange).toHaveBeenLastCalledWith("05:30");
    fireEvent.click(meridiem!);
    expect(onChange).toHaveBeenLastCalledWith("17:30");
    // 12 is the hour that breaks a naive fold in both directions.
    fireEvent.change(hour, { target: { value: "12" } });
    expect(onChange).toHaveBeenLastCalledWith("12:30");
    fireEvent.click(meridiem!);
    expect(onChange).toHaveBeenLastCalledWith("00:30");
  });

  it("spins the focused segment with the arrows, wrapping at its own edges", () => {
    const { hour, minute, onChange } = field("17:30");
    fireEvent.keyDown(hour, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("18:30");
    cleanup();
    const late = field("23:59");
    fireEvent.keyDown(late.hour, { key: "ArrowUp" });
    expect(late.onChange).toHaveBeenLastCalledWith("00:59");
    // The minute wraps on its own — the hour it rolled into stays put.
    fireEvent.keyDown(late.minute, { key: "ArrowUp" });
    expect(late.onChange).toHaveBeenLastCalledWith("00:00");
    expect(minute).toBeDefined();
  });

  it("flips AM/PM from the keyboard on a 12-hour face", () => {
    setClock(false);
    const { hour, onChange } = field("09:15");
    fireEvent.keyDown(hour, { key: "p" });
    expect(onChange).toHaveBeenLastCalledWith("21:15");
    fireEvent.keyDown(hour, { key: "a" });
    expect(onChange).toHaveBeenLastCalledWith("09:15");
  });

  it("reads a lone hour as the top of that hour when the field is left", () => {
    const { hour, box, onChange } = field("");
    fireEvent.change(hour, { target: { value: "17" } });
    fireEvent.blur(box, { relatedTarget: document.body });
    expect(onChange).toHaveBeenLastCalledWith("17:00");
  });

  it("clears the hour when both segments are emptied", () => {
    const { hour, minute, onChange } = field("17:30");
    fireEvent.change(minute, { target: { value: "" } });
    fireEvent.change(hour, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  // Typed the way a person types it — one focus, four keystrokes, no per-segment
  // event fired by hand. This is what a `change`-per-segment test cannot see:
  // the hour used to keep the caret after its second digit (`select()` does not
  // move focus), so "1730" landed entirely in the hour and read 17 → 73 → 3 →
  // 30 → 0, and the field committed nothing at all.
  it("takes a whole time typed straight through, advancing on its own", async () => {
    const user = userEvent.setup();
    const { hour, minute, onChange } = field("");
    await user.click(hour);
    await user.keyboard("1730");
    expect([hour.value, minute.value]).toEqual(["17", "30"]);
    expect(onChange).toHaveBeenLastCalledWith("17:30");
  });

  it("types straight through on a 12-hour face too", async () => {
    setClock(false);
    const user = userEvent.setup();
    const { hour, minute, meridiem, onChange } = field("");
    await user.click(hour);
    await user.keyboard("530");
    expect([hour.value, minute.value]).toEqual(["5", "30"]);
    expect(onChange).toHaveBeenLastCalledWith("05:30");
    await user.click(meridiem!);
    expect(onChange).toHaveBeenLastCalledWith("17:30");
  });

  it("retypes a segment rather than appending to it when clicked into", async () => {
    const user = userEvent.setup();
    const { hour, minute, onChange } = field("17:30");
    await user.click(hour);
    await user.keyboard("9");
    // 9 cannot start a two-digit hour, so it stands alone and moves on.
    expect(hour.value).toBe("9");
    expect(onChange).toHaveBeenLastCalledWith("09:30");
    await user.keyboard("45");
    expect(minute.value).toBe("45");
    expect(onChange).toHaveBeenLastCalledWith("09:45");
  });

  it("passes the host's key handling through — every dialog stops its own Escape", () => {
    const onKeyDown = vi.fn();
    const r = render(
      <TimeField value="17:30" onChange={vi.fn()} onKeyDown={onKeyDown} aria-label="due" />,
    );
    fireEvent.keyDown(r.getByLabelText("due (h)"), { key: "Escape" });
    expect(onKeyDown).toHaveBeenCalled();
  });
});
