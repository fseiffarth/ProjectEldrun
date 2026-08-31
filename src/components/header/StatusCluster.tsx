import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConnLamp } from "../common/ConnLamp";
import { ConnTypeIcon } from "./ConnTypeIcon";
import { BatteryIndicator } from "./BatteryIndicator";
import { MobileIndicator } from "./MobileIndicator";
import { VpnIndicator } from "./VpnIndicator";
import { MachinesIndicator } from "./MachinesIndicator";
import { AppResourceDisplay } from "./AppResourceDisplay";
import { useQuiesce, saverInterval, usePowerStore } from "../../stores/power";
import { useSettingsStore } from "../../stores/settings";
import {
  isEscalated,
  summaryLamp,
  useHeaderStatusStore,
  type HeaderStatusKey,
  type HeaderStatusReport,
} from "../../stores/headerStatus";
import { useT } from "../../lib/i18n";

/**
 * The header's machine-state readouts — connection, battery, Mobile, OpenVPN,
 * Machines, CPU/RAM/GPU — as ONE collapsible cluster instead of six permanently
 * lit widgets.
 *
 * The problem it solves is a budget one. Those six are roughly a third of the
 * top bar's width, they never change size, and the only elastic thing in the
 * header is the project pill strip — so every pixel they hold at rest is taken
 * straight out of the app's primary navigation, all day, to say "still fine"
 * six times over.
 *
 * Collapsed, the cluster is a single lamp: the worst thing any member is saying
 * (`summaryLamp`), with every member's line in its tooltip. Clicking expands the
 * whole row back, and that choice PERSISTS (`header_status_expanded`) — a user
 * who wants the old bar clicks once, forever.
 *
 * What keeps the fold from hiding something that mattered is escalation: a
 * member reporting `attention`/`alert` renders in the bar regardless of the
 * collapsed state (see `stores/headerStatus` for why the escalating set is
 * deliberately narrow). So the resting bar is one lamp, and a bar with a problem
 * in it shows exactly the problem — which is more legible than five green lamps,
 * not less.
 *
 * Two structural notes:
 *  - Folding is `display: none` on a wrapper, NOT unmounting. Every member stays
 *    mounted and keeps polling, because a folded widget still has to be able to
 *    escalate itself — a Machines indicator that stopped watching while hidden
 *    could never come back out. It also means folding costs nothing and saves
 *    nothing at runtime: this is a width fix, not a polling fix.
 *  - Members render in a FIXED DOM order whether folded or not, so escalating
 *    never re-orders the survivors; a widget appears in the slot it always had.
 */

/** Below this, folding is worse than the crowding: a one-item fold is a lamp
 *  hiding a lamp. (Two counts the toggle itself as the second thing on screen.) */
const MIN_FOLDABLE = 2;

export function StatusCluster() {
  const t = useT();
  const quiesce = useQuiesce();
  const [online, setOnline] = useState(navigator.onLine);
  const [connType, setConnType] = useState<string | null>(null);
  const batterySupported = usePowerStore((s) => s.supported);
  const batteryPercentage = usePowerStore((s) => s.percentage);
  const onBattery = usePowerStore((s) => s.onBattery);
  const expanded = useSettingsStore((s) => s.settings?.header_status_expanded ?? false);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const reports = useHeaderStatusStore((s) => s.reports);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    const poll = () =>
      invoke<string>("network_conn_type")
        .then(setConnType)
        .catch(() => {});
    poll();
    const id = setInterval(poll, saverInterval(10_000, quiesce));
    return () => clearInterval(id);
  }, [quiesce]);

  const connKind = connType === "lan" ? "lan" : connType === "wlan" ? "wlan" : null;
  const showConn = connKind !== null || !online;
  const batteryPct =
    batteryPercentage == null ? null : Math.round(Math.min(100, Math.max(0, batteryPercentage)));

  // Conn and battery are the cluster's own children — dumb SVGs fed from here
  // rather than self-contained widgets — so their reports are computed inline
  // instead of routed through the store. Same shape, same rules; merging them
  // over the store's reports is what lets the summary lamp and the fold count
  // see all six members as one set.
  const local: Partial<Record<HeaderStatusKey, HeaderStatusReport>> = {};
  if (showConn) {
    local.conn = {
      tone: online ? "ok" : "alert",
      label: `${connKind === "lan" ? "Ethernet" : "WiFi"}${
        online ? "" : t("connTypeIcon.offlineSuffix")
      }`,
    };
  }
  if (batterySupported) {
    local.battery = {
      // Only a flat battery on its own power is worth interrupting the fold for.
      // On mains, or merely low-ish, it stays folded — a laptop at 35% is not news.
      tone: !onBattery ? "ok" : batteryPct != null && batteryPct <= 15 ? "alert" : "ok",
      label:
        batteryPct == null
          ? t("batteryIndicator.unknown")
          : `${batteryPct}%${!onBattery ? t("batteryIndicator.pluggedSuffix") : ""}`,
    };
  }

  const all: Partial<Record<HeaderStatusKey, HeaderStatusReport>> = { ...local, ...reports };
  const entries = Object.entries(all) as [HeaderStatusKey, HeaderStatusReport][];
  const escalated = new Set(entries.filter(([, r]) => isEscalated(r.tone)).map(([k]) => k));
  const foldableCount = entries.length - escalated.size;
  const collapsed = !expanded && foldableCount >= MIN_FOLDABLE;
  const folded = (key: HeaderStatusKey) => collapsed && !escalated.has(key);

  const toggleTitle = collapsed
    ? [
        t("statusCluster.expandTitle"),
        ...entries.filter(([k]) => folded(k)).map(([, r]) => r.label),
      ].join("\n")
    : t("statusCluster.collapseTitle");

  return (
    <div className="header-status-cluster">
      <span className="status-cluster-item" data-folded={folded("conn")}>
        {showConn && <ConnTypeIcon type={connKind ?? "wlan"} online={online} />}
      </span>
      <span className="status-cluster-item" data-folded={folded("battery")}>
        {batterySupported && (
          <BatteryIndicator percentage={batteryPercentage} plugged={!onBattery} />
        )}
      </span>
      <span className="status-cluster-item" data-folded={folded("mobile")}>
        <MobileIndicator />
      </span>
      <span className="status-cluster-item" data-folded={folded("vpn")}>
        <VpnIndicator />
      </span>
      <span className="status-cluster-item" data-folded={folded("machines")}>
        <MachinesIndicator />
      </span>
      <span className="status-cluster-item" data-folded={folded("resources")}>
        <AppResourceDisplay />
      </span>
      {/* The toggle only exists once there is something to fold: with a single
          member (or none) the cluster is already as small as it gets, and a
          chevron next to one lamp is pure noise. */}
      {foldableCount >= MIN_FOLDABLE && (
        <button
          type="button"
          className="global-apps-menu-btn status-cluster-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("statusCluster.expandTitle") : t("statusCluster.collapseTitle")}
          title={toggleTitle}
          onClick={() => void updateSettings({ header_status_expanded: collapsed })}
        >
          {collapsed && <ConnLamp status={summaryLamp(all)} label={t("statusCluster.label")} />}
          {/* Points the way the cluster moves: ‹ opens it leftwards into the bar,
              › folds it back towards the global-app buttons beside it. */}
          <span className="status-cluster-chevron" aria-hidden>
            {collapsed ? "‹" : "›"}
          </span>
        </button>
      )}
    </div>
  );
}
