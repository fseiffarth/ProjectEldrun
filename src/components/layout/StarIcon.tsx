interface StarIconProps {
  className?: string;
}

/**
 * The gold spark from the Eldrun logo, on its own — the root-terminal
 * button's mark. Same path as `LogoIcon`'s crown, just cropped to its own
 * viewBox instead of sitting above the ring/branches.
 *
 * Decorative on purpose: every host of this mark already carries the label
 * that belongs on it (the root pill says "Root terminal", the detached title
 * bar hides it). An `aria-label` + `<title>` here would win the native
 * tooltip over its host button's, so hovering the glyph said "Eldrun" while
 * hovering the padding beside it said "Root terminal".
 */
export function StarIcon({ className }: StarIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="200 40 112 122"
      fill="none"
      aria-hidden="true"
      className={className}
    >
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
