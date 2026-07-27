import { useEffect } from "react";
import {
  onBrowserBlocked,
  onBrowserDownloadRequested,
  onBrowserLiveClosed,
  onBrowserLiveState,
} from "../../lib/browser";
import { useBrowserStore } from "../../stores/browser";

/**
 * Install the backend's browser events **once per window**, however many browser
 * panes are mounted.
 *
 * The flat pane layer keeps every tab of every scope mounted forever
 * (`CenterPanel`), so a per-pane `listen` would install one set of listeners per
 * browser tab in the whole app — and then a single quarantined download would
 * raise its consent dialog N times, or worse, be answered N times. A refcount is
 * the smallest thing that fixes it; the listeners are torn down when the last
 * holder unmounts.
 *
 * The generation counter is not decoration. `listen` is async, so a
 * mount→unmount→mount pair that outruns the promises would otherwise resolve the
 * *first* cycle's handles into the *second* cycle's teardown list — leaving two
 * live sets of listeners and undoing the whole point of the refcount. Handles
 * are therefore kept only if the generation they were installed for is still the
 * current one, and dropped (unlistened) otherwise.
 *
 * A popout is a separate JS heap with its own React root, so it gets its own
 * refcount and its own listeners. That is correct: the backend emits to every
 * window, and each window's store needs the state.
 */

let refs = 0;
let generation = 0;
let unlisten: Array<() => void> = [];

function install(): void {
  const mine = ++generation;
  const keep = (un: () => void) => {
    if (generation !== mine) un();
    else unlisten.push(un);
  };
  const store = () => useBrowserStore.getState();

  void onBrowserLiveState((e) => store().applyLiveState(e)).then(keep);
  void onBrowserLiveClosed((e) => store().applyLiveClosed(e.label)).then(keep);
  void onBrowserDownloadRequested((e) => store().applyDownloadRequest(e)).then(keep);
  // A blocked navigation names the live window it happened in; the store routes
  // on that, so a live window's refusal never lands on an unrelated reader tab.
  void onBrowserBlocked((e) => store().applyBlocked(e)).then(keep);
}

function teardown(): void {
  generation += 1;
  unlisten.forEach((un) => un());
  unlisten = [];
}

export function useBrowserEvents(): void {
  useEffect(() => {
    refs += 1;
    if (refs === 1) install();
    return () => {
      refs -= 1;
      if (refs === 0) teardown();
    };
  }, []);
}
