import { forwardRef, useState, type InputHTMLAttributes } from "react";

/**
 * Masked text input with a built-in show/hide toggle — a drop-in replacement for
 * `<input type="password" />`. Every input prop (and the ref) is forwarded to the
 * underlying `<input>`, and `className` is applied to it too, so existing
 * per-call-site styling (e.g. `ssh-password-input`) keeps working. An eye button
 * overlaid at the trailing edge flips the field between masked and plain text.
 *
 * The toggle stays enabled even when the input is `disabled` (e.g. while a connect
 * is in flight) so the typed secret can still be checked; it never changes the
 * value and is skipped in the tab order.
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type">
>(function PasswordInput({ className, ...rest }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <span className="password-input-wrap">
      <input
        {...rest}
        ref={ref}
        type={shown ? "text" : "password"}
        className={className}
      />
      <button
        type="button"
        className="password-reveal-btn"
        tabIndex={-1}
        aria-label={shown ? "Hide password" : "Show password"}
        title={shown ? "Hide password" : "Show password"}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </span>
  );
});

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.3 3.7A6.7 6.7 0 0 1 8 3.5c4.5 0 7 4.5 7 4.5a12.6 12.6 0 0 1-2.2 2.7M4 4.6A12.2 12.2 0 0 0 1 8s2.5 4.5 7 4.5a6.9 6.9 0 0 0 2.6-.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.6 6.6a2 2 0 0 0 2.8 2.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="2" y1="2" x2="14" y2="14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
