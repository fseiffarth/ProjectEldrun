import { createPortal } from "react-dom";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { STEERING_KEYS } from "../../lib/shortcuts";
import { useT } from "../../lib/i18n";

/**
 * The compact bottom-center legend shown while keyboard steering mode is
 * active — the visible half of the mode's contract (every key is swallowed, so
 * the user must be able to see what the keys do and how to get out). Renders
 * entirely from `STEERING_KEYS`, the same table the cheat-sheet/lesson
 * surfaces use, so the legend can never list a key the handler doesn't act on.
 *
 * Mounted once in `AppShell` (the FocusFrameOverlay/host pattern) and
 * portalled to `document.body` so no pane clips it; `pointer-events: none` —
 * steering is a keyboard mode, the legend is display only.
 */
export function SteeringLegend() {
  const t = useT();
  const active = useKeyboardSteeringStore((s) => s.active);
  if (!active) return null;
  return createPortal(
    <div className="steering-legend" role="status">
      <span className="steering-legend-title">{t("steering.legendTitle")}</span>
      {STEERING_KEYS.map((k) => (
        <span className="steering-legend-item" key={k.labelKey} title={t(k.descKey)}>
          <kbd>{k.keys}</kbd> {t(k.labelKey)}
        </span>
      ))}
    </div>,
    document.body,
  );
}
