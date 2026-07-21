import { useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useSettingsStore,
  applyTheme,
  applyZoom,
  clampZoom,
  stepZoom,
  THEME_CHANGED_EVENT,
  LANGUAGE_CHANGED_EVENT,
} from "../../stores/settings";
import { applyLanguage } from "../../lib/i18n";
import {
  DETACHED_BOUNDS,
  DETACHED_CLOSE,
  DETACHED_HIDE,
  DETACHED_EDIT,
  DETACHED_REQUEST_SEED,
  DETACHED_ZOOM,
  applyEditToSubtree,
  applyRenameToTabs,
  applyLocationToTabs,
  detachedSeedEvent,
  type DetachedEdit,
  type DetachedParam,
  type DetachedRemoteInfo,
  type DetachedSeed,
} from "../../stores/detached";
import {
  allGroups,
  orderedTabKeys,
  setDetachedViewerState,
  type LayoutNode,
  type TabEntry,
} from "../../stores/tabs";
import { useTabLandStore } from "../../stores/tabLand";
import { listenPdfReveal } from "../../stores/pdfSync";
import { listenEditorJump } from "../../stores/editorJump";
import { DetachedCenterPanel } from "./DetachedCenterPanel";

interface Props {
  param: DetachedParam;
}

/**
 * How long the detached window keeps asking the main window for its seed before
 * giving up and closing itself. The host populates `detachedGroupsByScope` and
 * answers seed requests essentially instantly (the store entry is written before
 * the OS window is even spawned), so any window that hasn't seeded within this
 * window has nothing to render — its group was closed/docked while the OS window
 * lingered, or the host is gone. Rather than strand it on "Loading subwindow…"
 * forever, auto-close it. Generous enough to outlast a slow main-window startup.
 */
const SEED_TIMEOUT_MS = 8000;

/**
 * #42: the detached window's React root. INERT to project switches by design —
 * it does NOT mount `listenProjectRuntimeSwitched`, the projects store, or
 * CenterPanel's scope-switch effect. It renders exactly one group, seeded over a
 * Tauri event from the main window, and streams edits back. The detached
 * window's *parking* is driven entirely by the backend moving its OS window
 * between desktops on project switch; its renderer stays still.
 */
export function DetachedApp({ param }: Props) {
  const loadSettings = useSettingsStore((s) => s.load);
  const label = getCurrentWindow().label;

  // The popout's content tree. Usually a single group; can become a SplitNode
  // once split-in-popout (multi-pane) lands in the renderer (Phase 2).
  const [group, setGroup] = useState<LayoutNode | null>(null);
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  // The owning project's remoteness, streamed in the seed (this window is inert to
  // the projects store). Drives the tab strip's locality badge/menu + machine
  // names; undefined for a local project (no locality axis).
  const [remoteInfo, setRemoteInfo] = useState<DetachedRemoteInfo | undefined>(undefined);

  // This popout's OWN per-window zoom. Restored from the first seed (persisted on
  // the main window's detached entry), then owned locally — Ctrl +/- adjusts it
  // and streams the change back for persistence. Held in a ref so the keydown
  // listener binds once. `zoomSeeded` guards apply-on-seed to the FIRST seed, so a
  // later re-seed (an edit, a tab docked in) can't revert the live zoom.
  const zoomRef = useRef(1);
  const zoomSeeded = useRef(false);

  // Theme injection (same as the main shell), but nothing project-switch-aware.
  // `skipZoom` so we DON'T inherit the main window's `ui_zoom` — a popout owns its
  // own zoom (applied from its seed below), which is what makes zoom per-window.
  useEffect(() => {
    void loadSettings({ skipZoom: true });
  }, [loadSettings]);

  // Per-window zoom via Ctrl +/- / Ctrl+0, handled before any editable-target
  // guard (like F11) so it works from a focused terminal too — the browser-zoom
  // convention. Scales THIS window's webview only and streams the new value back
  // to the main window so it persists on this popout's detached entry.
  useEffect(() => {
    const applyAndPersist = (z: number) => {
      const next = clampZoom(z);
      zoomRef.current = next;
      applyZoom(next);
      void emit(DETACHED_ZOOM, { scope: param.scope, groupId: param.groupId, zoom: next });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      // Agent panes consume Ctrl +/- for their own font zoom and stopPropagation,
      // so those never reach here — this only fires for the rest of the window.
      if (e.code === "Equal") {
        e.preventDefault();
        applyAndPersist(stepZoom(zoomRef.current, 1));
      } else if (e.code === "Minus") {
        e.preventDefault();
        applyAndPersist(stepZoom(zoomRef.current, -1));
      } else if (e.code === "Digit0") {
        e.preventDefault();
        applyAndPersist(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [param.scope, param.groupId]);

  // This window is its own JS runtime with its own `document` and its own copy
  // of the settings store — a theme change made in the main window's Settings
  // dialog only ever touches ITS document, so without this a popout keeps
  // whatever theme it had at open time. Re-apply live via the cross-window
  // broadcast (see THEME_CHANGED_EVENT in stores/settings).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>(THEME_CHANGED_EVENT, (e) => {
      applyTheme(e.payload);
    })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Same story for the UI language: this popout holds its own i18n store, so a
  // language switch in the main window's Settings only re-renders that window
  // without the cross-window broadcast. Re-apply live (see LANGUAGE_CHANGED_EVENT).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>(LANGUAGE_CHANGED_EVENT, (e) => {
      applyLanguage(e.payload);
    })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // #42: when a PDF tab is popped out into THIS window, a SyncTeX forward search
  // from a TeX editor in the main (or another) window reaches us only over a
  // cross-window broadcast. Register the listener so the PDF here reveals/flashes
  // the target box. (The main shell registers the mirror image.)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenPdfReveal()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // #42: SyncTeX reverse search may resolve to a source editor hosted in THIS
  // detached window while the PDF the user clicked lives elsewhere (or the jump
  // is applied in the main window). Register the cross-window jump listener so
  // our editor scrolls. (The main shell registers the mirror image.)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenEditorJump()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // WebKitGTK doesn't reliably fire DOM 'resize' / ResizeObserver for OS-level
  // window size changes. Panes (terminals especially) refit off the DOM 'resize'
  // event, so bridge Tauri's reliable window events into a DOM resize here — the
  // same bridge the main shell installs (AppShell): onResized covers monitor-size
  // switches and drag-resize, onScaleChanged covers moving to a different-DPI
  // monitor (logical viewport changes while WebKitGTK stays silent). rAF-coalesce
  // the live stream so a manual drag-resize doesn't flood listeners, plus a
  // trailing re-fire so a monitor switch measures the settled geometry rather
  // than mid-transition.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let raf = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          window.dispatchEvent(new Event("resize"));
        });
      }
      if (trailing) clearTimeout(trailing);
      trailing = setTimeout(() => {
        trailing = undefined;
        window.dispatchEvent(new Event("resize"));
      }, 250);
    };
    const win = getCurrentWindow();
    win.onResized(fire).then((fn) => unlisteners.push(fn)).catch(() => {});
    win.onScaleChanged(fire).then((fn) => unlisteners.push(fn)).catch(() => {});
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (trailing) clearTimeout(trailing);
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // #42: stream this popout's OS geometry back to the main window (the single
  // persistence owner) so it reopens at the same place/size after a restart. We
  // read position/size straight from the move/resize event payloads (no extra
  // window-getter permissions) and debounce so a drag doesn't flood the channel.
  useEffect(() => {
    const win = getCurrentWindow();
    let pos: { x: number; y: number } | null = null;
    let size = { w: 900, h: 640 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unMoved: (() => void) | undefined;
    let unResized: (() => void) | undefined;
    let cancelled = false;
    const flush = () => {
      if (!pos) return;
      void emit(DETACHED_BOUNDS, {
        scope: param.scope,
        groupId: param.groupId,
        bounds: { x: pos.x, y: pos.y, w: size.w, h: size.h },
      });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 300);
    };
    win
      .onMoved(({ payload }) => {
        pos = { x: payload.x, y: payload.y };
        schedule();
      })
      .then((fn) => { if (cancelled) fn(); else unMoved = fn; })
      .catch(() => {});
    win
      .onResized(({ payload }) => {
        size = { w: payload.width, h: payload.height };
        schedule();
      })
      .then((fn) => { if (cancelled) fn(); else unResized = fn; })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unMoved?.();
      unResized?.();
    };
  }, [param.scope, param.groupId]);

  // Seed + edit listeners. The main window owns the source of truth and ships
  // the group's tabs + subtree; subsequent main-side edits re-seed.
  //
  // The request MUST be emitted only after our seed listener is actually
  // registered (`listen` resolves async): emitting synchronously races the main
  // window's reply, which can land before we're listening and be lost forever
  // (window stuck on "Loading subwindow…"). We also retry the request until the
  // first seed arrives, so a momentarily-not-yet-ready host can't strand us.
  useEffect(() => {
    let unlistenSeed: (() => void) | undefined;
    let cancelled = false;
    let seeded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    listen<DetachedSeed>(detachedSeedEvent(label), (ev) => {
      seeded = true;
      if (timer) clearTimeout(timer);
      // Restore this popout's own zoom on the FIRST seed only (later re-seeds must
      // not clobber a live zoom the user has since changed). A popout that has its
      // OWN persisted zoom uses it; a brand-new popout with none inherits the main
      // window's current `ui_zoom` at birth (so a 4K user's popouts aren't tiny)
      // and then diverges the moment it's adjusted. Undefined on both ⇒ 100%.
      if (!zoomSeeded.current) {
        zoomSeeded.current = true;
        const mainZoom = useSettingsStore.getState().settings?.ui_zoom;
        zoomRef.current = clampZoom(ev.payload.zoom ?? mainZoom);
        applyZoom(zoomRef.current);
      }
      // Register each seeded tab's viewerState BEFORE rendering, so a viewer pane
      // mounting this frame recovers its per-tab scroll/zoom + #45 autocomplete/
      // grammar overrides (our tabs never enter `useTabsStore`, where the viewer
      // hooks normally read them). Must precede setGroup/setTabs.
      for (const t of ev.payload.tabs) setDetachedViewerState(t.key, t.viewerState);
      setGroup(ev.payload.subtree);
      setTabs(ev.payload.tabs);
      setRemoteInfo(ev.payload.remote);
      // A tab docked INTO this popout from another window arrives on a seed
      // tagged with its key — play the same drop-in landing as an in-popout
      // merge as it mounts in its destination bar (batched with the state sets
      // above, so the freshly-mounted tab renders with the landing class).
      if (ev.payload.landedKey) {
        useTabLandStore.getState().markLanded(ev.payload.landedKey);
      }
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlistenSeed = fn;
        // Listener is live — now it's safe to ask, and to keep asking until the
        // first seed lands. If none ever does (the host has no record of this
        // group), nothing can render here, so close the window after a grace
        // period instead of stranding it on "Loading subwindow…" forever.
        const deadline = Date.now() + SEED_TIMEOUT_MS;
        const request = () => {
          if (cancelled || seeded) return;
          if (Date.now() >= deadline) {
            void getCurrentWindow().destroy();
            return;
          }
          void emit(DETACHED_REQUEST_SEED, {
            label,
            scope: param.scope,
            groupId: param.groupId,
          });
          timer = setTimeout(request, 250);
        };
        request();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlistenSeed?.();
    };
  }, [label, param.scope, param.groupId]);

  // Apply an edit locally AND stream it to the main window so its
  // `detachedGroupsByScope` entry stays in sync.
  const pushEdit = (edit: DetachedEdit) => {
    setGroup((g) => (g ? applyEditToSubtree(g, edit) : g));
    if (edit.kind === "rename") {
      setTabs((ts) => applyRenameToTabs(ts, edit.key, edit.label));
    } else if (edit.kind === "setLocation") {
      // Optimistic: flip the badge now; the main window respawns the pane on the
      // new host and re-derives the same payload.
      setTabs((ts) => applyLocationToTabs(ts, edit.key, edit.location));
    }
    void emit(DETACHED_EDIT, { scope: param.scope, groupId: param.groupId, edit });
  };

  // Closing the LAST tab closes the whole popout window — an empty detached
  // window has nothing to render (it would strand on "Loading subwindow…").
  // Route it through the same teardown as a WM/title-bar close (DETACHED_CLOSE):
  // the main window kills the remaining tab's PTY, drops the group, and persists.
  // We then destroy this OS window directly (destroy() bypasses our own
  // onCloseRequested, so it won't re-emit DETACHED_CLOSE).
  const handleClose = (key: string) => {
    const isLastTab = !group || orderedTabKeys(group).length <= 1;
    if (isLastTab) {
      void emit(DETACHED_CLOSE, { scope: param.scope, groupId: param.groupId });
      void getCurrentWindow().destroy();
      return;
    }
    pushEdit({ kind: "close", key });
  };

  // Hide the WHOLE popout into the main window's right-panel "Hidden subwindows"
  // list. Like handleClose it closes THIS OS window, but the main window PARKS the
  // group (tabs stay mounted, PTYs alive) instead of discarding it — restorable
  // from the panel. Hides the whole window (every pane of a multi-pane popout) as
  // one hidden entry; destroy() bypasses our onCloseRequested so it won't also
  // emit DETACHED_CLOSE (which would drop the tabs).
  const handleHideWindow = () => {
    void emit(DETACHED_HIDE, { scope: param.scope, groupId: param.groupId });
    void getCurrentWindow().destroy();
  };

  // Close-on-close: closing this OS window via the WM/title-bar CLOSES the
  // group's tabs for good — they are not docked back and do not restore on next
  // launch (dock-back is done by Ctrl+dragging the tab bar onto the main window,
  // #42). Prevent the default close and emit
  // DETACHED_CLOSE; the MAIN window owns the teardown (kills the PTYs, drops the
  // tabs, persists) and closes this window via `attach_subwindow`. As a safety
  // net (e.g. the main window is gone and never closes us), force-destroy after a
  // short grace period so the window can't get stuck un-closable.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const win = getCurrentWindow();
    win
      .onCloseRequested((event) => {
        event.preventDefault();
        void emit(DETACHED_CLOSE, { scope: param.scope, groupId: param.groupId });
        setTimeout(() => {
          void win.destroy();
        }, 1500);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [param.scope, param.groupId]);

  if (!group || allGroups(group).length === 0) {
    return <div className="detached-loading">Loading subwindow…</div>;
  }

  return (
    <DetachedCenterPanel
      scope={param.scope}
      popoutId={param.groupId}
      tree={group}
      tabs={tabs}
      remoteInfo={remoteInfo}
      onActivate={(key) => pushEdit({ kind: "activate", key })}
      onClose={handleClose}
      onHideWindow={handleHideWindow}
      onSetLocation={(key, location) => pushEdit({ kind: "setLocation", key, location })}
      onReorder={(tabKeys) => pushEdit({ kind: "reorder", tabKeys })}
      onSplit={(key, targetGroupId, edge) =>
        pushEdit({ kind: "split", key, targetGroupId, edge })
      }
      onResize={(splitId, dividerIndex, fraction) =>
        pushEdit({ kind: "resize", splitId, dividerIndex, fraction })
      }
      onMove={(key, targetGroupId, index) =>
        pushEdit({ kind: "move", key, targetGroupId, index })
      }
      onAddTab={(tab, targetGroupId, edge) =>
        pushEdit({ kind: "add", tab, targetGroupId, edge })
      }
      onFiles={(groupId, patch) => pushEdit({ kind: "files", groupId, ...patch })}
    />
  );
}
