import { useEffect, useState } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { finishSignIn } from "../api";
import { describeFailure } from "../connection";
import { pastedCallback, type SignIn } from "../terminal/signIn";

type Outcome = { text: string; error?: boolean };

/**
 * Finishes an agent CLI's browser sign-in from the phone (`signIn.ts` reads
 * it off the session). One sheet for every CLI; what it asks for follows the
 * flow the link is in:
 *
 *   - device:   the code to enter on the page, with Copy;
 *   - code:     a field for the code the page ends on, typed into the session
 *               with Enter, as the CLI's own prompt asks;
 *   - callback: a field for the `localhost` address the browser failed on,
 *               which the desktop delivers to the CLI (`finishSignIn`);
 *   - wait:     nothing: the CLI notices by itself.
 *
 * Either field takes either answer — the one that fits is used — because
 * Antigravity both redirects home and asks for a pasted code, and the reader
 * cannot be expected to know which the CLI will take. `signIn` is the live
 * reading: once the session stops drawing the link, the sheet says so rather
 * than offering a page that no longer leads anywhere.
 */
export function SignInSheet({ tabId, agent, signIn, connected, onType, onClose }: {
  tabId: string;
  agent: string;
  signIn: SignIn | null;
  connected: boolean;
  /** Types the code into the session and presses Enter; false when it did
   * not leave the phone. */
  onType: (text: string) => boolean;
  onClose: () => void;
}) {
  const t = useT();
  // The link the sheet opened on, kept while the session repaints; a new
  // link (a retry) replaces it.
  const [shown, setShown] = useState<SignIn | null>(signIn);
  useEffect(() => { if (signIn) setShown(signIn); }, [signIn]);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);

  const copy = (what: "link" | "code", text: string) => {
    // No clipboard (an insecure origin, a refused permission) leaves the
    // button as it was; the link still opens.
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1600);
    }).catch(() => undefined);
  };

  const submit = async () => {
    const text = answer.trim();
    if (!text || busy || !shown) return;
    setOutcome(null);
    const callback = pastedCallback(text);
    if (callback) {
      setBusy(true);
      try {
        await finishSignIn(tabId, callback);
        setOutcome({ text: t("mobile.signIn.delivered", { agent }) });
        setAnswer("");
      } catch (cause) {
        setOutcome({ text: describeFailure(cause), error: true });
      } finally {
        setBusy(false);
      }
      return;
    }
    if (shown.flow === "callback") {
      setOutcome({ text: t("mobile.signIn.needAddress"), error: true });
      return;
    }
    if (!onType(text)) {
      setOutcome({ text: t("mobile.signIn.notSent"), error: true });
      return;
    }
    setOutcome({ text: t("mobile.signIn.codeSent", { agent }) });
    setAnswer("");
  };

  const flow = shown?.flow;
  const asks = flow === "code" || flow === "callback";
  const hint = flow === "device" ? t("mobile.signIn.deviceHint", { agent })
    : flow === "code" ? t("mobile.signIn.codeHint")
      : flow === "callback" ? t("mobile.signIn.callbackHint")
        : t("mobile.signIn.waitHint", { agent });

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet sign-in-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.signIn.title", { agent })} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>
        <h2>{t("mobile.signIn.title", { agent })}{isUntested("mobile.signIn") && <small>{t("mobile.focus.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>

      {shown && <>
        <div className="sign-in-open">
          <a className="button primary" href={shown.url} target="_blank" rel="noopener noreferrer">
            <strong>{t("mobile.signIn.openPage")}</strong>
            <small>{t("mobile.signIn.site", { site: shown.site })}</small>
          </a>
          <button onClick={() => copy("link", shown.url)}>{copied === "link" ? t("mobile.signIn.copied") : t("mobile.signIn.copyLink")}</button>
        </div>
        {shown.userCode && <div className="sign-in-code">
          <code>{shown.userCode}</code>
          <button onClick={() => copy("code", shown.userCode ?? "")}>{copied === "code" ? t("mobile.signIn.copied") : t("mobile.signIn.copyCode")}</button>
        </div>}
        <p className="sheet-note">{hint}</p>
        {asks && <form className="mobile-schedule-form sign-in-answer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label>
            {flow === "callback" ? t("mobile.signIn.callbackLabel") : t("mobile.signIn.codeLabel")}
            <input
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              inputMode={flow === "callback" ? "url" : "text"}
              placeholder={flow === "callback" ? "http://localhost:…" : ""}
            />
          </label>
          <div className="mobile-schedule-actions">
            <button className="primary" type="submit" disabled={!connected || busy || !answer.trim()}>
              {busy ? t("mobile.signIn.sending") : flow === "callback" ? t("mobile.signIn.finish") : t("mobile.signIn.send", { agent })}
            </button>
          </div>
        </form>}
        {!asks && <p className="sheet-note">{t("mobile.signIn.otherBrowser")}</p>}
      </>}

      {outcome && <p className={outcome.error ? "sheet-note error" : "sheet-note"} role={outcome.error ? "alert" : "status"}>{outcome.text}</p>}
      {!signIn && <p className="sheet-note" role="status">{t("mobile.signIn.gone")}</p>}
    </section>
  </div>;
}
