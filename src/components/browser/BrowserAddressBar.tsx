import { useEffect, useRef, useState } from "react";
import { formatAddressParts } from "../../lib/browser";
import { parseAddressInput, type AddressCommit } from "../../lib/linkTarget";
import { useT } from "../../lib/i18n";
import type { SecurityState } from "../../types/browser";
import { BrowserSecurityChip } from "./BrowserSecurityChip";

/**
 * The address field — **a security control, not a text field**.
 *
 * Rules taken from `docs/browser_plan_b.md` §7.1 and enforced by the markup
 * rather than by convention:
 *
 *  1. **Origin emphasis.** Scheme, path and query are muted; the host is at full
 *     weight. (The *registrable domain* would be the ideal unit to bold, but
 *     that needs a Public Suffix List and the list lives in the backend — see
 *     `formatAddressParts`. Bolding a two-label guess would emphasize `co.uk`
 *     for `shop.example.co.uk`, which that same section calls worse than not
 *     bolding at all.)
 *  2. **The host is never ellipsis-truncated.** Truncation is itself the attack.
 *     Long paths may be elided from the right; the scheme, userinfo indicator,
 *     host and port are always shown in full and the field scrolls if it must.
 *  3. **Userinfo is flagged, and the host is the parser's**, never a string
 *     search's — `https://example.com@evil.example/` goes to `evil.example`.
 *  4. **A punycode host shows both forms**: the Unicode form the backend
 *     computed, and the `xn--` ASCII form beside it, labelled. Never the
 *     Unicode form alone.
 *
 * Edit state shows the raw URL, selected on focus. `Escape` reverts to the
 * committed address and blurs; `Enter` commits through `parseAddressInput`,
 * which refuses a non-`http(s)` scheme with a reason and never navigates one.
 * That check is a first, independent gate — the backend's policy is the
 * boundary, and this is not it.
 */
export interface BrowserAddressBarProps {
  /** The committed address (what actually loaded), shown when not editing. */
  url: string;
  /** The display form the backend computed (punycode decoded, userinfo
   *  stripped, IP literals normalized). Falls back to `url`. */
  displayUrl?: string;
  security: SecurityState | null;
  searchTemplate?: string;
  disabled?: boolean;
  /** Bumped by the pane to put the field into edit state (the start page's
   *  "Type an address" button). A counter rather than a boolean, so a second
   *  press after an Escape still opens it. */
  editSignal?: number;
  onCommit: (commit: AddressCommit) => void;
}

export function BrowserAddressBar({
  url,
  displayUrl,
  security,
  searchTemplate,
  disabled = false,
  editSignal = 0,
  onCommit,
}: BrowserAddressBarProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(url);
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A navigation that happened elsewhere (a resume card's Load, a restore)
  // must move the field the user is not currently typing in.
  useEffect(() => {
    if (!editing) setDraft(url);
  }, [url, editing]);

  // The start page's "Type an address" button focuses this field rather than
  // duplicating an input somewhere else — one address bar, one commit rule.
  useEffect(() => {
    if (editSignal > 0) setEditing(true);
  }, [editSignal]);

  const shown = displayUrl || url;
  const parts = formatAddressParts(shown);

  const commit = () => {
    const result = parseAddressInput(draft, searchTemplate);
    if (result.kind === "empty") {
      setEditing(false);
      return;
    }
    if (result.kind === "refuse") {
      setHint(
        result.reason === "scheme"
          ? t("browser.addressRefusedScheme", { scheme: result.scheme ?? "" })
          : t("browser.addressNotUrl"),
      );
      return;
    }
    setHint(null);
    setEditing(false);
    onCommit(result);
  };

  return (
    <div className="browser-address">
      <BrowserSecurityChip security={security} />
      {editing ? (
        <input
          ref={inputRef}
          className="browser-address-input"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={t("browser.addressPlaceholder")}
          onChange={(e) => {
            setDraft(e.target.value);
            if (hint) setHint(null);
          }}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(url);
              setHint(null);
              setEditing(false);
              e.currentTarget.blur();
            }
          }}
          onBlur={() => {
            setEditing(false);
            setDraft(url);
            setHint(null);
          }}
          autoFocus
        />
      ) : (
        <button
          type="button"
          className="browser-address-display"
          disabled={disabled}
          title={shown}
          onClick={() => {
            setDraft(url);
            setEditing(true);
          }}
        >
          {parts.raw ? (
            <span className="browser-address-rest">
              {parts.rest || t("browser.addressPlaceholder")}
            </span>
          ) : (
            <>
              <span className="browser-address-dim">{parts.scheme}</span>
              {parts.userinfo && (
                <span className="browser-address-userinfo">{parts.userinfo}</span>
              )}
              {/* Full weight, never shortened. */}
              <span className="browser-address-host">{parts.host}</span>
              <span className="browser-address-dim">{parts.port}</span>
              <span className="browser-address-rest">{parts.rest}</span>
            </>
          )}
        </button>
      )}

      {parts.userinfo && !editing && (
        <span className="browser-address-flag" title={t("browser.userinfoWarningHelp")}>
          {t("browser.userinfoWarning")}
        </span>
      )}
      {security?.punycode_warning && !editing && (
        /* Both forms, always. The Unicode host is what the backend put in
           `host_display`; this is the ASCII truth beside it. */
        <span className="browser-address-punycode" title={t("browser.punycodeHelp")}>
          {security.punycode_warning}
        </span>
      )}
      {hint && <span className="browser-address-hint">{hint}</span>}
    </div>
  );
}
