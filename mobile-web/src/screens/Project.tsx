import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_SORTS, DEFAULT_AGENT_SORT, isAgentSort, sortAgentTabs, type AgentSort } from "../../../shared/agentSort";
import { promptClock, promptLines, promptsFromTranscript } from "../agentPrompts";
import { ApiError, api, closeTab, deleteOutboxFile, listOutbox, outboxFileUrl, reorderTab, type AgentRow, type OutboxFile, type ProjectDetail, type TabPlace, type TabRow, type TabSchedules } from "../api";
import { OUTBOX_POLL, sameOutbox } from "../outbox";
import { readChoice, writeChoice } from "../prefs";
import { useRowDrag } from "../rowDrag";
import { applyServerOrder, placeBeside } from "../tabReorder";
import { ColorSheet } from "./ColorSheet";
import { NewTabSheet } from "./NewTabSheet";
import { PromptsSheet } from "./PromptsSheet";
import { RenameSheet } from "./RenameSheet";
import { ScheduleSheet } from "./ScheduleSheet";
import { AgentStatusPill } from "../components/AgentStatusPill";
import { OutboxGallery } from "../components/OutboxGallery";
import { OutboxGrid } from "../components/OutboxGrid";
import { OutboxViewer } from "../components/OutboxViewer";
import { tabColorCss } from "../tabColors";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

/** The orders this list offers, in the words this screen can use for them. The
 * cross-project Agents list calls `native` "Status", because there the arrival
 * order is the sidecar's status ranking; here it is the desktop's own tab
 * order, which is the thing a reader arranges by hand — so here it is
 * "Manual", and it is the only order a drag can be dropped into. */
const SORT_LABEL: Record<AgentSort, string> = {
  lastWorking: "Last working",
  lastDone: "Last done",
  native: "Manual (tab order)",
};

/** How long a closed row is held back from the catalog before the phone gives
 *  up and shows it again. The desktop writes the session file before it answers
 *  "closed", so the catalog agrees within one of its own reads — this is the
 *  outer bound, not the expected wait. Past it the close plainly did not take,
 *  and a row hidden for ever would be a tab the reader can neither see nor
 *  close again. */
const CLOSED_HELD_MS = 30_000;

/** How many of the desktop's files the shelf under the tab cards shows. The
 * sidecar lists up to forty, and a screen that ends in forty thumbnails is a
 * screen whose tabs are three scrolls away — the rest are one tap behind the
 * shelf's own button, in the gallery sheet the Focus screen opens. */
const SHELF_FILES = 6;

/** The line under an agent tab, in the words the desktop's Agents view uses:
 * how many prompts are scheduled and when the first one fires. The desktop
 * computed both against its own clock, so the phone only formats them. */
function scheduleLine(schedules: TabSchedules | undefined): string {
  if (!schedules) return "Schedules need desktop Eldrun";
  if (schedules.total === 0) return "No scheduled prompts";
  const count = schedules.enabled === schedules.total
    ? `${schedules.total} scheduled`
    : `${schedules.enabled} of ${schedules.total} scheduled`;
  // Desktop-local wall clock, year trimmed: the sheet below spells out the
  // time zone this belongs to.
  return `${count} · ${schedules.next ? `next ${schedules.next.slice(5).replace("T", " ")}` : "no next run"}`;
}

/**
 * What this session was last asked, on the card itself.
 *
 * Always open, and never a disclosure: the question a project screen is opened
 * with is "which of these five tabs is the one I set on the docs" — a label
 * like "claude 3" cannot answer it, and an expander answers it one tap at a
 * time. The newest prompt leads and is given room to wrap; the ones behind it
 * are one line each, enough to recognize a session by its recent history
 * without turning the card into a transcript (the Focus view is that).
 */
function PromptLines({ tab }: { tab: TabRow }) {
  const lines = promptLines(tab);
  return <div className="tab-card-prompts">
    <small className="tab-card-prompts-label">Last prompts</small>
    {lines.length === 0
      ? <p className="tab-card-prompt empty">{promptsFromTranscript(tab)
        ? "Nothing read from this session's transcript yet."
        : "OpenCode's own history is not read yet — prompts sent from Eldrun show here."}</p>
      : lines.map((prompt, index) => {
        const when = promptClock(prompt.at);
        return <p className={index === 0 ? "tab-card-prompt latest" : "tab-card-prompt"} key={`${prompt.at ?? ""}-${index}`}>
          {when && <span className="tab-card-prompt-when">{when}</span>}
          <span className="tab-card-prompt-text">{prompt.text}</span>
        </p>;
      })}
  </div>;
}

/**
 * A freshly read catalog with the rows this phone has closed taken back out.
 *
 * The desktop persists its tab layout before it answers "closed", but the read
 * that carries the answer back to this screen need not be the next one to
 * arrive: the poll that was already in flight when the ✕ was pressed answers
 * with the pre-close list, and the sidecar may serve its own snapshot for a
 * moment longer. Dropping the row from the list in hand (`dropTab`) survives
 * neither, so a closed card used to spring back for a whole poll cycle.
 *
 * An id is forgotten the moment a load no longer carries it — the catalog has
 * agreed and nothing needs holding — and forgotten regardless after
 * `CLOSED_HELD_MS`, so a close that never reached disk shows its row again
 * rather than leaving a live tab invisible.
 */
function withoutClosed(detail: ProjectDetail, closed: Map<string, number>): ProjectDetail {
  if (closed.size === 0) return detail;
  const now = Date.now();
  for (const [tabId, at] of closed) {
    if (now - at > CLOSED_HELD_MS || !detail.tabs.some((row) => row.id === tabId)) closed.delete(tabId);
  }
  return closed.size === 0
    ? detail
    : { ...detail, tabs: detail.tabs.filter((row) => !closed.has(row.id)) };
}

export function Project({ id, back, terminal }: { id: string; back: () => void; terminal: (tab: TabRow) => void }) {
  const t = useT();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState("");
  /** The agent tab whose scheduled prompts are open. Lives on this screen so a
   * schedule can be set without attaching to the session at all. */
  const [scheduleTab, setScheduleTab] = useState<{ tab: TabRow; initialMessage?: string } | null>(null);
  /** The project's collected prompts (no tab); "Schedule…" there hands a
   * prompt to the per-tab sheet above with the text prefilled. */
  const [promptsOpen, setPromptsOpen] = useState(false);
  /** The header's ＋: what to open next — a shell, or one of the desktop's
   * agents in one of its modes. */
  const [newTabOpen, setNewTabOpen] = useState(false);
  /** The agent tab being renamed. The desktop owns the tab layout, so the sheet
   * writes through the bridge and the next poll brings the new label back. */
  const [renameTab, setRenameTab] = useState<TabRow | null>(null);
  /** What the desktop sent this project (`eldrun-send` → `.eldrun/outbox/`),
   * newest first — the shelf under the tab cards. The files belong to the
   * project, not to a session, so this screen reads them by the project: a
   * file sent from a tab that has since been closed is still here. */
  const [outbox, setOutbox] = useState<OutboxFile[]>([]);
  /** Whether the whole listing is up, in the same sheet the Focus screen's
   * gallery button opens — the shelf shows `SHELF_FILES` of it. */
  const [galleryOpen, setGalleryOpen] = useState(false);
  /** The file open full screen (a picture or a text preview). */
  const [fileOpen, setFileOpen] = useState<OutboxFile | null>(null);
  const outboxScope = useMemo(() => ({ project: id }), [id]);
  /** The tab whose colour is being picked (#264), of any kind the phone lists —
   * colouring is how a row of look-alike sessions is told apart, which is as
   * true of five shells as of five agents. */
  const [colorTab, setColorTab] = useState<TabRow | null>(null);
  /** The tab whose ✕ was pressed. The sheet asks before anything is closed: the
   *  button sits a thumb-width from the one that opens the terminal, and the
   *  answer is worth reading — closing leaves the session running. */
  /** The tab whose close is in flight — its ✕ is held until the desktop answers. */
  const [closingId, setClosingId] = useState<string | null>(null);
  /** The tabs this phone has closed, each against the moment it was answered,
   *  held back from every load until the catalog agrees (`withoutClosed`). */
  const closed = useRef(new Map<string, number>());
  /** The reader's order for this project's tabs, kept on the phone. The
   * default is the desktop Agents view's, by the same shared function: a tab
   * asking something, then the ones working now, then the rest by their last
   * finished turn. A shell (or an agent with no turn this session) has no
   * reading and sinks, keeping the tab bar's order among its kind. */
  const [sort, setSort] = useState<AgentSort>(() => readChoice("projectTabsSort", isAgentSort, DEFAULT_AGENT_SORT));
  const chooseSort = (next: AgentSort) => { setSort(next); writeChoice("projectTabsSort", next); };
  const tabs = useMemo(() => sortAgentTabs(detail?.tabs ?? [], sort, (tab) => ({
    decision: tab.agent_status === "question",
    working: tab.agent_status === "working",
    workingAt: tab.working_at,
    doneAt: tab.done_at,
  })), [detail?.tabs, sort]);
  /** Rearranging by hand is offered under the manual order alone. The other two
   * are computed from what the agents did, so a dropped row would spring back
   * the next time one of them worked — the same rule the desktop's own drag
   * follows. */
  const canReorder = sort === "native" && tabs.length > 1;
  const pendingKeys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  /** A move the desktop has not answered yet. The poll is paused across it: the
   * list is already showing where the row was dropped, and a reply carrying the
   * pre-drop order would yank it back for a second. */
  const moving = useRef(false);
  const load = useCallback(() => {
    if (inFlight.current || moving.current) return Promise.resolve();
    inFlight.current = true;
    return api<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}`)
      .then((next) => { setDetail(withoutClosed(next, closed.current)); setError(""); })
      // Keep the last good view rather than blanking the tab list: on a poll
      // this fast, one dropped packet used to wipe the screen and flash the
      // "Desktop unavailable" notice on every flaky-signal hiccup.
      .catch((reason) => setError(`Host unavailable: ${String(reason)}`))
      .finally(() => { inFlight.current = false; });
  }, [id]);
  useEffect(() => {
    // A 1.5s poll is a full catalog load plus a desktop round trip, 40 times a
    // minute, and it ran while the phone's screen was off.
    let timer = 0;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void load();
    };
    void load();
    timer = window.setInterval(tick, 5_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);
  /** Reads the outbox now and every `OUTBOX_POLL` while the page is visible;
   * coming back to the page reads it at once. A listing that could not be
   * fetched keeps what was shown — the next poll retries, and a missing shelf
   * would read as "the desktop sent nothing", which is a different thing. */
  useEffect(() => {
    setOutbox([]);
    setGalleryOpen(false);
    setFileOpen(null);
    let stopped = false;
    let inflight: AbortController | undefined;
    const poll = () => {
      if (stopped || document.visibilityState === "hidden") return;
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      void listOutbox({ project: id }, controller.signal).then(
        (files) => {
          if (stopped || controller.signal.aborted || !Array.isArray(files)) return;
          setOutbox((current) => sameOutbox(current, files) ? current : files);
        },
        () => {},
      );
    };
    poll();
    const timer = window.setInterval(poll, OUTBOX_POLL);
    document.addEventListener("visibilitychange", poll);
    return () => {
      stopped = true;
      inflight?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [id]);
  useEffect(() => {
    if (!fileOpen && !galleryOpen) return;
    // The viewer opens over the gallery, so Escape closes the top one first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (fileOpen) setFileOpen(null);
      else setGalleryOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fileOpen, galleryOpen]);
  /** A PDF opens in the browser's own viewer; a picture or text full screen
   * here — the Focus screen's gallery does the same with the same files. */
  const openFile = useCallback((file: OutboxFile) => {
    if (file.kind === "application/pdf") window.open(outboxFileUrl({ project: id }, file.name), "_blank", "noopener");
    else setFileOpen(file);
  }, [id]);
  /** Removes one file the desktop sent, from the tile's own confirm. The row is
   * dropped here rather than by the next poll — an 8 s wait on a tile that has
   * already been answered reads as the delete not having worked — and the sheet
   * closes with the last file, where it would otherwise stand empty. */
  const removeFile = useCallback(async (file: OutboxFile) => {
    await deleteOutboxFile({ project: id }, file.name);
    setOutbox((current) => {
      const left = current.filter((row) => row.name !== file.name);
      if (left.length === 0) setGalleryOpen(false);
      return left;
    });
    setFileOpen((open) => open?.name === file.name ? null : open);
  }, [id]);
  const create = async (kind: "shell" | "agent", agent?: AgentRow, mode?: string) => {
    setCreating(true); setError("");
    const action = `${kind}:${agent?.id ?? ""}:${mode ?? ""}`;
    const idempotencyKey = pendingKeys.current.get(action) ?? crypto.randomUUID();
    pendingKeys.current.set(action, idempotencyKey);
    try {
      const body = await api<{ tab: TabRow }>(`/api/v1/projects/${encodeURIComponent(id)}/tabs`, { method: "POST", body: JSON.stringify({ project_id: id, kind, agent_id: agent?.id, mode, idempotency_key: idempotencyKey }) });
      pendingKeys.current.delete(action);
      terminal(body.tab);
    } catch (reason) { setError(String(reason)); void load(); } finally { setCreating(false); }
  };
  /** Drop the row here rather than reloading, and remember that it is gone: the
   *  next catalog read can still be carrying the tab that was just closed — the
   *  poll in flight when the ✕ was pressed certainly is — and a row dropped from
   *  the list in hand alone springs back with it (`withoutClosed`). */
  const dropTab = (id: string) => {
    closed.current.set(id, Date.now());
    setDetail((prev) => prev ? { ...prev, tabs: prev.tabs.filter((row) => row.id !== id) } : prev);
  };
  /** Close on the tap, as the desktop's × does — no sheet in between. It is the
   *  same act on both surfaces, through the same desktop seam: the tab leaves
   *  the Eldrun window and the local tmux session it minted ends with it (a
   *  session on a remote host keeps running). */
  const close = async (tab: TabRow) => {
    setClosingId(tab.id);
    setError("");
    try {
      await closeTab(tab.id);
      dropTab(tab.id);
    } catch (cause) {
      setError(cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable")
        ? "Open desktop Eldrun to close a tab."
        : "The tab could not be closed.");
    } finally {
      setClosingId(null);
    }
  };
  /** Move one tab beside another and tell the desktop, which owns the layout
   *  this order is. The list is rearranged first — a drop that waits for a
   *  round trip before it moves anything reads as a dropped gesture — and then
   *  reconciled with the order the desktop answers with; a refused move puts
   *  the row back where it was and says why. */
  const commitMove = async (key: string, anchorId: string, place: TabPlace) => {
    const before = (detail?.tabs ?? []).map((row) => row.id);
    setDetail((prev) => prev ? { ...prev, tabs: placeBeside(prev.tabs, (row) => row.id, key, anchorId, place) } : prev);
    moving.current = true;
    setError("");
    try {
      const answer = await reorderTab(key, anchorId, place);
      setDetail((prev) => prev ? { ...prev, tabs: applyServerOrder(prev.tabs, (row) => row.id, answer.tabs ?? []) } : prev);
    } catch (cause) {
      setDetail((prev) => prev ? { ...prev, tabs: applyServerOrder(prev.tabs, (row) => row.id, before) } : prev);
      setError(cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable")
        ? "Open desktop Eldrun to rearrange tabs."
        : "The tab could not be moved.");
    } finally {
      moving.current = false;
    }
  };

  /** The gesture around that move — the captured pointer, the edge scrolling and
   *  the arrow keys — which the home screen's project cards wear too
   *  (`rowDrag.ts`). Under the computed orders the grips are not drawn at all;
   *  `canReorder` also makes them inert, so a stale one cannot move a row that
   *  the next agent's turn would spring back. */
  const drag = useRowDrag(tabs.map((row) => row.id), (key, anchorId, place) => void commitMove(key, anchorId, place), canReorder);

  const activate = async () => {
    setActivating(true); setError("");
    try {
      await api(`/api/v1/projects/${encodeURIComponent(id)}/activate`, { method: "POST" });
      void load();
    } catch (reason) { setError(String(reason)); void load(); } finally { setActivating(false); }
  };
  return <main className="screen">
    {/* One line, read the way an agent tab's header reads: the chevron out, the
        name in the middle with the room a long one needs, and this list's own
        control on the right. The order was a row of its own above the cards, and
        a phone screen has about five of those to spend on tab cards.

        The same three orders the desktop Agents view offers, remembered per
        phone. "Manual" is this screen's name for the arrival order, because here
        that order is the desktop's own tab order — the one a drag writes into. */}
    <header>
      <button className="back" onClick={back}>‹</button>
      <div className="terminal-title"><h1>{detail?.project.label ?? "Project"}</h1></div>
      {/* The same 🖼 the Focus screen carries, in the same place and the same
          class: the shelf below stands under however many tab cards the project
          has, so on a project with a screenful of them everything the desktop
          sent was past the end of the scroll — and the outbox is the project's,
          not a session's. */}
      {outbox.length > 0 && <button
        className="terminal-gallery"
        onClick={() => setGalleryOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={galleryOpen}
        aria-label={t("mobile.outbox.galleryOpen", { count: outbox.length })}
        title={t("mobile.outbox.region")}
      ><span aria-hidden="true">🖼</span><small>{outbox.length}</small></button>}
      {tabs.length > 1 && <label className="activity-sort in-header">
        <span>Sort</span>
        <select aria-label="Sort tabs" value={sort} onChange={(event) => { if (isAgentSort(event.target.value)) chooseSort(event.target.value); }}>
          {AGENT_SORTS.map((value) => <option key={value} value={value}>{SORT_LABEL[value]}</option>)}
        </select>
      </label>}
      {/* Opening a session is what this screen is for, so it sits where the
          thumb already is rather than under however many cards the project has
          (`NewTabSheet`). Disabled without the desktop, which is the same
          condition the buttons down there carried — the notice below says why. */}
      <button
        className="primary new-tab"
        disabled={creating || !detail?.desktop_available}
        onClick={() => setNewTabOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={newTabOpen}
        aria-label="New tab"
        title="New agent or shell"
      ><span aria-hidden="true">＋</span></button>
    </header>
    {/* Only once the host has answered: `!detail?.desktop_available` was also
        true while the first load was in flight, so every project opened on a
        "Desktop unavailable" notice that vanished a moment later. */}
    {detail && !detail.desktop_available && <p className="notice">Desktop unavailable — existing sessions can still be opened, but activating a project and creating tabs require Eldrun.</p>}
    {error && <p className="error">{error}</p>}
    {canReorder && <p className="reorder-hint">Drag <span aria-hidden="true">⠿</span> to arrange — this is the desktop's own tab order, so the Eldrun window follows. {isUntested("mobile.project.reorder") && <span className="untested">Untested</span>}</p>}
    <section className="cards">{tabs.map((tab) => <div
      className={`tab-card${tabColorCss(tab.color) ? " has-tab-color" : ""}${drag.rowClass(tab.id)}`}
      key={tab.id}
      ref={drag.rowRef(tab.id)}
      // The desktop marks a coloured tab with its bottom rule; a phone card has
      // no such edge to spend, so the colour becomes the card's left border —
      // the same "which of these five is which" job, in the shape this surface
      // has. The id→hex mapping is the desktop's (see `tabColors.ts`), so the
      // two surfaces show one colour rather than two readings of a name.
      style={tabColorCss(tab.color) ? { ["--tab-color" as string]: tabColorCss(tab.color) } : undefined}
    >
      <div className="tab-card-head">
      {/* The colour chooser is the dot in the card's upper-left corner: it
          shows the tab's colour (a hollow ring when it has none) and opens the
          sheet, so the foot keeps its width for the worded actions. */}
      <button className="tab-card-dot" onClick={() => setColorTab(tab)} aria-haspopup="dialog" aria-expanded={colorTab?.id === tab.id} aria-label={`Colour ${tab.label}`}><span aria-hidden="true" /></button>
      {/* The card opens the session; on an agent tab its name renames it.
          A button cannot hold a button, so the opener is a sibling stretched
          over the whole card — head, prompts and foot — and the controls that
          are not it sit above it. The name carries the model beside it and
          nothing under it: the CLI's own name repeated under every card bought
          little and pushed each card's prompts a line further down. */}
      <div className={`card tab-card-main${tab.available ? "" : " unavailable"}`}>
        <span>
          <span className="tab-card-title">
            {tab.kind === "agent"
              ? <button className="tab-card-name" onClick={() => setRenameTab(tab)} aria-haspopup="dialog" aria-expanded={renameTab?.id === tab.id} aria-label={`Rename ${tab.label}`} title="Rename"><strong>{tab.label}</strong></button>
              : <strong>{tab.label}</strong>}
            {tab.agent_model && <small className="tab-card-model" title="The model this session shows on its own status line.">{tab.agent_model}</small>}
          </span>
        </span>
        {/* A shell card is one row, so its › stays here; an agent card carries
            the same cluster on its foot instead, out of the ✕'s reach. */}
        {tab.kind !== "agent" && <span className="card-trailing">{tab.agent_status && <AgentStatusPill status={tab.agent_status} />}<span>›</span></span>}
      </div>
      {/* Close is the card's top-right ✕, where a phone looks for it; every tab
          the phone lists offers it, shell included. */}
      <button className="tab-card-icon tab-card-close" disabled={closingId !== null} onClick={() => void close(tab)} aria-label={`Close ${tab.label}`} title="Close"><span aria-hidden="true">✕</span></button>
      {/* The grip, under the manual order only. It is also the keyboard's way
          in: the arrows move the tab one place, which a drag cannot be asked
          for without a finger. */}
      {canReorder && <button
        className="tab-card-grip"
        aria-label={`Move ${tab.label}`}
        title="Drag to move this tab, or use the arrow keys"
        {...drag.gripProps(tab.id)}
      ><span aria-hidden="true">⠿</span></button>}
      </div>
      {tab.kind === "agent" && <PromptLines tab={tab} />}
      {/* Scheduling lives out here beside the tab, not inside the session:
          reaching a schedule must not mean attaching a terminal, and this is
          the same place — and the same summary line — the desktop puts it.
          The ◷ leading the line opens the tab's schedules; agent tabs only. */}
      {tab.kind === "agent" && <div className="tab-card-foot">
        <button className="tab-card-icon accent" onClick={() => setScheduleTab({ tab })} aria-haspopup="dialog" aria-expanded={scheduleTab?.tab.id === tab.id} aria-label={`Scheduled prompts for ${tab.label}`} title="Scheduled prompts"><span aria-hidden="true">◷</span></button>
        <small className="tab-card-when" title={tab.schedules?.next ? `Next run ${tab.schedules.next.replace("T", " ")} (desktop time)` : undefined}>{scheduleLine(tab.schedules)}</small>
        {/* The state and the › that says the card opens, at the card's
            bottom-right corner. They read the same as on a shell card's right
            edge, a whole card away from the ✕ a thumb must not find here. */}
        <span className="card-trailing">{tab.agent_status && <AgentStatusPill status={tab.agent_status} />}<span>›</span></span>
      </div>}
      {/* Last, so it lies over the whole card: a tap anywhere the controls above
          have not claimed — the › on the foot included — opens the session. */}
      <button className="tab-card-open" disabled={!tab.available} onClick={() => terminal(tab)} aria-label={`Open ${tab.label}`} />
    </div>)}</section>
    {/* What the desktop sent this project, under the tabs: `eldrun-send` puts a
        file in `.eldrun/outbox/` and it shows up here within a poll, whichever
        tab it was sent from — the project is what the outbox belongs to. The
        shelf is drawn only when there is something on it; the newest
        `SHELF_FILES` stand here and the button below opens the whole listing in
        the same sheet the Focus screen's gallery button does — it is there
        whenever the shelf is, not only once the shelf has to cut something off.
        Reaching everything the desktop sent was otherwise a thing only a
        session could do, and the outbox belongs to the project. */}
    {outbox.length > 0 && <section className="outbox-shelf" aria-label={t("mobile.outbox.shelf")}>
      <div className="outbox-shelf-head">
        <h2>{t("mobile.outbox.fromDesktop")}</h2>
        {isUntested("mobile.project.outbox") && <span className="untested">Untested</span>}
        <small>{t(outbox.length === 1 ? "mobile.outbox.countOne" : "mobile.outbox.count", { count: outbox.length })}</small>
      </div>
      <OutboxGrid scope={outboxScope} files={outbox.slice(0, SHELF_FILES)} onOpen={openFile} onDetails={setFileOpen} onDelete={removeFile} />
      <button
        className="outbox-shelf-all"
        onClick={() => setGalleryOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={galleryOpen}
      >{t("mobile.outbox.all", { count: outbox.length })}</button>
    </section>}
    {detail?.project.status === "inactive" && <section className="create"><button className="primary" disabled={activating || !detail.desktop_available} onClick={() => void activate()}>Activate project</button></section>}
    <section className="create"><button disabled={!detail} onClick={() => setPromptsOpen(true)} aria-haspopup="dialog" aria-expanded={promptsOpen}>◷ Collected prompts</button></section>
    {/* The shell and agent buttons that stood here are the header's ＋ now: a
        project with a screenful of tabs put them past the end of the scroll. */}
    {newTabOpen && detail && <NewTabSheet
      agents={detail.agents}
      busy={creating}
      onClose={() => setNewTabOpen(false)}
      onPick={(kind, agent, mode) => { setNewTabOpen(false); void create(kind, agent, mode); }}
    />}
    {promptsOpen && detail && <PromptsSheet projectId={id} tabs={detail.tabs} onClose={() => setPromptsOpen(false)} onSchedule={(tab, initialMessage) => { setPromptsOpen(false); setScheduleTab({ tab, initialMessage }); }} />}
    {colorTab && <ColorSheet
      tab={colorTab}
      onClose={() => setColorTab(null)}
      onColored={(color) => {
        // Patch the row in place rather than reloading. The desktop persists its
        // tab layout asynchronously, so the next catalog read can still carry
        // the old colour and the card would flicker back — the same reason
        // `dropTab` above patches instead of reloading after a close.
        setColorTab((prev) => prev ? { ...prev, color } : prev);
        setDetail((prev) => prev
          ? { ...prev, tabs: prev.tabs.map((row) => row.id === colorTab.id ? { ...row, color } : row) }
          : prev);
      }}
    />}
    {renameTab && <RenameSheet tab={renameTab} onClose={() => setRenameTab(null)} onRenamed={() => { setRenameTab(null); void load(); }} />}
    {scheduleTab && <ScheduleSheet tabId={scheduleTab.tab.id} label={scheduleTab.tab.label} initialMessage={scheduleTab.initialMessage} onClose={() => setScheduleTab(null)} />}
    {/* The viewer covers the phone; the gallery stays open behind it, so
        closing the file comes back to the list it was opened from. */}
    {galleryOpen && !fileOpen && <OutboxGallery scope={outboxScope} files={outbox} onOpen={openFile} onDetails={setFileOpen} onDelete={removeFile} onClose={() => setGalleryOpen(false)} />}
    {fileOpen && <OutboxViewer key={`${id}/${fileOpen.name}`} scope={outboxScope} file={fileOpen} onClose={() => setFileOpen(null)} />}
  </main>;
}
