import { useEffect, useState } from "react";
import { useEnergySaver, saverInterval } from "../../stores/power";
import { useSettingsStore } from "../../stores/settings";
import { useUse24h } from "../../lib/timeFormat";

function fmt(n: number) {
  return String(n).padStart(2, "0");
}

export function Clock() {
  const [time, setTime] = useState(() => new Date());
  const energySaver = useEnergySaver();
  const showSeconds = useSettingsStore((s) => s.settings?.show_clock_seconds ?? false);
  const use24h = useUse24h();

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), saverInterval(1000, energySaver));
    return () => clearInterval(id);
  }, [energySaver]);

  const hours = time.getHours();
  // The hour is the only part the format changes: 12-hour drops the leading
  // zero (nobody writes "05:00 PM") while minutes and seconds stay padded.
  const h = use24h ? fmt(hours) : String(hours % 12 === 0 ? 12 : hours % 12);
  const m = fmt(time.getMinutes());
  const s = fmt(time.getSeconds());
  const suffix = use24h ? "" : hours < 12 ? " AM" : " PM";

  return (
    <span className="header-clock">
      {h}:{m}
      {showSeconds ? `:${s}` : ""}
      {suffix}
    </span>
  );
}
