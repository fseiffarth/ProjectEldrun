/**
 * The Agents view of the Files / Git / Apps / Agents row: every agent tab of
 * the scope (and only that scope) with its schedule summary, plus the scope's
 * collected prompts. "Send now" must write a one-time schedule at the current
 * minute against the chosen tab's schedule target, through the same command
 * the dialog uses.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import { AgentSchedulesView } from "../components/agents/AgentSchedulesView";
import { useAgentPromptsStore } from "../stores/agentPrompts";
import { scheduleCacheKey, useAgentSchedulesStore } from "../stores/agentSchedules";
import { useActivityStore } from "../stores/activity";
import { localOccurrenceKey } from "../lib/agentSchedule";
import { useTabsStore, type TabEntry } from "../stores/tabs";

const agent: TabEntry = {
  key: "agent-1",
  label: "Claude",
  cmd: "claude",
  cwd: "/project",
  kind: "agent",
  sessionId: "session-abc",
  scheduleTargetId: "target-1",
};
const shell: TabEntry = { key: "shell-1", label: "Shell", cmd: "bash", cwd: "/project", kind: "shell" };
const foreign: TabEntry = { ...agent, key: "agent-2", label: "Other project", scheduleTargetId: "target-2" };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "agent_prompts_list") {
      return [{ id: "prompt-1", message: "Run the tests", created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:00:00Z" }];
    }
    if (command === "agent_schedule_upsert" || command === "agent_schedules_list") return [];
    if (command === "agent_prompt_upsert" || command === "agent_prompt_delete") return [];
    if (command === "agent_prompt_archive" || command === "agent_prompt_history_list") return [];
    return [];
  });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, loading: {} });
  useTabsStore.setState((state) => ({
    ...state,
    tabsByScope: { p: [agent, shell], q: [foreign] },
  }));
});

describe("AgentSchedulesView", () => {
  it("lists the scope's agent tabs only and loads their schedules", async () => {
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    const rows = screen.getAllByTestId("agent-prompts-tab");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Claude");
    expect(screen.queryByText("Other project")).toBeNull();
    expect(vi.mocked(invoke).mock.calls.some(([command, args]) =>
      command === "agent_schedules_list" && (args as { scheduleTargetId: string }).scheduleTargetId === "target-1")).toBe(true);
    expect(vi.mocked(invoke).mock.calls.some(([, args]) =>
      (args as { scheduleTargetId?: string })?.scheduleTargetId === "target-2")).toBe(false);
  });

  it("sends a collected prompt as a one-time schedule at the current minute on the target tab", async () => {
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    expect(await screen.findByText("Run the tests")).toBeTruthy();
    // The target is chosen in the row, at the moment of the send — there is no
    // view-wide target dropdown any more.
    await act(async () => {
      fireEvent.click(screen.getByText("Send now"));
    });
    expect(screen.getByText("Send to which tab?")).toBeTruthy();
    // Scoped to the picker: the tab's own row names it too, as the button that
    // jumps to it.
    const picker = screen.getByRole("group", { name: "Send to which tab?" });
    await act(async () => {
      fireEvent.click(within(picker).getByRole("button", { name: /Claude/ }));
    });
    const upsert = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_schedule_upsert");
    expect(upsert).toBeTruthy();
    const args = upsert![1] as { projectId: string; scheduleTargetId: string; schedule: { message: string; rule: { type: string; at: string } } };
    expect(args.projectId).toBe("p");
    expect(args.scheduleTargetId).toBe("target-1");
    expect(args.schedule.message).toBe("Run the tests");
    expect(args.schedule.rule.type).toBe("once");
    expect(args.schedule.rule.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(screen.getByText(/Queued for Claude/)).toBeTruthy();
    // Sending retires the prompt to the history, with the session it went to.
    const archive = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_prompt_archive");
    expect(archive).toBeTruthy();
    const sent = (archive![1] as {
      promptId: string;
      sent: { tab_label: string; session_id: string | null; agent: string | null };
    });
    expect(sent.promptId).toBe("prompt-1");
    expect(sent.sent.tab_label).toBe("Claude");
    expect(sent.sent.session_id).toBe("session-abc");
    expect(sent.sent.agent).toBe("claude");
    // The queued schedule carries the prompt's own id, so the delivery the
    // scheduler records later lands on this row instead of adding a second.
    expect((upsert![1] as { schedule: { id: string } }).schedule.id).toBe("prompt-1");
  });

  /**
   * The row says what an agent is doing in the TAB RING's four states, not the
   * schedule palette's — including the one a border shows and this view used to
   * swallow: finished, unseen. Idle is the fourth because a border has no mark
   * for "nothing to say".
   */
  it("paints the agent's state in the tab ring's own vocabulary", async () => {
    useActivityStore.setState({ busyByTab: {}, attentionByTab: { "p:agent-1": "done" } });
    const { rerender } = await act(async () => render(<AgentSchedulesView scope="p" active />));
    const pill = () => screen.getAllByTestId("agent-prompts-tab")[0].querySelector(".agent-schedule-pill")!;
    expect(pill().className).toContain("is-agent-done");
    expect(pill().textContent).toBe("Finished");

    // Working outranks a finished mark left over from the last run…
    await act(async () => {
      useActivityStore.setState({ busyByTab: { "p:agent-1": true } });
      rerender(<AgentSchedulesView scope="p" active />);
    });
    expect(pill().className).toContain("is-agent-working");

    // …and a decision still waiting on the user outranks working.
    await act(async () => {
      useActivityStore.setState({ attentionByTab: { "p:agent-1": "decision" } });
      rerender(<AgentSchedulesView scope="p" active />);
    });
    expect(pill().className).toContain("is-agent-decision");

    await act(async () => {
      useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
      rerender(<AgentSchedulesView scope="p" active />);
    });
    expect(pill().className).toContain("is-agent-idle");
  });

  /**
   * A row that names an agent and says what it is waiting for has one useful
   * next step: going there. Both the name and the spelled-out button take it.
   */
  it.each(["Claude", "\u2197 Go to"])("jumps to the agent's tab from %s", async (label) => {
    useTabsStore.setState({
      scope: "p",
      layoutByScope: { p: { type: "group", id: "g-p", tabKeys: ["agent-1", "shell-1"], activeKey: "shell-1" } },
      focusedGroupByScope: {},
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
      fullscreenGroupId: null,
    });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: label }));
    });
    expect(useTabsStore.getState().activeKey).toBe("agent-1");
    const layout = useTabsStore.getState().layoutByScope.p;
    expect(layout?.type === "group" && layout.activeKey).toBe("agent-1");
  });

  /**
   * Agent tabs list folded: the composer is one click away, so a scope with
   * several agents still shows its schedules and collected prompts without
   * scrolling past a column of open fields.
   */
  it("folds each agent tab's composer until it is opened", async () => {
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    expect(screen.queryByLabelText("Ask Claude…")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Prompt" }));
    });
    expect(screen.getByLabelText("Ask Claude…")).toBeTruthy();
  });

  /**
   * A "Send to this tab" becomes a one-time rule at the minute now passing, so
   * it has no NEXT occurrence: the row's summary line could only ever say "no
   * next run" about it. The prompt the user had just sent therefore disappeared
   * into a row that claimed nothing was scheduled — a send that looked like it
   * had done nothing. The queue is now on the row, in full.
   */
  it("shows the prompts a tab is holding, and the send's own receipt beside the button", async () => {
    const at = localOccurrenceKey(new Date(Date.now() - 60_000));
    const queued = { id: "prompt-9", enabled: true, message: "check the build", rule: { type: "once", at } };
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_schedule_upsert" || command === "agent_schedules_list") return [queued];
      if (command === "agent_prompts_list" || command === "agent_prompt_history_list") return [];
      return [];
    });

    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });

    const row = () => screen.getAllByTestId("agent-prompts-tab")[0];
    expect(within(row()).getByTestId("agent-prompts-queued").textContent).toContain("check the build");
    // …and the summary line names the wait instead of "no next run".
    expect(row().textContent).toContain("1 prompt(s) waiting for this agent");

    // The receipt for the send is rendered in the composer, not in the
    // view-wide banner two sections below where the sender never sees it.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Prompt" }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Ask Claude…"), { target: { value: "check the build" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Send to this tab"));
    });
    expect(within(row()).getByTestId("agent-composer-notice").textContent).toContain("Queued for Claude");
  });

  it("submits the composer's prefix chips and model pick ahead of the prompt", async () => {
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Prompt" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "/clear" }));
      fireEvent.change(screen.getByLabelText("Ask Claude…"), { target: { value: "check the build" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Send to this tab"));
    });
    const upsert = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_schedule_upsert");
    const schedule = (upsert![1] as { schedule: { message: string; preface?: string[] } }).schedule;
    expect(schedule.message).toBe("check the build");
    expect(schedule.preface).toEqual(["/clear"]);
  });

  /**
   * Ctrl/⌘+Enter sends the composer without reaching for the button — plain
   * Enter has to stay a newline, since a prompt is usually more than one line.
   */
  it("sends the composer on Ctrl+Enter and leaves plain Enter a newline", async () => {
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Prompt" }));
    });
    const field = screen.getByLabelText("Ask Claude…");
    await act(async () => {
      fireEvent.change(field, { target: { value: "check the build" } });
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "agent_schedule_upsert")).toBe(false);
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    });
    const upsert = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_schedule_upsert");
    expect((upsert![1] as { schedule: { message: string } }).schedule.message).toBe("check the build");
  });

  it("collects a new prompt for the scope", async () => {
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Summarise the diff" } });
      fireEvent.click(screen.getByText("Add prompt"));
    });
    const upsert = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_prompt_upsert");
    expect(upsert).toBeTruthy();
    expect((upsert![1] as { projectId: string; prompt: { message: string } }).projectId).toBe("p");
    expect((upsert![1] as { prompt: { message: string } }).prompt.message).toBe("Summarise the diff");
  });

  /**
   * The Sent prompts list is where a scheduled delivery ends up: what happened
   * to it, the prompt, the tab and agent it went to, the session that took it,
   * and both times — when it was due and when it actually went.
   */
  it("shows a scheduled delivery with its outcome, agent, session and times", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_prompts_list") return [];
      if (command === "agent_prompt_history_list") {
        return [
          {
            id: "rule-1@2026-09-02T09:00",
            message: "Morning standup",
            created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
            sent_at: new Date(Date.now() - 60_000).toISOString(),
            tab_label: "Claude",
            session_id: "session-abcdef123456",
            agent: "claude",
            result: "delivered",
            scheduled_for: "2026-09-02T09:00",
            preface: ["/clear"],
          },
          {
            id: "prompt-9",
            message: "Waiting one",
            created_at: new Date().toISOString(),
            sent_at: new Date().toISOString(),
            tab_label: "Claude",
          },
        ];
      }
      return [];
    });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });

    const rows = await screen.findAllByTestId("agent-prompts-sent");
    // Newest first: the queued one was sent last.
    expect(rows[0].textContent).toContain("Queued");
    const delivered = rows[1];
    expect(delivered.textContent).toContain("Delivered");
    expect(delivered.textContent).toContain("Morning standup");
    expect(delivered.textContent).toContain("claude");
    // The whole id, not a prefix: it is what gets pasted into `--resume`.
    expect(delivered.textContent).toContain("session session-abcdef123456");
    expect(delivered.textContent).toContain("/clear");
    expect(delivered.textContent).toMatch(/was due .*9:00|was due .*09:00/);
    expect(delivered.textContent).toContain("collected 3 days ago");
  });

  /** The prompt text is written to be pasted somewhere else, so getting it back
   *  is one click on the row rather than a selection. */
  it("copies a collected prompt's text from its row", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    const copy = await screen.findByLabelText("Copy this prompt");
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(writeText).toHaveBeenCalledWith("Run the tests");
  });

  /**
   * The collected list is ordered, and the order is the file's — so a drag has
   * to be written down. The gesture is `hooks/useListReorder`'s (pointer
   * events, because WebKitGTK does not deliver HTML5 DnD); the keyboard nudge
   * on the focused grip is the same commit, which is what this drives.
   */
  it("persists a reordered collected prompt", async () => {
    const stamp = new Date().toISOString();
    const collected = [
      { id: "prompt-1", message: "Run the tests", created_at: stamp, updated_at: stamp },
      { id: "prompt-2", message: "Write the docs", created_at: stamp, updated_at: stamp },
    ];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "agent_prompts_list") return collected;
      // The backend answers with the list in its new order — the store adopts
      // that answer over the order it staged.
      if (command === "agent_prompt_reorder") {
        const { ids } = args as { ids: string[] };
        return ids.map((id) => collected.find((prompt) => prompt.id === id));
      }
      return [];
    });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    const grips = await screen.findAllByLabelText(/Drag to reorder/);
    expect(grips).toHaveLength(2);
    await act(async () => {
      fireEvent.keyDown(grips[1], { key: "ArrowUp" });
    });
    const call = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_prompt_reorder");
    expect(call).toBeTruthy();
    expect(call![1]).toEqual({ projectId: "p", ids: ["prompt-2", "prompt-1"] });
    // The list paints in its new order without waiting for the round trip.
    const rows = screen.getAllByTestId("agent-prompts-row");
    expect(rows[0].textContent).toContain("Write the docs");
  });

  /**
   * Edit rewrites a collected prompt where it is read. The row becomes the
   * field; the composer at the foot of the section stays what it is — the place
   * a NEW prompt is written — so a half-written one survives an edit, and the
   * saved prompt keeps its id and its place in the order.
   */
  it("edits a collected prompt in its own row, leaving the new-prompt composer alone", async () => {
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    expect(await screen.findByText("Run the tests")).toBeTruthy();
    const composer = screen.getByPlaceholderText("Write a prompt to keep for later…") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Half a new prompt" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    });
    const field = screen.getByLabelText("Edit this prompt") as HTMLTextAreaElement;
    expect(field.value).toBe("Run the tests");
    // The row it belongs to, not a field somewhere else on the page.
    expect(screen.getByTestId("agent-prompts-row").contains(field)).toBe(true);
    expect(composer.value).toBe("Half a new prompt");

    fireEvent.change(field, { target: { value: "Run the tests twice" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    const call = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_prompt_upsert");
    expect(call).toBeTruthy();
    expect(call![1]).toMatchObject({
      projectId: "p",
      prompt: { id: "prompt-1", message: "Run the tests twice" },
    });
    expect(screen.queryByLabelText("Edit this prompt")).toBeNull();
    expect(composer.value).toBe("Half a new prompt");
  });

  /**
   * Tags make the collection a library: they are typed as one line beside the
   * text, stored as tokens, shown as chips, and a chip narrows the list.
   */
  it("saves tags with a prompt and narrows the library by a tag chip", async () => {
    const stamp = new Date().toISOString();
    const collected = [
      { id: "prompt-1", message: "Run the tests", created_at: stamp, updated_at: stamp, tags: ["tests"] },
      { id: "prompt-2", message: "Tighten the abstract", created_at: stamp, updated_at: stamp, tags: ["paper", "writing"] },
    ];
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_prompts_list" || command === "agent_prompt_upsert") return collected;
      return [];
    });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    expect(await screen.findByText("Run the tests")).toBeTruthy();

    // A new prompt carries the tags typed beside it, normalized.
    fireEvent.change(screen.getByPlaceholderText("Write a prompt to keep for later…"), { target: { value: "Cite the survey" } });
    fireEvent.change(screen.getByPlaceholderText("Tags, comma-separated — e.g. refactor, tests, paper"), { target: { value: "#Paper, Related Work" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Add prompt"));
    });
    const upsert = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_prompt_upsert");
    expect(upsert![1]).toMatchObject({
      projectId: "p",
      prompt: { message: "Cite the survey", tags: ["paper", "related-work"] },
    });

    // Editing a row shows its tags in the field and writes them back.
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    });
    const tagField = screen.getAllByTestId("agent-prompts-row")[0].querySelector("input") as HTMLInputElement;
    expect(tagField.value).toBe("tests");
    fireEvent.change(tagField, { target: { value: "tests, ci" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    const edit = vi.mocked(invoke).mock.calls.filter(([command]) => command === "agent_prompt_upsert").pop();
    expect(edit![1]).toMatchObject({ prompt: { id: "prompt-1", message: "Run the tests", tags: ["tests", "ci"] } });

    // The library chips: one per tag in use; pressing one narrows the list.
    const chips = screen.getAllByTitle("Show only prompts tagged #paper");
    await act(async () => {
      fireEvent.click(chips[0]);
    });
    const rows = screen.getAllByTestId("agent-prompts-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Tighten the abstract");
    expect(screen.getByText("Showing 1 of 2")).toBeTruthy();
    // Searching `#tag` looks at tags only.
    fireEvent.change(screen.getByLabelText("Search prompts or tags… (#tag matches tags only)"), {
      target: { value: "#writ" },
    });
    expect(screen.getAllByTestId("agent-prompts-row")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByText("Clear filters"));
    });
    expect(screen.getAllByTestId("agent-prompts-row")).toHaveLength(2);
  });

  /**
   * Prompt blame on a sent row: the commit the agent started from, and the
   * files that changed until it went idle — each a click into the filter.
   */
  it("shows a sent prompt's commit and touched files, and filters by a file", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_prompts_list") return [];
      if (command === "agent_prompt_history_list") {
        return [
          {
            id: "blamed",
            message: "Split the parser",
            created_at: new Date().toISOString(),
            sent_at: new Date().toISOString(),
            tab_label: "Claude",
            agent: "claude",
            result: "delivered",
            tags: ["refactor"],
            commit: "d5d74e2abcdef0123456789",
            branch: "develop",
            files: ["src/lib/parser.ts", "src/__tests__/parser.test.ts"],
            files_at: new Date().toISOString(),
          },
          {
            id: "pending",
            message: "Still running",
            created_at: new Date().toISOString(),
            sent_at: new Date().toISOString(),
            tab_label: "Claude",
            result: "delivered",
            commit: "1111111abcdef",
          },
        ];
      }
      return [];
    });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    const rows = await screen.findAllByTestId("agent-prompts-sent");
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain("develop @ d5d74e2");
    expect(rows[1].textContent).toContain("#refactor");
    expect(rows[1].textContent).toContain("2 file(s) touched");
    // Delivered, commit known, agent not yet idle: the files are still to come.
    expect(rows[0].textContent).toContain("commit 1111111");
    expect(rows[0].textContent).toContain("Files are recorded once the agent goes idle");

    await act(async () => {
      fireEvent.click(screen.getByText("src/lib/parser.ts"));
    });
    expect(screen.getAllByTestId("agent-prompts-sent")).toHaveLength(1);
    expect(screen.getByText("Showing 1 of 2")).toBeTruthy();
  });

  it("leaves a prompt as it was when an edit is cancelled", async () => {
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    expect(await screen.findByText("Run the tests")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    });
    const field = screen.getByLabelText("Edit this prompt");
    fireEvent.change(field, { target: { value: "Something else" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Escape" });
    });
    expect(screen.queryByLabelText("Edit this prompt")).toBeNull();
    expect(screen.getByText("Run the tests")).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "agent_prompt_upsert")).toBe(false);
  });

  /**
   * The Sent prompts list is a bounded record of everything that reached an
   * agent, and it is opened with narrow questions. The facets compose, and the
   * count says what is being hidden.
   */
  it("filters the sent prompts by agent, outcome, time and text", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_prompt_history_list") {
        return [
          {
            id: "old-codex",
            message: "Rewrite the parser",
            created_at: new Date(Date.now() - 9 * 86_400_000).toISOString(),
            sent_at: new Date(Date.now() - 9 * 86_400_000).toISOString(),
            tab_label: "Codex",
            agent: "codex",
            result: "failed",
          },
          {
            id: "new-claude",
            message: "Summarise the diff",
            created_at: new Date().toISOString(),
            sent_at: new Date().toISOString(),
            tab_label: "Claude",
            agent: "claude",
            result: "delivered",
          },
        ];
      }
      return [];
    });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    expect(await screen.findAllByTestId("agent-prompts-sent")).toHaveLength(2);
    expect(screen.getByText("2 sent")).toBeTruthy();

    // Text search reaches the prompt itself.
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search prompt, tab, agent, session, tag or file…"), {
        target: { value: "parser" },
      });
    });
    let rows = screen.getAllByTestId("agent-prompts-sent");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Rewrite the parser");
    expect(screen.getByText("Showing 1 of 2")).toBeTruthy();

    // Clearing the filters restores the whole record.
    await act(async () => {
      fireEvent.click(screen.getByText("Clear filters"));
    });
    expect(screen.getAllByTestId("agent-prompts-sent")).toHaveLength(2);

    // The agent picker offers only the agents this project has talked to.
    await act(async () => {
      fireEvent.click(screen.getByTitle("Agent"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "codex" }));
    });
    rows = screen.getAllByTestId("agent-prompts-sent");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Codex");

    // …and it composes with the time window, which this entry falls outside of.
    await act(async () => {
      fireEvent.click(screen.getByTitle("When it was sent"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Last 7 days" }));
    });
    expect(screen.queryAllByTestId("agent-prompts-sent")).toHaveLength(0);
    expect(screen.getByText("No sent prompt matches these filters.")).toBeTruthy();
  });

  it("copies a sent prompt's whole session id from the row", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_prompt_history_list") {
        return [
          {
            id: "rule-1@2026-09-02T09:00",
            message: "Morning standup",
            created_at: new Date().toISOString(),
            sent_at: new Date().toISOString(),
            tab_label: "Claude",
            session_id: "session-abcdef123456",
            agent: "claude",
            result: "delivered",
          },
        ];
      }
      return [];
    });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });

    const copy = await screen.findByLabelText("Copy this session id");
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(writeText).toHaveBeenCalledWith("session-abcdef123456");
  });
  it("marks a collected prompt that a tab already has a schedule for", async () => {
    useAgentSchedulesStore.setState({
      byTarget: {
        [scheduleCacheKey("p", "target-1")]: [
          {
            id: "rule-1",
            enabled: true,
            message: "Run the tests",
            rule: { type: "daily", time: "09:00" },
          },
        ],
      },
      loading: {},
    });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    expect(await screen.findByText("Run the tests")).toBeTruthy();
    const mark = screen.getByTestId("agent-prompts-scheduled");
    expect(mark.textContent).toContain("Scheduled");
    expect(mark.textContent).toContain("Claude");
  });

  it("moves a scheduled prompt out of the library and into the Scheduled section", async () => {
    useAgentSchedulesStore.setState({
      byTarget: {
        [scheduleCacheKey("p", "target-1")]: [
          {
            id: "rule-1",
            enabled: true,
            message: "Run the tests",
            rule: { type: "daily", time: "09:00" },
          },
        ],
      },
      loading: {},
    });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    // The scope's one prompt now has a rule, so the library above says it is
    // empty and the row reads under Scheduled prompts instead.
    expect(await screen.findByText("Run the tests")).toBeTruthy();
    expect(screen.getByText("No prompts collected yet.")).toBeTruthy();
    expect(screen.queryByText("No prompt is scheduled.")).toBeNull();
    const scheduledSection = screen.getByText("Scheduled prompts").closest("section") as HTMLElement;
    expect(scheduledSection.textContent).toContain("Run the tests");
  });

  it("leaves a collected prompt unmarked when no rule carries its text", async () => {
    useAgentSchedulesStore.setState({
      byTarget: {
        [scheduleCacheKey("p", "target-1")]: [
          {
            id: "rule-1",
            enabled: true,
            message: "Something else entirely",
            rule: { type: "daily", time: "09:00" },
          },
        ],
      },
      loading: {},
    });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    expect(await screen.findByText("Run the tests")).toBeTruthy();
    expect(screen.queryByTestId("agent-prompts-scheduled")).toBeNull();
  });
});
