import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

import { PromptCard } from "../../components/agents/PromptCard";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";

const draft = {
  id: "d",
  key: "prompt:d",
  state: "draft",
  message: "Plain draft",
  tags: [],
  autoTags: [],
  strandId: "strand:t",
  prompt: { id: "d", message: "Plain draft", created_at: "x", updated_at: "x" },
} as unknown as PromptChartCard;

function renderCard(onSelect = vi.fn()) {
  const noop = vi.fn(async () => {});
  render(
    <PromptCard
      card={draft}
      matched
      selected={false}
      linking={false}
      dragging={false}
      linkOver={false}
      color="var(--accent)"
      targets={[{ id: "t", label: "Claude" }]}
      onSelect={onSelect}
      onAgent={noop}
      onSave={noop}
      onDelete={noop}
      onSend={vi.fn()}
      onSchedule={vi.fn()}
      onUnschedule={noop}
      onCollect={noop}
      onRetime={noop}
      onQueueMove={noop}
      onLink={vi.fn()}
      onUnlink={noop}
      links={[]}
      linkLabel={(id) => id}
    />,
  );
  return { article: screen.getByTestId("prompt-chart-card-draft"), onSelect };
}

describe("PromptCard keyboard route", () => {
  it("is focusable and opens and closes with Enter and Space", () => {
    const { article, onSelect } = renderCard();
    expect(article.getAttribute("tabindex")).toBe("0");
    expect(article.getAttribute("role")).toBe("button");
    expect(article.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(article, { key: "Enter" });
    expect(article.getAttribute("aria-expanded")).toBe("true");
    expect(within(article).getByRole("button", { name: "Link" })).toBeTruthy();
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(article, { key: " " });
    expect(article.getAttribute("aria-expanded")).toBe("false");
    // Any other key is not the card's.
    fireEvent.keyDown(article, { key: "a" });
    expect(article.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves keys aimed at the card's own button or editor to them", () => {
    const { article, onSelect } = renderCard();
    fireEvent.keyDown(within(article).getByRole("button", { name: "Drag to link with another card" }), { key: "Enter" });
    expect(article.getAttribute("aria-expanded")).toBe("false");
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.doubleClick(article);
    const editor = within(article).getByRole("textbox", { name: "Write a prompt to keep for later…" });
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.keyDown(editor, { key: " " });
    expect(article.getAttribute("aria-expanded")).toBe("true");
    expect(within(article).getByRole("textbox", { name: "Write a prompt to keep for later…" })).toBe(editor);
  });
});
