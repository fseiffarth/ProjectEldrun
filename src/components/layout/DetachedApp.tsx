import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "../../stores/settings";
import {
  DETACHED_BOUNDS,
  DETACHED_CLOSE,
  DETACHED_DOCK,
  DETACHED_EDIT,
  DETACHED_REQUEST_SEED,
  applyEditToSubtree,
  applyRenameToTabs,
  detachedSeedEvent,
  type DetachedEdit,
  type DetachedParam,
  type DetachedSeed,
} from "../../stores/detached";
import type { GroupNode, TabEntry } from "../../stores/tabs";
import { DetachedCenterPanel } from "./DetachedCenterPanel";

interface Props {
  param: DetachedParam;
}

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

  const [group, setGroup] = useState<GroupNode | null>(null);
  const [tabs, setTabs] = useState<TabEntry[]>([]);

  // Theme injection (same as the main shell), but nothing project-switch-aware.
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // WebKitGTK doesn't reliably fire DOM 'resize' / ResizeObserver for OS-level
  // window size changes. Panes (terminals especially) refit off the DOM 'resize'
  // event, so bridge Tauri's reliable window onResized into a DOM resize here —
  // the same bridge the main shell installs (AppShell). rAF-coalesce so a manual
  // drag-resize doesn't flood listeners.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let raf = 0;
    const fire = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        window.dispatchEvent(new Event("resize"));
      });
    };
    getCurrentWindow().onResized(fire).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { if (raf) cancelAnimationFrame(raf); unlisten?.(); };
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
      setGroup(ev.payload.subtree);
      setTabs(ev.payload.tabs);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlistenSeed = fn;
        // Listener is live — now it's safe to ask, and to keep asking until the
        // first seed lands.
        const request = () => {
          if (cancelled || seeded) return;
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
    }
    void emit(DETACHED_EDIT, { scope: param.scope, groupId: param.groupId, edit });
  };

  const onDockBack = () => {
    void emit(DETACHED_DOCK, { scope: param.scope, groupId: param.groupId });
  };

  // Close-on-close: closing this OS window via the WM/title-bar CLOSES the
  // group's tabs for good — they are not docked back and do not restore on next
  // launch (dock-back stays on the ⤓ button). Prevent the default close and emit
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

  if (!group) {
    return <div className="detached-loading">Loading subwindow…</div>;
  }

  return (
    <DetachedCenterPanel
      scope={param.scope}
      group={group}
      tabs={tabs}
      onActivate={(key) => pushEdit({ kind: "activate", key })}
      onClose={(key) => pushEdit({ kind: "close", key })}
      onDockBack={onDockBack}
    />
  );
}
