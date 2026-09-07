/**
 * The Markdown prompt field behind the Agents view's three prompt inputs: the
 * pure transforms that continue a list and nest one, and the field itself —
 * toolbar action, Enter continuation, Tab-only-inside-a-list, and the Preview
 * flip that renders through the repo's escape-first renderer.
 */
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownPromptField } from "../components/common/MarkdownPromptField";
import { continueList, indentLines, markerAt } from "../lib/viewers/markdownEdit";

describe("markdown prompt transforms", () => {
  it("carries a bullet onto the next line", () => {
    const value = "- first";
    const out = continueList(value, value.length);
    expect(out?.value).toBe("- first\n- ");
    expect(out?.selStart).toBe(out?.value.length);
  });

  it("increments an ordered item and keeps its delimiter", () => {
    expect(continueList("3) step", 7)?.value).toBe("3) step\n4) ");
    expect(continueList("  2. step", 9)?.value).toBe("  2. step\n  3. ");
  });

  it("empties a task item's checkbox rather than copying its tick", () => {
    const value = "- [x] done";
    expect(continueList(value, value.length)?.value).toBe("- [x] done\n- [ ] ");
  });

  it("drops the marker on an empty item — the way out of a list", () => {
    const value = "- one\n- ";
    const out = continueList(value, value.length);
    expect(out?.value).toBe("- one\n");
    expect(out?.selStart).toBe(6);
  });

  it("continues a quote and leaves prose alone", () => {
    expect(continueList("> quoted", 8)?.value).toBe("> quoted\n> ");
    expect(continueList("plain text", 5)).toBeNull();
    expect(markerAt("plain text", 5)).toBeNull();
  });

  it("nests and unnests every line the selection touches", () => {
    const value = "- one\n- two";
    const indented = indentLines(value, 0, value.length, false);
    expect(indented.value).toBe("  - one\n  - two");
    expect(indentLines(indented.value, 0, indented.value.length, true).value).toBe(value);
  });
});

// The field is controlled, so the tests drive it through a host that owns the
// value — the same shape the Agents view uses.
function Host({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownPromptField value={value} onChange={setValue} ariaLabel="Prompt" />
  );
}

describe("MarkdownPromptField", () => {
  it("wraps the selection from the toolbar", () => {
    render(<Host initial="ship it" />);
    const field = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    field.setSelectionRange(0, 4);
    fireEvent.click(screen.getByTitle("Bold"));
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("**ship** it");
  });

  it("continues a list on Enter", () => {
    render(<Host initial="- one" />);
    const field = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    field.setSelectionRange(5, 5);
    fireEvent.keyDown(field, { key: "Enter" });
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("- one\n- ");
  });

  it("takes Tab inside a list and leaves it alone in prose", () => {
    render(<Host initial="- one" />);
    let field = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    field.setSelectionRange(5, 5);
    fireEvent.keyDown(field, { key: "Tab" });
    field = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    expect(field.value).toBe("  - one");

    render(<Host initial="prose" />);
    const prose = screen.getAllByLabelText("Prompt")[1] as HTMLTextAreaElement;
    prose.setSelectionRange(5, 5);
    fireEvent.keyDown(prose, { key: "Tab" });
    expect((screen.getAllByLabelText("Prompt")[1] as HTMLTextAreaElement).value).toBe("prose");
  });

  it("renders the draft when the preview is flipped on", () => {
    render(<Host initial="# Title" />);
    fireEvent.click(screen.getByTitle("Render the prompt as Markdown"));
    expect(screen.getByTestId("md-prompt-preview").innerHTML).toContain("<h1");
    expect(screen.queryByLabelText("Prompt")).toBeNull();
  });
});
