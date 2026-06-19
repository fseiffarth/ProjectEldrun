// Small three-dot orbit spinner used as an "active work" indicator across the
// UI (project pills, working tabs). Color comes from the `--accent`-fed
// `.orbit-dot` rule by default; pass a `className` to recolor per context.
const ORBIT_R = 4;
const ORBIT_DOTS = [0, 120, 240].map((deg) => {
  const rad = (deg * Math.PI) / 180;
  return { cx: ORBIT_R * Math.sin(rad), cy: -ORBIT_R * Math.cos(rad) };
});

export function OrbitSpinner({ className }: { className?: string }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="-6 -6 12 12"
      className={`orbit-spinner${className ? ` ${className}` : ""}`}
      aria-hidden
    >
      {ORBIT_DOTS.map(({ cx, cy }, i) => (
        <circle key={i} cx={cx} cy={cy} r={1.4} className="orbit-dot" />
      ))}
    </svg>
  );
}
