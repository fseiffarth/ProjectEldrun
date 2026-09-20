/**
 * A small "untested" tag for menu items and controls whose feature has been
 * built but not yet live-verified in the running app. It is deliberately loud
 * (warning-tinted) and stays put until that specific feature is confirmed
 * working — a tag is removed per-item only when the user explicitly says that
 * feature has been tested. Add it to every new, unverified feature.
 *
 * Every pill carries an `id` from the register in `lib/untested`, which is
 * what makes "this one is tested now" a one-line edit there instead of a hunt
 * through the markup: stamping the row's `tested` date hides the pill
 * everywhere that id appears (`npm run untested -- tested <id>`). A new pill
 * needs a new row; the registry test fails on an id that has none.
 *
 * Inside a `.context-menu` button, also put `className="untested"` on the
 * button so the label and the tag lay out in a row (the tag floats right).
 */
import { useT } from "../../lib/i18n";
import { isUntested, type UntestedId } from "../../lib/untested";

export function UntestedTag({ id }: { id: UntestedId }) {
  const t = useT();
  if (!isUntested(id)) return null;
  return (
    <span
      className="untested-tag"
      title={t("untested.title")}
    >
      {t("untested.label")}
    </span>
  );
}
