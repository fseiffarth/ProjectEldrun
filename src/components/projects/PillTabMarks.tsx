import { useMemo } from "react";

import { useT } from "../../lib/i18n";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import { markedTabs, tabMarkGlyph } from "../../lib/tabMarks";
import { useTabsStore } from "../../stores/tabs";

/**
 * The project pill's summary of its Important / Urgent tabs: the mail glyph of
 * the most pressing mark (`!!` red, `!` amber) and, past one, how many. The
 * tooltip names every marked tab; a click jumps to the most pressing one.
 *
 * Reads the scope's loaded tabs, so a project whose tabs were never restored
 * this session (an inactive pill) shows nothing until it is opened.
 */
export function PillTabMarks({ scope }: { scope: string }) {
  const t = useT();
  const tabs = useTabsStore((s) => s.tabsByScope[scope]);
  const marked = useMemo(() => markedTabs(tabs), [tabs]);
  if (marked.length === 0) return null;
  const top = marked[0];
  const title = t("pill.tabMarksTitle", {
    list: marked.map((m) => `${tabMarkGlyph(m.mark)} ${m.label}`).join(", "),
  });
  return (
    <button
      type="button"
      className={`pill-vm-glyph pill-tab-marks ${top.mark}`}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        jumpToTab(scope, top.key);
      }}
    >
      {tabMarkGlyph(top.mark)}
      {marked.length > 1 && <span className="pill-tab-marks-count">{marked.length}</span>}
    </button>
  );
}
