import { useT } from "../../lib/i18n";

interface Props {
  percentage: number | null;
  /** True whenever the machine is drawing from mains power — a live charge in
   *  progress, or already full and just sitting on the charger. Drives the
   *  bolt overlay independent of whether the battery itself is still filling. */
  plugged: boolean;
}

/** Interior fill span of the body rect below, in SVG units. Fill grows upward
 *  from FILL_BOTTOM, so a vertical battery reads top-empty/bottom-full. */
const FILL_X = 4.7;
const FILL_WIDTH = 6.6;
const FILL_BOTTOM = 13.8;
const FILL_MAX_HEIGHT = 8.5;

function batteryTone(percentage: number | null, plugged: boolean): "low" | "medium" | "plugged" | null {
  if (plugged) return "plugged";
  if (percentage == null) return null;
  if (percentage <= 15) return "low";
  if (percentage <= 40) return "medium";
  return null;
}

export function BatteryIndicator({ percentage, plugged }: Props) {
  const t = useT();
  const pct = percentage == null ? null : Math.round(Math.min(100, Math.max(0, percentage)));
  const tone = batteryTone(percentage, plugged);
  const label =
    pct == null
      ? t("batteryIndicator.unknown")
      : `${pct}%${plugged ? t("batteryIndicator.pluggedSuffix") : ""}`;
  // A near-empty battery still shows a sliver so the icon reads as "a battery", not an empty box.
  const fillHeight = pct == null ? FILL_MAX_HEIGHT : Math.max(0.6, (pct / 100) * FILL_MAX_HEIGHT);
  const fillY = FILL_BOTTOM - fillHeight;

  return (
    <svg
      className={`battery-icon${tone ? ` ${tone}` : ""}`}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label={label}
    >
      <title>{label}</title>
      {/* body */}
      <rect x="4" y="3.2" width="8" height="11.3" rx="1.6" stroke="currentColor" strokeWidth="1.3" fill="none" />
      {/* terminal nub */}
      <rect x="6.6" y="1.5" width="2.8" height="1.9" rx="0.6" fill="currentColor" />
      {/* charge level */}
      <rect x={FILL_X} y={fillY} width={FILL_WIDTH} height={fillHeight} rx="0.8" fill="currentColor" />
      {/* energy bolt: on whenever the machine is running off mains, not just while the battery is actively filling */}
      {plugged && (
        <path
          d="M8.8 3.6 L5.8 9.6 L7.6 9.6 L6.8 14.4 L10.2 8.2 L8.2 8.2 Z"
          fill="var(--bg)"
          stroke="currentColor"
          strokeWidth="0.4"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
