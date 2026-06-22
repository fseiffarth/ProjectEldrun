import { useEffect, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
}

/**
 * The one themed dropdown used across the app. Native <select> popups can't be
 * styled on WebKitGTK (they render a light OS popup), so this is a custom
 * trigger + menu that follows the app theme — a dark, "fancy" dropdown in dark
 * themes. Used for the file-browser sort, the LaTeX engine selector, etc.
 *
 * Closes on outside click / Escape and reflects the selected option with a
 * trailing caret on the trigger.
 */
export function Dropdown({
  value,
  options,
  onChange,
  disabled = false,
  title,
  className,
  placeholder,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
  /** Extra class on the wrapper, e.g. for compact per-context sizing. */
  className?: string;
  /** Shown on the trigger when no option matches `value`. */
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div
      className={`dropdown${className ? ` ${className}` : ""}`}
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="dropdown-trigger"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current ? current.label : (placeholder ?? "")}
        <span className="dropdown-caret">▾</span>
      </button>
      {open && (
        <div className="context-menu dropdown-menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={o.value === value ? "selected" : ""}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
