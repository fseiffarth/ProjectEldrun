import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useKeyboardSteeringStore, type SteeringHandoff } from "../../stores/keyboardSteering";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import {
  STEERING_GROUPS,
  steeringKeysFor,
  steeringRowLabel,
  type SteeringKeyDef,
} from "../../lib/shortcuts/shortcuts";
import { steeringRowKeys, steeringSlotKey, type SteeringKeyMap } from "../../lib/shortcuts/steeringBindings";
import { newTabSlotLabels } from "../../lib/shortcuts/newTabChord";
import { activeTabCard, steeringAppEnabled } from "../../lib/shortcuts/steeringRegion";
import { statusTabs } from "../../lib/shortcuts/statusJump";
import { steeringAgentOffer } from "../../lib/shortcuts/steeringAgent";
import { useActivityStore } from "../../stores/activity";
import { useT, type TranslationKey } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { KeyboardIcon } from "../common/icons/Icon";

const REGION_LABEL: Record<string, TranslationKey> = {
  side: "steering.region.side",
  mail: "steering.mail.label",
  calendar: "steering.calendar.label",
  todo: "steering.todo.label",
  addTab: "steering.newTabMenu.label",
  settings: "steering.settings.label",
  header: "steering.region.header",
  card: "steering.region.card",
  overlay: "steering.region.overlay",
};

const LEVEL_LABEL: Record<string, TranslationKey> = {
  projects: "steering.level.projects",
  panes: "steering.level.panes",
  tabs: "steering.level.tabs",
  scroll: "steering.level.scroll",
};

/** What the box steering lent the keyboard to answers — its own keys, fixed,
 *  so not steering bindings — and Esc, which brings steering back. */
const HANDOFF: Record<SteeringHandoff, { where: TranslationKey; keys: [string, TranslationKey][] }> = {
  jump: {
    where: "steering.jumpProject.label",
    keys: [
      ["↑ ↓", "steering.handoff.choose"],
      ["Enter", "steering.handoff.open"],
    ],
  },
  prompt: {
    where: "steering.agentPrompt.label",
    keys: [
      ["Enter", "steering.handoff.send"],
      ["Shift+Enter", "steering.handoff.newLine"],
    ],
  },
  search: { where: "steering.search.label", keys: [] },
};
const HANDOFF_BACK_KEY = "Esc";

/**
 * The compact bottom-center legend shown while keyboard steering mode is
 * active — the visible half of the mode's contract (every key is swallowed, so
 * the user must be able to see what the keys do and how to get out). It names
 * the level steering is on and lists only that level's keys, boxed by
 * `STEERING_GROUPS` in the editor's token colours
 * (`steeringKeysFor` over `STEERING_KEYS`, the same table the cheat-sheet/lesson
 * surfaces use), so the legend can never list a key the handler doesn't act on.
 * Inside a pane the agent digits collapse to one "1–N CLIs" entry — N is how
 * many agents the focused pane's own 1–9 open (`newTabSlotLabels`), their
 * names on hover. Every key shown is the user's steering binding
 * (`steeringRowLabel`, `steeringSlotKey`).
 *
 * Mounted once in `AppShell` (the FocusFrameOverlay/host pattern) and
 * portalled to `document.body` so no pane clips it; `pointer-events: none` —
 * steering is a keyboard mode, the legend is display only. Steering's H folds
 * it into a round corner badge (`legendHidden`, remembered per machine) that
 * keeps saying the mode is on; the badge alone takes a click, to unfold.
 *
 * While steering has lent the keyboard to a box — the project jump, the
 * prompt box, a surface's search field (`handedTo`) — the mode is off but the
 * legend stays, down to that box's keys and Esc back to steering, folded or
 * not: the way back is the one thing it must not hide.
 */
export function SteeringLegend() {
  const t = useT();
  const active = useKeyboardSteeringStore((s) => s.active);
  const level = useKeyboardSteeringStore((s) => s.level);
  const region = useKeyboardSteeringStore((s) => s.region);
  const legendHidden = useKeyboardSteeringStore((s) => s.legendHidden);
  const toggleLegend = useKeyboardSteeringStore((s) => s.toggleLegend);
  const handedTo = useKeyboardSteeringStore((s) => s.handedTo);
  const multiPane = useTabsStore((s) => allGroups(s.layout).length >= 2);
  const focusedGroupId = useTabsStore((s) => s.focusedGroupId);
  const mail = useSettingsStore((s) => steeringAppEnabled("mail", s.settings));
  const calendar = useSettingsStore((s) => steeringAppEnabled("calendar", s.settings));
  const todo = useSettingsStore((s) => steeringAppEnabled("todo", s.settings));
  const busyByTab = useActivityStore((s) => s.busyByTab);
  const attentionByTab = useActivityStore((s) => s.attentionByTab);
  const tabsByScope = useTabsStore((s) => s.tabsByScope);
  const tabScope = useTabsStore((s) => s.scope);
  const activeTab = useTabsStore((s) => (s.activeKey ? s.tabs.find((tab) => tab.key === s.activeKey) : undefined));
  const steerKeys = useSettingsStore((s) => s.settings?.steering_keys) as SteeringKeyMap | undefined;

  const inPane = active && (level === "panes" || level === "tabs");
  const agents = useMemo(
    () => (inPane ? newTabSlotLabels() : []),
    // The focused pane decides which agents 1–9 open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inPane, focusedGroupId],
  );

  // Publish where steering points on <html> (`data-steer`, plus
  // `data-steer-region` in a region) so the stylesheet can light up the one
  // object the arrows act on — the top frame and current pill, the focused
  // subwindow, its active tab, the side panel or overlay — without every one
  // of those components subscribing to this store.
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.dataset.steer = level;
    if (region) root.dataset.steerRegion = region;
    return () => {
      delete root.dataset.steer;
      delete root.dataset.steerRegion;
    };
  }, [active, level, region]);

  // Steering is a keyboard mode, so the mouse pointer hides while it is on
  // (`data-steer-pointer` on <html>). Moving the mouse brings it back; the
  // next steering key hides it again. Only real movement counts: the engine
  // fires mousemove under a still pointer when a tab switch changes what lies
  // beneath it, and that must not unhide.
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    let last: { x: number; y: number } | null = null;
    const hide = () => {
      root.dataset.steerPointer = "hidden";
    };
    const onMove = (e: MouseEvent) => {
      const moved = last !== null && Math.hypot(e.screenX - last.x, e.screenY - last.y) > 3;
      last = { x: e.screenX, y: e.screenY };
      if (moved) delete root.dataset.steerPointer;
    };
    hide();
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("keydown", hide, true);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("keydown", hide, true);
      delete root.dataset.steerPointer;
    };
  }, [active]);

  if (!active && handedTo) {
    const box = HANDOFF[handedTo];
    const keyItem = ([key, label]: [string, TranslationKey]) => (
      <span className="steering-legend-item" key={label}>
        <kbd>{key}</kbd>
        <span className="steering-legend-label">{t(label)}</span>
      </span>
    );
    return createPortal(
      <div className="steering-legend steering-legend-grouped" role="status" aria-label={t("steering.legendTitle")}>
        <span className="steering-legend-where">
          {t(box.where)}
          <UntestedTag id="steering.handoffLegend" />
        </span>
        {box.keys.length > 0 && (
          <div className="steering-legend-group tok-type">
            <span className="steering-legend-group-keys">{box.keys.map(keyItem)}</span>
          </div>
        )}
        <div className="steering-legend-group tok-comment">
          <span className="steering-legend-group-keys">{keyItem([HANDOFF_BACK_KEY, "steering.handoff.back"])}</span>
        </div>
      </div>,
      document.body,
    );
  }
  if (!active) return null;
  const legendKey = steeringRowKeys(["legend"], steerKeys);
  if (legendHidden) {
    // Folded (H): a round badge in the corner still says steering is on; H
    // again — or a click — unfolds the key list.
    return createPortal(
      <div className="steering-legend-fab" role="status" aria-label={t("steering.legendTitle")}>
        <UntestedTag id="steering.legendToggle" />
        <button
          type="button"
          className="steering-legend-fab-button"
          // The focus stays where steering left it (a terminal, usually).
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleLegend}
          title={t("steering.fab.title", { key: legendKey })}
        >
          <KeyboardIcon size={22} />
          <kbd>{legendKey}</kbd>
        </button>
      </div>,
      document.body,
    );
  }
  const count = (kind: "decision" | "working" | "done") =>
    statusTabs(kind, busyByTab, attentionByTab, tabsByScope).length;
  const statusCounts = { decision: count("decision"), working: count("working"), done: count("done") };
  const keys = steeringKeysFor({
    level,
    sideRegion: region === "side",
    settingsRegion: region === "settings",
    headerRegion: region === "header",
    overlayRegion: region === "overlay",
    // Read at render: the legend redraws on every steering key.
    tabCard: inPane && !!activeTabCard(),
    multiPane,
    apps: { mail, calendar, todo },
    agent: steeringAgentOffer(activeTab),
    terminal: !!activeTab && !!terminalFor(`${tabScope}:${activeTab.key}`),
    statusCounts,
  });
  const where = level === "region" ? (region ? REGION_LABEL[region] : null) : LEVEL_LABEL[level];

  const item = (k: SteeringKeyDef) => {
    if (k.agentSlots) {
      const slots = agents.flatMap((label, i) => {
        // An unbound slot has no key to press, so it is not counted.
        const key = label ? steeringSlotKey(i + 1, steerKeys) : null;
        return key ? [{ key, label }] : [];
      });
      if (slots.length > 0) {
        return (
          <span className="steering-legend-item" key="agent-slots" title={slots.map((a) => `${a.key} ${a.label}`).join(" · ")}>
            <kbd>{slotRange(slots.map((a) => a.key))}</kbd>
            <span className="steering-legend-label">{t("steering.newAgent.clis")}</span>
          </span>
        );
      }
    }
    return (
      <span className="steering-legend-item" key={`${k.actions.join(",")}|${k.labelKey}`} title={t(k.descKey)}>
        <kbd>{steeringRowLabel(k, steerKeys)}</kbd>
        <span className="steering-legend-label">{t(k.labelKey)}</span>
        {k.status && <span className="steering-legend-count">{statusCounts[k.status]}</span>}
      </span>
    );
  };

  // The keys in boxes by what they are for, each box in one editor token
  // colour; the accent frame, not a title, says the mode is on.
  return createPortal(
    <div className="steering-legend steering-legend-grouped" role="status" aria-label={t("steering.legendTitle")}>
      <span className="steering-legend-where">
        {where && t(where)}
        <UntestedTag id="steering.levels" />
        <UntestedTag id="steering.hidePointer" />
        <UntestedTag id="steering.agentKeys" />
        <UntestedTag id="steering.agentKeysStay" />
        {region === "settings" && <UntestedTag id="steering.settings" />}
        {(region === "header" || region === "overlay" || region === "card") && <UntestedTag id="steering.overlays" />}
        <UntestedTag id="steering.agentPrompt" />
        {level === "scroll" && <UntestedTag id="steering.scroll" />}
        <UntestedTag id="steering.legendGroups" />
      </span>
      {STEERING_GROUPS.map((g) => {
        const rows = keys.filter((k) => k.group === g.id);
        if (rows.length === 0) return null;
        return (
          <div className={`steering-legend-group ${g.tok}`} key={g.id} data-group={g.id}>
            <span className="steering-legend-group-name">{t(g.labelKey)}</span>
            <span className="steering-legend-group-keys">{rows.map(item)}</span>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

/** "1–N" when the slots are the default digits 1..N, else the keys in order. */
function slotRange(keys: string[]): string {
  if (keys.every((k, i) => k === String(i + 1))) return keys.length === 1 ? "1" : `1–${keys.length}`;
  return keys.join(" ");
}
