import { useActivityStore, type StatusTab, type TabStatusCounts } from "../../stores/activity";
import { useTabsStore, ROOT_SCOPE } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useT, type TranslationKey } from "../../lib/i18n";

/** Most status bars the strip will draw. A scope with more busy tabs than this
 *  would overflow a narrow pill, so the strip stops here and the tooltip carries
 *  the true tally. */
const MAX_STATUS_BARS = 6;

/** The strip's bars, most urgent state first, one per tab. */
export function statusBarKinds(c: TabStatusCounts): string[] {
  const kinds = [
    ...Array<string>(c.working).fill("working"),
    ...Array<string>(c.decision).fill("needs-decision"),
    ...Array<string>(c.done).fill("finished"),
  ];
  return kinds.slice(0, MAX_STATUS_BARS);
}

/** Tooltip spelling out the tally the bars stand for (never truncated). */
export function statusBarTitle(
  c: TabStatusCounts,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const parts: string[] = [];
  if (c.working) parts.push(t("pill.statusWorking", { count: c.working }));
  if (c.decision) parts.push(t("pill.statusWaiting", { count: c.decision }));
  if (c.done) parts.push(t("pill.statusFinished", { count: c.done }));
  return parts.join(" · ");
}

/** Which sentence a single bar's tooltip is built on. */
const BAR_TITLE_KEY: Record<StatusTab["state"], TranslationKey> = {
  working: "pill.statusTabWorking",
  "needs-decision": "pill.statusTabWaiting",
  finished: "pill.statusTabFinished",
};

/**
 * Show the tab a bar stands for: make it the visible tab of its subwindow, then
 * bring its scope up. That order is deliberate — `revealTabInScope` writes the
 * scope's own layout, which the switch then mirrors, so the tab is already
 * showing when the project arrives instead of appearing a frame later.
 *
 * A tab in a hidden subwindow or a detached window isn't in the scope's visible
 * tree; the switch still happens, since landing in the right project is the half
 * of the request that can be honoured.
 */
function jumpToTab(scope: string, key: string) {
  useTabsStore.getState().revealTabInScope(scope, key);
  const { activeId, setActive } = useProjectsStore.getState();
  const target = scope === ROOT_SCOPE ? null : scope;
  if (activeId !== target) void setActive(target);
}

/**
 * One little bar per non-idle tab along the bottom edge of a pill, so a glance
 * at the switcher says how many tabs of each scope are working (green dots),
 * finished unseen (green, solid) or waiting on a decision (amber) — nothing
 * animated, the tab ring's own vocabulary (`--status-*`).
 *
 * Each bar is a **button that opens its own tab** — the strip already knows
 * which tab it is drawing (`statusTabsByScope`), and "an agent over there wants
 * something" is a statement whose only useful next step is going there; without
 * the click that meant switching project and then hunting the tab bar for the
 * one that was glowing. Hence the bars are also sized to be hit: a 3px sliver is
 * a readable signal but not a target.
 *
 * A *component* rather than a snippet each pill repeats, because the root
 * terminal is a scope like any other: its tabs run the same agents, and a pill
 * that showed nothing while an agent worked in it could only be read as "nothing
 * is running there". The root pill is the one place the strip was missing, and
 * one component is what keeps the two from drifting into two different answers
 * to the same question.
 *
 * The SELECTED scope keeps its bars: the strip is a tally of what the scope is
 * doing, not a list of what still needs a glance, and the scope you are in is
 * the one whose agents you most need to see running. Only "finished unseen" is
 * inherently about unread output, and it can't arise for a tab on screen.
 *
 * Positioned absolutely, so the host must be a positioned box (`.project-pill`
 * and `.root-pill` both are).
 */
export function PillStatusBars({ scope }: { scope: string }) {
  const t = useT();
  const counts = useActivityStore((s) => s.statusCountsByScope[scope]);
  const statusTabs = useActivityStore((s) => s.statusTabsByScope[scope]);
  const tabs = useTabsStore((s) => s.tabsByScope[scope]);
  if (!counts || !statusTabs) return null;
  return (
    <span className="pill-status-bars" title={statusBarTitle(counts, t)}>
      {statusTabs.slice(0, MAX_STATUS_BARS).map((st) => {
        const label = tabs?.find((tab) => tab.key === st.key)?.label ?? "";
        return (
          <button
            type="button"
            key={st.key}
            className={`pill-status-bar ${st.state}`}
            title={`${t(BAR_TITLE_KEY[st.state], { tab: label })} · ${t("pill.statusTabJump")}`}
            aria-label={t(BAR_TITLE_KEY[st.state], { tab: label })}
            // The pill itself starts a reorder drag on pointerdown and switches
            // project on click; a bar is its own control, so it keeps both to
            // itself.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              jumpToTab(scope, st.key);
            }}
          />
        );
      })}
    </span>
  );
}
