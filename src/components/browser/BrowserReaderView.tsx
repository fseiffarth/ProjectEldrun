import { useEffect, useMemo, useRef } from "react";
import { buildReaderSrcdoc, readerLooksUnsafe } from "../../lib/browser";
import { useT } from "../../lib/i18n";
import type { ReaderPage } from "../../types/browser";

/**
 * The reader pane's body: a fetched page's sanitized HTML, rendered in an
 * `<iframe sandbox="" …>` and nowhere else.
 *
 * This is `MailMessageView`'s containment, applied to a web page for exactly the
 * same reason — the bytes are attacker-chosen and the surrounding document holds
 * the full Tauri IPC bridge. Every property of that design carries over
 * unchanged, and none of it may be relaxed:
 *
 *  - **`sandbox=""` with no tokens.** No `allow-scripts` (so JS is disabled by
 *    the *sandbox*, not merely by the sanitizer) and no `allow-same-origin` (the
 *    two together are a total escape — the frame could reach `parent.document`
 *    and `__TAURI__`). Nothing may be added to that attribute, ever.
 *  - **Its own `<meta>` CSP**, because the backend's sanitizer, the sandbox and
 *    the policy are three independent layers and the design assumes any one of
 *    them can fail. It is an inline `<meta>` and not the `csp=` attribute
 *    because CSP Embedded Enforcement is a Chromium feature WebKitGTK does not
 *    implement — the attribute would produce a policy that silently does not
 *    exist on Linux.
 *  - **The frame has an opaque origin**, so `blob:` URLs are not loadable inside
 *    it and there are no scripts to post to it. This component therefore
 *    installs no `message` listener at all.
 *  - **`readerLooksUnsafe` gates the render.** It is the mail tripwire, not a
 *    second sanitizer: if live markup survived the backend's `ammonia` pass, the
 *    honest response is an error card, never a render.
 *  - **No `dangerouslySetInnerHTML` anywhere in this directory.** The srcdoc is
 *    assigned through the DOM property (a multi-MB body must not be
 *    re-serialized through React's attribute path on every render — WebKitGTK
 *    pays for that in attribute parsing).
 */
export function BrowserReaderView({ page }: { page: ReaderPage }) {
  const t = useT();
  const frameRef = useRef<HTMLIFrameElement>(null);

  const unsafe = readerLooksUnsafe(page.html ?? "");
  const doc = useMemo(
    () => (unsafe ? "" : buildReaderSrcdoc({ html: page.html, title: page.title })),
    [page.html, page.title, unsafe],
  );

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.srcdoc = doc;
  }, [doc]);

  if (unsafe) {
    /* The tripwire fired: the sanitized HTML still carried something active.
       Rendering anyway would be the one catastrophic failure (app-origin XSS
       with the full IPC surface behind it), so this refuses instead. */
    return (
      <div className="browser-unsafe-card">
        <strong>{t("browser.unsafePage")}</strong>
        <p>{t("browser.unsafePageHint")}</p>
      </div>
    );
  }

  return (
    <div className="browser-reader">
      <div className="browser-reader-banner">
        <span className="browser-reader-mode">{t("browser.readerMode")}</span>
        <span className="browser-reader-hint">{t("browser.readerModeHint")}</span>
      </div>
      {page.truncated && (
        <div className="browser-warning-strip">{t("browser.truncated")}</div>
      )}
      {page.blocked_remote_assets > 0 && (
        /* Blocked, with no way to unblock — and the banner says exactly that
           rather than offering a button. Loading remote content is a backend
           action (a proxy that inlines `data:` URIs) or it does not happen; a
           button here would clear the banner, report success, and fetch
           nothing. The app CSP has no `https:` in any fetch directive and must
           never gain one. */
        <div className="browser-note-strip">
          {t("browser.remoteBlocked", { count: page.blocked_remote_assets })}
        </div>
      )}
      {page.final_url !== page.requested_url && (
        <div className="browser-note-strip">
          {t("browser.redirected", { url: page.display_url })}
        </div>
      )}
      <iframe
        ref={frameRef}
        // sandbox="" is the whole policy and is load-bearing. NOTHING may be
        // added here — see the file comment.
        sandbox=""
        referrerPolicy="no-referrer"
        loading="eager"
        title={t("browser.readerFrameTitle")}
        className="browser-reader-frame"
      />
    </div>
  );
}
