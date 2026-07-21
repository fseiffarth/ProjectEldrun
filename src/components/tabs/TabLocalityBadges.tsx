import { useState } from "react";
import { createPortal } from "react-dom";
import {
  effectiveTabLocation,
  remoteHostIdOf,
  isLocatableKind,
  localityHostLabel,
  workerRunnable,
  type LocalityHost,
  type TabEntry,
  type TabLocation,
} from "../../stores/tabs";
import { useFileSourcesStore } from "../../stores/fileSources";
import { useRunHostPrefStore } from "../../stores/runHostPref";
import { UntestedTag } from "../common/UntestedTag";

/**
 * The two per-tab local/remote badges + the locality menu, factored out so the
 * main-window `TabBar` and each detached popout's tab strip render the SAME
 * controls (the user asked for parity, and drift between two copies is exactly
 * what an extraction prevents). Everything here reads the tab payload + the
 * streamed host list; WHERE a location change is applied is the caller's
 * `onChoose` (the main store directly, or a streamed edit from a popout).
 */

/** The open locality-menu state a strip owns: which tab, where to anchor it, and
 *  the two-level drill (`root` = Local↔Remote, `machines` = primary + workers). */
export interface LocalityMenuState {
  key: string;
  x: number;
  y: number;
  view: "root" | "machines";
}

/** A tab's effective location, or `"local"` for a missing tab — the `current`
 *  a `LocalityMenu` dots, without the caller importing the tabs helpers. */
export function tabLocation(tab: TabEntry | undefined): TabLocation {
  return tab ? effectiveTabLocation(tab) : "local";
}

/** The file-source badge on a viewer tab: a clickable Local/Remote toggle when
 *  the viewer published a switch (the file exists on both sides of a remote
 *  project), else the plain read-only glyph. Renders nothing on a local tab. */
export function TabSourceBadge({ tabKey }: { tabKey: string }) {
  const src = useFileSourcesStore((s) => s.byTab[tabKey]);
  const ctl = useFileSourcesStore((s) => s.controlsByTab[tabKey]);
  if (ctl) {
    const onRemote = ctl.current === "remote";
    const blocked = !onRemote && ctl.remoteDisabled;
    return (
      <button
        className={`tab-source clickable ${onRemote ? "remote" : "local"}${blocked ? " disabled" : ""}`}
        title={
          blocked
            ? "This file has no copy on the host — nothing to switch to."
            : onRemote
              ? "Reading from the host over SFTP — click to read the local mirror copy."
              : "Reading the local mirror copy — click to read from the host over SFTP."
        }
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (blocked) return;
          ctl.set(onRemote ? "local" : "remote");
        }}
      >
        {onRemote ? "☁" : "⌂"}
      </button>
    );
  }
  if (src !== "remote" && src !== "local") return null;
  return (
    <span
      className={`tab-source ${src}`}
      title={
        src === "remote"
          ? "Remote-native: read directly from the host over SFTP (no local copy)."
          : "Local mirror: read from this project's local synced copy of the host file."
      }
    >
      {src === "remote" ? "☁" : "⌂"}
    </span>
  );
}

/** The locality badge (⌂ local / ☁ remote) on an agent/shell tab of a remote
 *  project — click to open the machine menu. Renders nothing for a non-locatable
 *  tab kind. Callers gate on the project being remote before rendering it. */
export function TabLocalityBadge({
  tab,
  primaryHost,
  computeHosts,
  onOpen,
}: {
  tab: TabEntry;
  primaryHost?: string;
  computeHosts?: LocalityHost[];
  /** Open the menu anchored under the badge; `startOnMachines` jumps straight to
   *  the machine list when the tab already runs remotely (one click closer to a
   *  remote→remote reassignment). */
  onOpen: (rect: DOMRect, startOnMachines: boolean) => void;
}) {
  if (!isLocatableKind(tab.kind)) return null;
  const loc = effectiveTabLocation(tab);
  const hostId = remoteHostIdOf(loc);
  const label = localityHostLabel(loc, { primaryHost, computeHosts });
  return (
    <button
      className={`tab-locality ${hostId === null ? "local" : "remote"}`}
      title={`Runs on: ${label} — click to change where this tab runs`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onOpen((e.currentTarget as HTMLElement).getBoundingClientRect(), hostId !== null);
      }}
    >
      {hostId === null ? "⌂" : "☁"}
    </button>
  );
}

/** The two-level locality menu (Local ↔ Remote, then a machine sub-picker). A
 *  worker that holds no code (not shared-fs, sync off) is offered disabled — sync
 *  always stays with the primary; the worker only runs scripts. Rendered in a
 *  portal with a click-away backdrop. */
export function LocalityMenu({
  menu,
  current,
  primaryHost,
  computeHosts,
  onClose,
  onChangeView,
  onChoose,
}: {
  menu: LocalityMenuState;
  /** The location currently selected (dotted in the menu). A tab's
   *  `effectiveTabLocation`, or a file viewer's run-host preference. */
  current: TabLocation;
  primaryHost?: string;
  computeHosts?: LocalityHost[];
  onClose: () => void;
  onChangeView: (view: "root" | "machines") => void;
  onChoose: (key: string, loc: TabLocation) => void;
}) {
  const cur = current;
  const onRemoteNow = remoteHostIdOf(cur) !== null;
  const choose = (loc: TabLocation) => {
    onChoose(menu.key, loc);
    onClose();
  };
  const machineItem = (
    loc: TabLocation,
    glyph: string,
    text: string,
    opts?: { disabled?: boolean; note?: string; title?: string },
  ) => (
    <button
      key={loc}
      className="tab-new-menu-item"
      title={opts?.title}
      disabled={opts?.disabled}
      onClick={() => !opts?.disabled && choose(loc)}
    >
      <span className="tab-new-menu-dot" style={{ color: "var(--accent)" }}>
        {cur === loc ? "●" : glyph}
      </span>
      {text}
      {opts?.note && <span className="tab-menu-hint">{opts.note}</span>}
    </button>
  );
  return createPortal(
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 40 }}
        onPointerDown={onClose}
      />
      <div
        className="tab-new-menu"
        style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 41 }}
      >
        {menu.view === "root" ? (
          <>
            {machineItem("local", "⌂", "Local (mirror)")}
            <button
              className="tab-new-menu-item"
              onClick={() => onChangeView("machines")}
            >
              <span className="tab-new-menu-dot" style={{ color: "var(--accent)" }}>
                {onRemoteNow ? "●" : "☁"}
              </span>
              Remote…
              <span className="tab-menu-hint">choose machine ›</span>
            </button>
          </>
        ) : (
          <>
            <button
              className="tab-new-menu-item tab-menu-back"
              onClick={() => onChangeView("root")}
            >
              <span className="tab-new-menu-dot">‹</span>
              Run on machine
              <UntestedTag />
            </button>
            {machineItem(
              "remote",
              "☁",
              primaryHost ? `Primary (${primaryHost})` : "Primary",
            )}
            {(computeHosts ?? []).map((h) =>
              machineItem(
                `host:${h.id}`,
                "☁",
                h.label || h.host || h.id,
                workerRunnable(h)
                  ? undefined
                  : {
                      disabled: true,
                      note: "sync off",
                      title:
                        "This machine holds no code — enable “Auto-sync code” or shared filesystem in Remote machines… to run scripts here. Sync stays with the primary.",
                    },
              ),
            )}
          </>
        )}
      </div>
    </>,
    document.body,
  );
}

/**
 * The file viewer's "run on machine" picker — a labelled control (beside the
 * Remote/Local *source* switch) that chooses WHICH machine a Run/Debug or shell
 * launched from this project runs on, distinct from which side its files are
 * *read* from. Writes the per-project run-host preference (`useRunHostPrefStore`)
 * that `lib/pythonRun` reads at launch. Reuses the same two-level `LocalityMenu`
 * as the tab badge, so the machine list + worker eligibility stay identical.
 * Shown only for remote projects (a local project has no machine axis).
 */
export function RunHostPicker({
  projectId,
  primaryHost,
  computeHosts,
}: {
  projectId: string;
  primaryHost?: string;
  computeHosts?: LocalityHost[];
}) {
  const pref = useRunHostPrefStore((s) => s.byProject[projectId]);
  const setPref = useRunHostPrefStore((s) => s.set);
  const [menu, setMenu] = useState<LocalityMenuState | null>(null);
  // Unset ⇒ the shell default (the primary host) — the same default pythonRun
  // falls back to, so the label never lies about where a run would land.
  const current: TabLocation = pref ?? "remote";
  const label = localityHostLabel(current, { primaryHost, computeHosts });
  const onRemote = remoteHostIdOf(current) !== null;
  return (
    <>
      <button
        type="button"
        className="right-panel-run-host"
        // The label ellipsizes in a narrow (docked subwindow) row, so the full
        // machine name has to survive somewhere — the tooltip names it.
        title={`Runs on: ${label}\nWhere Run/Debug and shells launched from this project run — the machine, not which side files are read from.`}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu({
            key: projectId,
            x: r.left,
            y: r.bottom + 2,
            view: onRemote ? "machines" : "root",
          });
        }}
      >
        <span aria-hidden="true">{onRemote ? "☁" : "⌂"}</span>
        <span className="run-host-label">Run: {label}</span>
      </button>
      {menu && (
        <LocalityMenu
          menu={menu}
          current={current}
          primaryHost={primaryHost}
          computeHosts={computeHosts}
          onClose={() => setMenu(null)}
          onChangeView={(view) => setMenu((m) => (m ? { ...m, view } : m))}
          onChoose={(_key, loc) => setPref(projectId, loc)}
        />
      )}
    </>
  );
}
