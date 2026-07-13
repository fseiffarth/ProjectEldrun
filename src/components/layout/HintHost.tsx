import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useHintsStore } from "../../stores/hints";
import { useTabsStore } from "../../stores/tabs";
import { useTourStore } from "../../stores/tour";
import { HINTS, pickHint, type HintActionId, type HintCtx, type HintId } from "../../lib/hints";
import {
  codexHookNeedsTrust,
  openCodexHooksTab,
  type CodexHookState,
} from "../../lib/codexHooks";
import { HintBubble } from "../common/HintBubble";

/** Handlers for hints that carry a one-click action (`HintDef.action`). */
const HINT_ACTIONS: Record<HintActionId, () => void> = {
  "codex-hooks": openCodexHooksTab,
};

// Don't surface anything until the app has settled (project load, the startup
// fullscreen/resize churn), then space proactive hints out so they never feel
// like a popup storm — one at a time, with a gap after each dismissal.
const GRACE_MS = 3_000;
const GAP_MS = 12_000;

/**
 * The contextual-hint engine: watches app state, picks the next eligible hint
 * (pure `pickHint`), and renders it as a single anchored `HintBubble`. Mounted
 * once in `AppShell`. Selection/ordering/persistence live in `lib/hints.ts` and
 * `stores/hints.ts`; this component owns timing, anchor measurement, and Esc.
 */
export function HintHost() {
  const projectCount = useProjectsStore((s) => s.projects.length);
  const activeId = useProjectsStore((s) => s.activeId);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const projectsLoaded = useProjectsStore((s) => s.loaded);
  const seenList = useSettingsStore((s) => s.settings?.hints_seen);
  const hintsEnabled = useSettingsStore((s) => s.settings?.hints_enabled ?? true);
  const active = useHintsStore((s) => s.active);
  const show = useHintsStore((s) => s.show);
  const dismiss = useHintsStore((s) => s.dismiss);
  const disableAll = useHintsStore((s) => s.disableAll);
  // The guided tour is a fuller-screen overlay; suppress contextual hints while
  // it runs so the two onboarding surfaces never paint at once.
  const tourActive = useTourStore((s) => s.active);

  // Codex hook trust. Only probed once a Codex tab actually exists, so users who
  // never touch Codex are never nagged about it. Re-probed on window focus, which
  // is when the user comes back from having (maybe) enabled it in Codex's /hooks
  // list — and once it reports enabled, the hint is retired for good.
  const tabsByScope = useTabsStore((s) => s.tabsByScope);
  const hasCodexTab = useMemo(
    () => Object.values(tabsByScope).some((tabs) => tabs.some((t) => t.cmd === "codex")),
    [tabsByScope],
  );
  const [codexHook, setCodexHook] = useState<CodexHookState | null>(null);
  const markSeen = useHintsStore((s) => s.markSeen);

  useEffect(() => {
    if (!hasCodexTab) return;
    let cancelled = false;
    const probe = () => {
      invoke<CodexHookState>("codex_hook_status")
        .then((state) => {
          if (cancelled) return;
          setCodexHook(state);
          if (state === "enabled") markSeen("codex-hook-trust");
        })
        .catch(() => {});
    };
    probe();
    window.addEventListener("focus", probe);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", probe);
    };
  }, [hasCodexTab, markSeen]);

  const mountedAt = useRef(Date.now());
  const lastClearedAt = useRef(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const def = active ? HINTS.find((h) => h.id === active) ?? null : null;

  // Decide whether/when to surface the next hint. Re-runs whenever the context,
  // the seen-set, or the active hint changes.
  useEffect(() => {
    if (active) return; // one at a time
    if (tourActive) return; // never surface a hint over the guided tour
    if (!settingsLoaded || !projectsLoaded || !hintsEnabled) return;
    const seen = new Set<string>(Array.isArray(seenList) ? (seenList as string[]) : []);
    const ctx: HintCtx = {
      projectCount,
      activeId,
      codexHookNeedsTrust: hasCodexTab && codexHookNeedsTrust(codexHook),
    };
    const candidate = pickHint(ctx, seen, hintsEnabled);
    if (!candidate) return;
    const earliest = Math.max(mountedAt.current + GRACE_MS, lastClearedAt.current + GAP_MS);
    const delay = Math.max(0, earliest - Date.now());
    const t = window.setTimeout(() => {
      // Re-check on fire: nothing surfaced meanwhile and it's still eligible.
      if (useHintsStore.getState().active) return;
      const seenNow = new Set<string>(
        (useSettingsStore.getState().settings?.hints_seen as string[] | undefined) ?? [],
      );
      const stillOn = pickHint(ctx, seenNow, hintsEnabled);
      if (stillOn === candidate) show(candidate as HintId);
    }, delay);
    return () => window.clearTimeout(t);
  }, [
    active,
    tourActive,
    settingsLoaded,
    projectsLoaded,
    hintsEnabled,
    seenList,
    projectCount,
    activeId,
    hasCodexTab,
    codexHook,
    show,
  ]);

  // Measure the active hint's anchor and keep it positioned as the window/layout
  // shifts. Banners (no anchor) stay centered via CSS, so rect stays null.
  useEffect(() => {
    if (!def) {
      setRect(null);
      return;
    }
    if (!def.anchor) {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(def.anchor as string);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener("resize", measure, true);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure, true);
      window.removeEventListener("scroll", measure, true);
    };
  }, [def]);

  // While an anchored hint is on screen, pulse the element it points at so the
  // eye lands on the thing to click. Re-resolved per active hint; cleaned up on
  // dismissal/change so the class never lingers on stale chrome.
  useEffect(() => {
    if (!def?.anchor) return;
    const el = document.querySelector(def.anchor);
    if (!el) return;
    el.classList.add("hint-target");
    return () => el.classList.remove("hint-target");
  }, [def]);

  // Esc dismisses the active hint while one is shown.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss(active);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, dismiss]);

  if (!def) return null;
  // An anchored hint whose target isn't currently in the DOM: hold (don't paint
  // a stray floating box). Banners (no anchor) always render.
  if (def.anchor && !rect) return null;

  return (
    <HintBubble
      rect={rect}
      placement={def.placement}
      title={def.title}
      body={def.body}
      action={
        def.action && { label: def.action.label, run: HINT_ACTIONS[def.action.id] }
      }
      onDismiss={() => {
        lastClearedAt.current = Date.now();
        dismiss(def.id);
      }}
      onDisableAll={disableAll}
    />
  );
}
