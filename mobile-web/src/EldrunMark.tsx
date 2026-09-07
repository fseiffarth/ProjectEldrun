/**
 * The Eldrun mark — the same circuit "tree of life" the desktop app draws in
 * its launch splash (`src/components/layout/LogoIcon.tsx`).
 *
 * Inlined rather than an `<img src="/icons/icon.svg">` for the desktop's
 * reason: the ring/branch strokes take `currentColor`, so the mark stays
 * legible wherever it is placed, while the gold spark keeps its brand colour.
 * The mirrored branches are written out instead of `<use href="#…">` — an id
 * inside a component that may be mounted more than once on a page is a
 * collision waiting to happen, and `public/icons/icon.svg` already spells them
 * out the same way.
 *
 * The mobile bundle is built from its own Vite root (`vite.mobile.config.ts`),
 * so it cannot import the desktop component; this is the copy, and the two are
 * the same paths.
 */
export function EldrunMark({ className }: { className?: string }) {
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

        {/* Left-side branches + descending leg. */}
        <path d="M 165 176 L 165 238 L 233 306 L 233 440 L 222 483" strokeWidth="10" />
        <path d="M 98 235 L 98 289 L 134.1 325.1 M 155 343.7 L 233 405" strokeWidth="10" />
        <circle cx="165" cy="162" r="14" strokeWidth="8" />
        <circle cx="98" cy="221" r="14" strokeWidth="8" />
        <circle cx="144" cy="335" r="14" strokeWidth="8" />

        {/* Right-side branches (the mirror of the above). */}
        <path d="M 347 176 L 347 238 L 279 306 L 279 440 L 290 483" strokeWidth="10" />
        <path d="M 414 235 L 414 289 L 377.9 325.1 M 357 343.7 L 279 405" strokeWidth="10" />
        <circle cx="347" cy="162" r="14" strokeWidth="8" />
        <circle cx="414" cy="221" r="14" strokeWidth="8" />
        <circle cx="368" cy="335" r="14" strokeWidth="8" />
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
