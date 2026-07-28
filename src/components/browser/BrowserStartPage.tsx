import { formatAddressParts } from "../../lib/browser";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/**
 * The blank-tab start page and the **resume card**.
 *
 * The resume card is the whole of this feature's restore behaviour, and it is a
 * deliberate refusal rather than a missing button: a restored browser tab does
 * **not** navigate at launch. Restoring six tabs would be six automatic outbound
 * requests, to whatever the user last had open, before they have looked at the
 * screen — and "nothing about a window being reopened is consent to dial out"
 * is the rule the mail client already states. The persisted URL is rendered here as
 * *text*, with the host at full weight, behind a Load button.
 *
 * The URL is attacker-influenceable (it is whatever page the tab last committed
 * to), so it is a plain text node with origin emphasis, never markup and never
 * truncated with an ellipsis.
 */
export function BrowserStartPage({
  url,
  onLoad,
  onOpenAddress,
}: {
  /** The persisted address, if any. Empty = a fresh tab's start page. */
  url: string;
  onLoad: () => void;
  onOpenAddress: () => void;
}) {
  const t = useT();
  const parts = formatAddressParts(url);

  if (!url) {
    return (
      <div className="browser-start">
        <div className="browser-start-title">
          {t("browser.startTitle")} <UntestedTag />
        </div>
        <p className="browser-start-hint">{t("browser.startHint")}</p>
        <button type="button" className="browser-btn browser-btn-primary" onClick={onOpenAddress}>
          {t("browser.startTypeAddress")}
        </button>
      </div>
    );
  }

  return (
    <div className="browser-start">
      <div className="browser-start-title">
        {t("browser.resumeTitle")} <UntestedTag />
      </div>
      <div className="browser-resume-url">
        {parts.raw ? (
          <span className="browser-address-rest">{parts.rest}</span>
        ) : (
          <>
            <span className="browser-address-dim">{parts.scheme}</span>
            {parts.userinfo && (
              <span className="browser-address-userinfo">{parts.userinfo}</span>
            )}
            <span className="browser-address-host">{parts.host}</span>
            <span className="browser-address-dim">{parts.port}</span>
            <span className="browser-address-rest">{parts.rest}</span>
          </>
        )}
      </div>
      <p className="browser-start-hint">{t("browser.resumeHint")}</p>
      <button type="button" className="browser-btn browser-btn-primary" onClick={onLoad}>
        {t("browser.resumeLoad", { host: parts.host || url })}
      </button>
    </div>
  );
}
