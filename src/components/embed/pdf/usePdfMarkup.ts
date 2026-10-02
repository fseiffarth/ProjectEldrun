/**
 * The desktop PDF viewer's markup mode — its layer, storage, Submit and pill
 * (`docs/pdf_markup_rounds_plan.md` §2.6). The marks are the phone's own
 * (`mobile-web/src/markup/`): the same vectors in page points, the same
 * rounds (sent marks dim and are never sent again), the same IndexedDB store
 * — in this webview, keyed by the project and the file's absolute path, never
 * in the project folder or the session state — and the same pill machine.
 *
 * Submit bakes the marked copy (`pdf_markup_submit`), then queues the prompt
 * for an agent tab of the same project as a send-now schedule and holds it for
 * the CLI's own queue (`holdPhonePrompt`), exactly as a phone prompt sent
 * mid-turn: typed in at once, never waiting an hour for an idle point.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fileMtime } from "../fileAccess";
import { useT } from "../../../lib/i18n";
import { holdPhonePrompt } from "../../../lib/agents/phoneHolds";
import {
  blobBase64,
  markupErrorCode,
  markupReasonKey,
  submitPdfMarkup,
  type PdfMarkupPage,
} from "../../../lib/viewers/pdfMarkup";
import { agentTabStateOf, lastTabReadAt, useActivityStore } from "../../../stores/activity";
import { queuePromptForTab } from "../../../stores/agents/agentPrompts";
import { useTabsStore, type TabEntry } from "../../../stores/tabs";
import {
  addMark,
  canAdd,
  canReplace,
  clearPage as clearLayerPage,
  clearSent as clearLayerSent,
  commit,
  hasSent,
  isEmpty,
  markedPages,
  markSent,
  redo as redoHistory,
  replaceMark,
  startHistory,
  undo as undoHistory,
  type History,
  type Layer,
  type Mark,
  type MarkColor,
  type TextMark,
} from "../../../../mobile-web/src/markup/layer";
import { layerPng } from "../../../../mobile-web/src/markup/rasterize";
import { layerKey, loadLayer, saveLayer, stale, type Fingerprint } from "../../../../mobile-web/src/markup/store";
import {
  followRound,
  nextCheck,
  startRound,
  stepRound,
  type Round,
} from "../../../../mobile-web/src/markup/submitState";

export type MarkupTool = "ink" | "box" | "text" | "eraser";

/** A note being typed: where it goes, and which existing note it replaces. */
export type NoteDraft = {
  n: number;
  /** The page's size, in the units the note is placed in. */
  pageSize: [number, number];
  at: [number, number];
  index: number | null;
  text: string;
  color: MarkColor;
  size: number;
};

/** An agent tab of the project a Submit can go to. */
export type MarkupTarget = { scheduleTargetId: string; label: string; ptyId: string };

/** The project's agent tabs that can take a scheduled prompt, in tab order. */
export function agentTargets(projectId: string, tabs: readonly TabEntry[] | undefined): MarkupTarget[] {
  return (tabs ?? []).flatMap((tab) =>
    (tab.kind === "agent" || tab.kind === "local_agent") && tab.scheduleTargetId
      ? [{ scheduleTargetId: tab.scheduleTargetId, label: tab.label, ptyId: `${projectId}:${tab.key}` }]
      : [],
  );
}

/** The tab a Submit goes to when the reader has not picked one: the one last
 *  deliberately opened (`lastTabReadAt`), else the first. */
export function defaultTarget(
  targets: readonly MarkupTarget[],
  readAt: (ptyId: string) => number | undefined = lastTabReadAt,
): MarkupTarget | null {
  let best: MarkupTarget | null = null;
  let bestAt = -1;
  for (const target of targets) {
    const at = readAt(target.ptyId) ?? 0;
    if (best === null || at > bestAt) {
      best = target;
      bestAt = at;
    }
  }
  return best;
}

/** The layer's undo history and the strokes in flight on top of it. */
export type MarkupEdit = {
  /** What is drawn: a gesture's scratch layer while one is in flight. */
  layer: Layer;
  /** The committed layer gestures build on. */
  base: Layer;
  showSent: boolean;
  tool: MarkupTool;
  color: MarkColor;
  /** A Submit is uploading: drawing waits. */
  busy: boolean;
  note: NoteDraft | null;
  /** Adds a finished mark; `false` when the layer is at the backend's ceiling. */
  add: (n: number, size: [number, number], mark: Mark) => boolean;
  scratch: (next: Layer | null) => void;
  commit: (next: Layer) => void;
  openNote: (draft: NoteDraft) => void;
  editNote: (text: string) => void;
  saveNote: (text: string | null) => void;
  cancelNote: () => void;
};

export function usePdfMarkup({
  projectId,
  scope,
  path,
  active,
  visible,
  pageCount,
  docSize,
  docVersion,
}: {
  /** The project the viewer is scoped to, when markup is offered at all. */
  projectId: string | null;
  /** The viewer's file scope, for the mtime read. */
  scope: string | null;
  /** The PDF's absolute path. */
  path: string;
  /** Markup mode is on. */
  active: boolean;
  /** The pane is on screen — the stored layer is read only then. */
  visible: boolean;
  /** Pages in the loaded document; marks past it are kept, not sent. */
  pageCount: number;
  /** The loaded file's size in bytes. */
  docSize: number | null;
  /** Bumped by every load of the document — the fingerprint is read again. */
  docVersion: number;
}) {
  const t = useT();
  const key = useMemo(() => (projectId ? layerKey(projectId, { files: path }) : null), [projectId, path]);

  const [history, setHistory] = useState<History>(() => startHistory());
  const [scratchLayer, setScratchLayer] = useState<Layer | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loaded = key !== null && loadedKey === key;
  const [storage, setStorage] = useState<"saved" | "unsaved">("saved");
  const [storedFingerprint, setStoredFingerprint] = useState<Fingerprint | null>(null);
  const [changed, setChanged] = useState(false);
  const [fingerprint, setFingerprint] = useState<Fingerprint | null>(null);
  const [tool, setToolState] = useState<MarkupTool>("ink");
  const [color, setColor] = useState<MarkColor>("red");
  const [showSent, setShowSent] = useState(true);
  const [note, setNote] = useState<NoteDraft | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [roundTick, setRoundTick] = useState(0);
  /** The file changed on disk and its new pages wait for Reload. */
  const [pdfStale, setPdfStale] = useState(false);
  /** Reloaded since the agent last finished: Reload steps back to secondary. */
  const [reloaded, setReloaded] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);

  const skipSave = useRef(false);
  const pendingSave = useRef(false);
  /** A Reload is under way from the file read as this fingerprint: the record
   *  waits for the new one. */
  const reloadingRef = useRef<Fingerprint | null | false>(false);
  const fingerprintRef = useRef(fingerprint);
  fingerprintRef.current = fingerprint;
  const docSizeRef = useRef(docSize);
  docSizeRef.current = docSize;

  // ── The file's fingerprint, read again after every load ──────────────────
  useEffect(() => {
    if (!projectId || docVersion < 0) return;
    let live = true;
    void fileMtime(path, scope).then(
      (modified) => {
        const size = docSizeRef.current;
        if (live && size !== null) setFingerprint({ size, modified });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [projectId, path, scope, docVersion]);

  // ── The stored layer, once per file, read while the pane is on screen ────
  useEffect(() => {
    if (!key || !visible || loadedKey === key) return;
    let live = true;
    void loadLayer(key).then((stored) => {
      if (!live) return;
      setScratchLayer(null);
      setNote(null);
      setRound(null);
      setChanged(false);
      // Nothing to write back until the first change.
      skipSave.current = true;
      if (stored === "unavailable") {
        setStorage("unsaved");
        setHistory(startHistory());
        setStoredFingerprint(null);
      } else if (stored) {
        // Not saved straight back: that would stamp the file's current
        // fingerprint on marks drawn against an older one.
        setStorage("saved");
        setHistory(startHistory(stored.layer));
        setStoredFingerprint(stored.fingerprint);
      } else {
        setStorage("saved");
        setHistory(startHistory());
        setStoredFingerprint(null);
      }
      setLoadedKey(key);
    });
    return () => {
      live = false;
    };
  }, [key, visible, loadedKey]);

  // Marks drawn against another version of the file say so until a Reload.
  useEffect(() => {
    if (!loaded || !storedFingerprint || !fingerprint || reloadingRef.current !== false) return;
    if (stale({ layer: history.present, fingerprint: storedFingerprint, saved: 0 }, fingerprint)
      && (!isEmpty(history.present) || hasSent(history.present))) {
      setChanged(true);
    }
  }, [loaded, storedFingerprint, fingerprint, history.present]);

  // ── Saved as each change lands, with the file it was drawn on ────────────
  useEffect(() => {
    if (!loaded || !key) return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    pendingSave.current = true;
  }, [history.present, loaded, key]);
  useEffect(() => {
    if (!loaded || !key || !pendingSave.current || !fingerprint) return;
    // Reloading: the marks are saved as they change, and once more with the new
    // file's fingerprint when it has been read — from then on they sit on it.
    const waiting = reloadingRef.current !== false && fingerprint === reloadingRef.current;
    if (reloadingRef.current !== false && !waiting) {
      reloadingRef.current = false;
      setChanged(false);
    }
    pendingSave.current = waiting;
    const layer = history.present;
    const at = fingerprint;
    void saveLayer(key, layer, at).then((ok) => {
      setStorage(ok ? "saved" : "unsaved");
      if (ok) setStoredFingerprint(at);
    });
  }, [history.present, fingerprint, loaded, key]);

  // ── Targets ───────────────────────────────────────────────────────────────
  const tabs = useTabsStore((s) => (projectId ? s.tabsByScope[projectId] : undefined));
  const targets = useMemo(() => (projectId ? agentTargets(projectId, tabs) : []), [projectId, tabs]);
  // The default is fixed when markup comes on (or the chosen tab closes), so
  // looking at another tab meanwhile does not move it under the reader.
  useEffect(() => {
    if (!active) return;
    if (chosen && targets.some((target) => target.scheduleTargetId === chosen)) return;
    const next = defaultTarget(targets)?.scheduleTargetId ?? null;
    if (next !== chosen) setChosen(next);
  }, [active, targets, chosen]);
  const target = targets.find((entry) => entry.scheduleTargetId === chosen) ?? null;
  const agent = useActivityStore((s) => (target ? agentTabStateOf(s, target.ptyId) : "idle"));

  // ── The round: what the agent does with the last Submit ──────────────────
  const layer = scratchLayer ?? history.present;
  const sentShown = hasSent(history.present);
  useEffect(() => {
    if (!round) {
      // Opened again over sent marks: the pill shows once the agent works.
      if (active && sentShown && agent !== "idle") setRound(followRound(agent, Date.now()));
      return;
    }
    const now = Date.now();
    const next = stepRound(round, agent, now);
    if (next !== round) {
      if (next.phase === "finished") setReloaded(false);
      setRound(next);
      return;
    }
    const wait = nextCheck(round, agent, now);
    if (wait === null) return;
    const timer = window.setTimeout(() => setRoundTick((tick) => tick + 1), wait);
    return () => window.clearTimeout(timer);
  }, [round, agent, active, sentShown, roundTick]);

  // ── Editing ───────────────────────────────────────────────────────────────
  const historyRef = useRef(history);
  historyRef.current = history;
  const add = useCallback((n: number, size: [number, number], mark: Mark) => {
    if (!canAdd(historyRef.current.present, n, mark)) {
      setLimitHit(true);
      return false;
    }
    setLimitHit(false);
    setHistory((now) => commit(now, addMark(now.present, n, size, mark)));
    return true;
  }, []);
  const commitLayer = useCallback((next: Layer) => {
    setScratchLayer(null);
    setHistory((now) => commit(now, next));
  }, []);
  /** `text` null deletes the note being edited. */
  const saveNote = useCallback(
    (text: string | null) => {
      const draft = note;
      setNote(null);
      if (!draft) return;
      // Every control character but the line break — the backend refuses them.
      const clean = (text ?? "").replace(/(?!\n)\p{Cc}/gu, "").trim();
      const mark: TextMark | null = clean
        ? { kind: "text", color: draft.color, at: draft.at, size: draft.size, text: clean }
        : null;
      if (draft.index === null) {
        if (mark) add(draft.n, draft.pageSize, mark);
        return;
      }
      if (mark && !canReplace(historyRef.current.present, draft.n, draft.index, mark)) {
        setLimitHit(true);
        return;
      }
      const index = draft.index;
      setHistory((now) => commit(now, replaceMark(now.present, draft.n, index, mark)));
    },
    [note, add],
  );

  const edit: MarkupEdit = {
    layer,
    base: history.present,
    showSent,
    tool,
    color,
    busy: sending,
    note,
    add,
    scratch: setScratchLayer,
    commit: commitLayer,
    openNote: setNote,
    editNote: (text) => setNote((draft) => (draft ? { ...draft, text } : draft)),
    saveNote,
    cancelNote: () => setNote(null),
  };

  const setTool = useCallback((next: MarkupTool) => {
    setToolState(next);
    setColor((was) => (next === "box" && was !== "yellow" ? "yellow" : next === "ink" && was === "yellow" ? "red" : was));
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────
  /** The marked pages a Submit carries: a page past the end of the PDF (it
   *  shrank on a Reload) keeps its marks, but they are not drawn or sent. */
  const marked = markedPages(history.present);
  const sendable = marked.filter((n) => n <= pageCount);
  const leftOut = marked.length - sendable.length;

  const submit = useCallback(async () => {
    if (!projectId || !target || sending || note) return;
    const reason = (error: unknown) => {
      const code = markupErrorCode(error);
      return t(markupReasonKey(code), { code });
    };
    const present = history.present;
    const pages = markedPages(present).filter((n) => n <= pageCount);
    if (!pages.length) return;
    setSending(true);
    setFailure(null);
    let prompt: string;
    try {
      const body: PdfMarkupPage[] = [];
      for (const n of pages) {
        const page = present.pages[n];
        body.push({ n, size: page.size, marks: page.marks, layerPng: await blobBase64(await layerPng(page)) });
      }
      prompt = (await submitPdfMarkup(projectId, path, body)).prompt;
    } catch (error) {
      setSending(false);
      setFailure(t("pdfMarkup.sendFailed", { reason: reason(error) }));
      return;
    }
    // Read before the prompt goes in: a working agent takes it into its queue.
    const queued = agentTabStateOf(useActivityStore.getState(), target.ptyId) === "working";
    try {
      const { id } = await queuePromptForTab(projectId, target.scheduleTargetId, prompt);
      holdPhonePrompt(id);
    } catch (error) {
      setSending(false);
      setFailure(t("pdfMarkup.queueFailed", { reason: reason(error) }));
      return;
    }
    // The round's marks go to the sent side — dimmed, never sent again, past
    // undo — and marking goes on for the next round.
    setScratchLayer(null);
    setHistory((now) => startHistory(markSent(now.present, pages)));
    setShowSent(true);
    setReloaded(false);
    setRound(startRound(queued, Date.now()));
    setSending(false);
  }, [projectId, target, sending, note, history.present, pageCount, path, t]);

  /** About to load the file's new pages under the layer: the sent marks stay
   *  on show so the reader can check the agent's changes against them and
   *  erase them by hand; the record is stamped with the new file once its
   *  fingerprint is read. */
  const beforeReload = useCallback(() => {
    setPdfStale(false);
    setReloaded(true);
    reloadingRef.current = fingerprintRef.current;
    pendingSave.current = true;
  }, []);

  const hasMarks = !isEmpty(history.present) || sentShown;
  return {
    key,
    loaded,
    storage,
    changed,
    edit,
    tool,
    setTool,
    color,
    setColor,
    showSent,
    setShowSent,
    limitHit,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo: () => setHistory(undoHistory),
    redo: () => setHistory(redoHistory),
    clearPage: (n: number) => setHistory((now) => commit(now, clearLayerPage(now.present, n, showSent))),
    clearSent: () => setHistory((now) => commit(now, clearLayerSent(now.present))),
    hasUnsent: !isEmpty(history.present),
    sentShown,
    /** Marks are on the file, or a round is out: a new version waits for Reload. */
    holdsReload: active && (hasMarks || round !== null),
    targets,
    target,
    chooseTarget: setChosen,
    agent,
    round,
    reloaded,
    stale: pdfStale,
    markStale: () => setPdfStale(true),
    clearStale: () => setPdfStale(false),
    beforeReload,
    sending,
    failure,
    dismissFailure: () => setFailure(null),
    sendable,
    leftOut,
    submit,
  };
}

export type PdfMarkup = ReturnType<typeof usePdfMarkup>;
