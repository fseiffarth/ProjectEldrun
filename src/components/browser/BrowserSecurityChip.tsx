import { useState } from "react";
import { createPortal } from "react-dom";
import { securityGlyph, securityTone } from "../../lib/browser";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import type { SecurityState } from "../../types/browser";

/**
 * The security chip and its popover.
 *
 * **It renders what the backend sent and computes nothing.** The chip's position
 * and styling are the frontend's; the *meaning* is the policy's. Three rules
 * from `docs/browser_plan_b.md` §7.1 are enforced here rather than assumed:
 *
 *  1. **The TLS state is a word, not only an icon.** `Secure` / `Not secure` /
 *     `Unknown`, with the host. Icons alone are a solved failure — users do not
 *     read them — so the glyph is ornament beside the word, never instead of it.
 *  2. **A state the frontend does not recognize renders as unknown**, never as
 *     secure (`securityTone`'s job).
 *  3. **The host is never ellipsis-truncated.** Truncation is itself the attack:
 *     `https://example.com.evil.tld/…` reads as `https://example.com…`. The
 *     popover wraps instead.
 *
 * The popover is portaled to `<body>` and therefore sets an explicit `color` via
 * `.browser-security-popover` — `body` carries none, so an inherited color
 * renders black (the canonical menu/dialog rule this repo already follows for
 * `EventDialog` and `MailAccountDialog`).
 */
export function BrowserSecurityChip({
  security,
  vpnConfigName,
}: {
  security: SecurityState | null;
  /** Shown beside the VPN line when a tunnel is up, if the caller knows it. */
  vpnConfigName?: string;
}) {
  const t = useT();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const tone = securityTone(security);
  const label =
    tone === "secure"
      ? t("browser.securitySecure")
      : tone === "insecure"
        ? t("browser.securityInsecure")
        : t("browser.securityUnknown");

  return (
    <>
      <button
        type="button"
        className={`browser-security-chip tone-${tone}`}
        title={t("browser.securityDetails")}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPos(pos ? null : { x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <span className="browser-security-glyph" aria-hidden>
          {securityGlyph(tone)}
        </span>
        <span className="browser-security-word">{label}</span>
        {security?.vpn_active && (
          <span className="browser-vpn-chip" title={t("browser.vpnChipHelp")}>
            {t("browser.vpnChip")}
          </span>
        )}
      </button>

      {pos &&
        createPortal(
          <>
            <div
              style={{ position: "fixed", inset: 0, zIndex: 200 }}
              onPointerDown={() => setPos(null)}
            />
            <div
              className="context-menu browser-security-popover"
              style={{ left: pos.x, top: pos.y, zIndex: 201 }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="context-menu-group-label">
                {t("browser.securityDetails")} <UntestedTag />
              </div>
              <div className="browser-security-row">
                <span className="browser-security-label">{t("browser.securityOrigin")}</span>
                {/* Never truncated — the host is the only part that decides
                    where anything went. */}
                <span className="browser-security-value">{security?.host_display || "—"}</span>
              </div>
              <div className="browser-security-row">
                <span className="browser-security-label">{t("browser.securityScheme")}</span>
                <span className="browser-security-value">{security?.scheme || "—"}</span>
              </div>
              <div className="browser-security-row">
                <span className="browser-security-label">{t("browser.securityTls")}</span>
                <span className="browser-security-value">{label}</span>
              </div>
              {security?.punycode_warning && (
                <div className="browser-warning-strip">
                  {t("browser.punycodeWarning", { ascii: security.punycode_warning })}
                </div>
              )}
              {security?.vpn_active && (
                <div className="browser-note-strip">
                  {t("browser.vpnActive")}
                  {vpnConfigName ? ` (${vpnConfigName})` : ""}
                </div>
              )}
              <div className="browser-security-note">{t("browser.securityNote")}</div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
