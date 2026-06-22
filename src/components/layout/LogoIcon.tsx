interface LogoIconProps {
  className?: string;
}

/**
 * Eldrun logo — a circuit "tree of life" inside a ring, crowned by a gold spark.
 * Inlined (vs. an <img> src) so the ring/branch strokes can use `currentColor`
 * and stay legible across themes; the gold spark keeps its brand colour.
 */
export function LogoIcon({ className }: LogoIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      fill="none"
      role="img"
      aria-label="Eldrun"
      className={className}
    >
      <title>Eldrun</title>
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        {/* Ring, with a small opening at the bottom where the trunk passes through. */}
        <path d="M 214 491 A 239 239 0 1 1 298 491" strokeWidth="10" />

        {/* Central trunk stem. */}
        <path d="M 256 161 L 256 499" strokeWidth="10" />

        {/* Left-side branches + descending leg (authored), then mirrored. */}
        <g id="eldrun-branches">
          <path
            d="M 165 176 L 165 238 L 233 306 L 233 440 L 222 483"
            strokeWidth="10"
          />
          <path
            d="M 98 235 L 98 289 L 144 335 L 233 405"
            strokeWidth="10"
          />
          <circle cx="165" cy="162" r="14" strokeWidth="8" />
          <circle cx="98" cy="221" r="14" strokeWidth="8" />
          <circle cx="144" cy="335" r="14" strokeWidth="8" />
        </g>
        <use href="#eldrun-branches" transform="translate(512,0) scale(-1,1)" />
      </g>

      {/* Gold four-point spark above the trunk. */}
      <path
        d="M 256 61
           C 261 92 268 96 292 101
           C 268 106 261 110 256 142
           C 251 110 244 106 220 101
           C 244 96 251 92 256 61 Z"
        fill="#C79A45"
      />
    </svg>
  );
}
