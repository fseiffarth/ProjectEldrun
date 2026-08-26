interface TrashProjectIconProps {
  className?: string;
}

/** Compact mark for Eldrun's built-in disposable-agent workspace. */
export function TrashProjectIcon({ className }: TrashProjectIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M3 6h18M9 6V4h6v2M7 6l1 14h8l1-14M10 11v6M14 11v6" />
    </svg>
  );
}
