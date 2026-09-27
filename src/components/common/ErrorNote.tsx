import { useState } from "react";
import { useT } from "../../lib/i18n";
import { friendlyError } from "../../lib/errors";

/**
 * An error line: the plain-language summary from `friendlyError` with the raw
 * text one click away under "Details", or — for an error no rule knows — the
 * raw text exactly as before. Renders the caller's own element and class, so
 * swapping `{error && <div className="x">{error}</div>}` for
 * `{error && <ErrorNote className="x" error={error} />}` keeps each site's look.
 *
 * The disclosure is a button plus an inline `<code>` rather than
 * `<details>`, which is block content and not allowed inside the `<p>` some
 * sites render.
 */
export function ErrorNote({
  error,
  className,
  as: Tag = "div",
  id,
  role,
}: {
  error: string;
  className?: string;
  as?: "div" | "p" | "span";
  id?: string;
  role?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const friendly = friendlyError(error, t);
  if (!friendly) {
    return <Tag className={className} id={id} role={role}>{error}</Tag>;
  }
  return (
    <Tag className={className} id={id} role={role}>
      {friendly.summary}{" "}
      <button
        type="button"
        className="inline-link-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? t("errors.hideDetails") : t("errors.details")}
      </button>
      {open && <code className="error-note-raw">{friendly.detail}</code>}
    </Tag>
  );
}
