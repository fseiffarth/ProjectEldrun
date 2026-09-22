/**
 * The glyph(s) leading a tab's label (`TabStatusMark`). One mark per thing the
 * tab is doing: the agent's own turn in the status green, a command it is
 * running in the shell colour — and BOTH when an agent works with a shell of
 * its own going (`services::agent_turn`'s `job` flag), which is the one state
 * the single-colour ring cannot say on its own.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TabStatusMark } from "../../components/tabs/TabLocalityBadges";

function marks(stateClass: string) {
  const { container } = render(<TabStatusMark stateClass={stateClass} />);
  return [...container.querySelectorAll(".tab-status-mark")].map((el) => ({
    glyph: el.textContent,
    shell: el.classList.contains("shell"),
  }));
}

describe("TabStatusMark", () => {
  it("marks an agent's own turn once, in the agent's colour", () => {
    expect(marks(" working")).toEqual([{ glyph: "▶", shell: false }]);
  });

  it("marks a tab that is only running a command in the shell colour", () => {
    expect(marks(" working shell")).toEqual([{ glyph: "▶", shell: true }]);
  });

  it("marks an agent working with a command of its own with two play marks", () => {
    expect(marks(" working job")).toEqual([
      { glyph: "▶", shell: false },
      { glyph: "▶", shell: true },
    ]);
  });

  it("keeps the other two states one mark each", () => {
    expect(marks(" needs-decision")).toEqual([{ glyph: "?", shell: false }]);
    expect(marks(" finished")).toEqual([{ glyph: "✓", shell: false }]);
    expect(marks("")).toEqual([]);
  });
});
