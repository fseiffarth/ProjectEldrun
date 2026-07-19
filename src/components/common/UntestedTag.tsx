/**
 * A small "untested" tag for menu items and controls whose feature has been
 * built but not yet live-verified in the running app. It is deliberately loud
 * (warning-tinted) and stays put until that specific feature is confirmed
 * working — a tag is removed per-item only when the user explicitly says that
 * feature has been tested. Add it to every new, unverified feature.
 *
 * Inside a `.context-menu` button, also put `className="untested"` on the
 * button so the label and the tag lay out in a row (the tag floats right).
 */
export function UntestedTag() {
  return (
    <span
      className="untested-tag"
      title="This feature is implemented but not yet live-tested"
    >
      untested
    </span>
  );
}
