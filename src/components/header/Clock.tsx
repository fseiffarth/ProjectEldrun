import { useEffect, useState } from "react";

function fmt(n: number) {
  return String(n).padStart(2, "0");
}

export function Clock() {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const h = fmt(time.getHours());
  const m = fmt(time.getMinutes());
  const s = fmt(time.getSeconds());

  return <span className="header-clock">{h}:{m}:{s}</span>;
}
