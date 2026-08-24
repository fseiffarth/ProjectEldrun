import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../components/terminal/TerminalView", () => ({
  TerminalView: ({ id, focused }: { id: string; focused: boolean }) => (
    <div data-testid={id} data-focused={String(focused)} />
  ),
}));

import { TabPane } from "../components/tabs/TabPane";
import type { TabEntry } from "../stores/tabs";

const tab = (key: string): TabEntry => ({
  key,
  scope: "p",
  label: key,
  cmd: "",
  cwd: "/p",
  kind: "shell",
});

describe("TabPane terminal focus", () => {
  it("does not equate visibility with keyboard focus in a split", () => {
    render(
      <>
        <TabPane
          tab={tab("a")}
          scope="p"
          visible
          focused
          filesProjectDir="/p"
          terminalCwd="/p"
        />
        <TabPane
          tab={tab("b")}
          scope="p"
          visible
          focused={false}
          filesProjectDir="/p"
          terminalCwd="/p"
        />
      </>,
    );
    expect(screen.getByTestId("p:a").getAttribute("data-focused")).toBe("true");
    expect(screen.getByTestId("p:b").getAttribute("data-focused")).toBe("false");
  });
});
