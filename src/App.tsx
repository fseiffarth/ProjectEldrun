import { Suspense, lazy } from "react";
import { AppShell } from "./components/layout/AppShell";
import { DetachedApp } from "./components/layout/DetachedApp";
import { parseDetachedParam } from "./stores/detached";
import { parsePresentParam } from "./lib/viewers/deck/present";

// Code-split (§5.1 startup size): a static import would pull the deck renderer
// — and through `deckBase`, all of pdfjs-dist — into the startup chunk of
// EVERY window, though only the `?present=` audience window renders this.
const DeckAudienceApp = lazy(() =>
  import("./components/embed/deck/DeckAudienceApp").then((m) => ({ default: m.DeckAudienceApp })),
);

export function App() {
  // #42: when launched with `?detached=<scope>:<group>` (a popped-out subwindow),
  // render the lightweight DetachedApp instead of the full shell. DetachedApp is
  // inert to project switches (no projects store / runtime-switch listener), so
  // the main window's project switching never drives the detached renderer.
  const detached = parseDetachedParam(window.location.search);
  if (detached) {
    return <DetachedApp param={detached} />;
  }
  // M#90: `?present=<label>` is the deck presenter's AUDIENCE window — the one
  // that goes on the projector. Lighter still than a popout: no tabs, no layout,
  // no store, just the slide it is told to show.
  const present = parsePresentParam(window.location.search);
  if (present) {
    return (
      <Suspense fallback={null}>
        <DeckAudienceApp label={present} />
      </Suspense>
    );
  }
  return <AppShell />;
}
