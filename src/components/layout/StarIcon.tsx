interface StarIconProps {
  className?: string;
}

/**
 * The gold spark from the Eldrun logo, on its own — the root-terminal
 * button's mark. Same path as `LogoIcon`'s crown, just cropped to its own
 * viewBox instead of sitting above the ring/branches.
 */
export function StarIcon({ className }: StarIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="200 40 112 122"
      fill="none"
      role="img"
      aria-label="Eldrun"
      className={className}
    >
      <title>Eldrun</title>
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
