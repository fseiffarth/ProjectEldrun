import { useBrowserStore } from "../../stores/browser";
import { BrowserDownloadDialog } from "./BrowserDownloadDialog";
import { useBrowserEvents } from "./useBrowserEvents";

/**
 * The one place the download-consent dialog is mounted, per window.
 *
 * It is a host rather than something `BrowserPane` renders, for a reason that is
 * specific to how this app lays panes out: `CenterPanel` keeps **every** tab of
 * **every** scope mounted forever and hides the inactive ones with
 * `display: none`. A portal escapes that — `createPortal(…, document.body)`
 * renders outside the hidden subtree — so a dialog rendered by the pane would
 * appear once per browser tab in the whole application, stacked, each with its
 * own `.modal-backdrop`. The refcounted listener in `useBrowserEvents` stops the
 * *event* being handled N times; it cannot stop N panes rendering the same store
 * field. Only a single mount can.
 *
 * The same reasoning is why it also holds the event listeners: a download is
 * raised by a **live-page window**, which outlives any particular browser tab and
 * can still be open when the last one is closed. With the listeners mounted at
 * the window instead, a download from a live window is answerable whether or not
 * a browser tab happens to exist.
 *
 * Mounted once in `AppShell` and once in `DetachedApp` — a popout is a separate
 * JS heap with its own store, and the backend emits to every window.
 */
export function BrowserDownloadHost() {
  useBrowserEvents();
  const download = useBrowserStore((s) => s.download);
  if (!download) return null;
  return (
    <BrowserDownloadDialog
      request={download}
      onDecide={(accept) => void useBrowserStore.getState().decideDownload(accept)}
    />
  );
}
