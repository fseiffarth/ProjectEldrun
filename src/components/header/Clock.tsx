import { useEffect, useState } from "react";
import { useEnergySaver, saverInterval } from "../../stores/power";

function fmt(n: number) {
  return String(n).padStart(2, "0");
}

export function Clock() {
  const [time, setTime] = useState(() => new Date());
  const energySaver = useEnergySaver();

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), saverInterval(1000, energySaver));
    return () => clearInterval(id);
  }, [energySaver]);

  const h = fmt(time.getHours());
  const m = fmt(time.getMinutes());
  const s = fmt(time.getSeconds());

  return <span className="header-clock">{h}:{m}:{s}</span>;
}
