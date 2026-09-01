import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { EldrunMark } from "./EldrunMark";
import { hasPairedDevice, logoutAuth, resumeAuth } from "./auth";
import { setUnauthorizedHandler, type TabRow } from "./api";
import { classifyUnavailable, describeUnavailable, unavailableDetail, type UnavailableReason } from "./connection";
import { forgetLastTab, rememberLastTab, restoreLastTab } from "./lastTab";
import { hasLocalUnlock } from "./localLock";
import { Pair } from "./screens/Pair";
import { LocalUnlock } from "./screens/LocalUnlock";
import { Home } from "./screens/Home";
import { Project } from "./screens/Project";
import { Terminal } from "./screens/Terminal";
import { Todo } from "./screens/Todo";
import { Mail } from "./screens/Mail";
import { Calendar } from "./screens/Calendar";

/**
 * The four top-level sections. To-do, Calendar and Mail used to be pushed on
 * top of the project list as one-way screens reached from the home header, so
 * every glance at the board cost a trip back through Projects. They are peers
 * of the project list, not children of it, and the tab bar says so: each keeps
 * its own place, and the bar is the only way between them.
 */
type Tab = "projects" | "todo" | "calendar" | "mail";
/** Where the Projects tab is standing: the list, or one project's tabs. */
type ProjectView = { kind: "home" } | { kind: "project"; id: string };
const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "projects", icon: "🗂", label: "Projects" },
  { id: "todo", icon: "☑", label: "To-do" },
  { id: "calendar", icon: "🗓", label: "Calendar" },
  { id: "mail", icon: "✉", label: "Mail" },
];
const UNLOCKED_SESSION = "eldrun-mobile-local-unlocked";
/**
 * How long Eldrun Mobile may go untouched before the local lock closes the
 * session. Long enough to outlast a reload, a trip to another app, and reading a
 * screenful of terminal output without touching the glass; short enough that a
 * phone whose own screen saver has taken over is locked here too — the web
 * offers no screen-off signal of its own, so idle time is the stand-in.
 */
const LOCK_AFTER_IDLE_MS = 180_000;
/** What counts as someone being there. Streamed terminal output does not. */
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "input", "touchstart", "touchmove", "wheel", "scroll"] as const;

function hasUnlockedSession(): boolean {
  return sessionStorage.getItem(UNLOCKED_SESSION) === "1";
}

function rememberUnlockedSession(): void {
  sessionStorage.setItem(UNLOCKED_SESSION, "1");
}

function forgetUnlockedSession(): void {
  sessionStorage.removeItem(UNLOCKED_SESSION);
}

/**
 * The launch curtain, and the same one the desktop app draws while its settings
 * and project reads are in flight (`AppShell`'s `StartupSplash`): the Eldrun
 * mark inside two counter-rotating orbit rings. It stood in as a `✦` glyph,
 * which is the one screen a phone reliably sees on every cold open — the PWA is
 * unlocked and re-authenticated from scratch every time it is brought back.
 *
 * Deliberately no minimum display time, unlike the desktop's: this is shown
 * while a real round trip to the sidecar is outstanding, so a fast answer
 * should reach the user at once rather than be held behind a flourish.
 */
function Splash({ message, progress, tone, children }: { message: string; progress?: boolean; tone?: "error"; children?: ReactNode }) {
  return (
    <main className={`screen splash${tone === "error" ? " splash-failed" : ""}`} role="status" aria-live="polite">
      <div className="splash-mark" aria-hidden="true">
        <span className="splash-orbit splash-orbit-one" />
        <span className="splash-orbit splash-orbit-two" />
        <EldrunMark />
      </div>
      <div className="splash-name">ELDRUN</div>
      <p className="splash-message">{message}</p>
      {progress ? <div className="splash-progress" aria-hidden="true"><span /></div> : null}
      {children}
    </main>
  );
}

function TabBar({ active, open }: { active: Tab; open: (tab: Tab) => void }) {
  return <nav className="mobile-tabbar" aria-label="Sections">
    {TABS.map((tab) => <button
      key={tab.id}
      className={`mobile-tab${active === tab.id ? " active" : ""}`}
      aria-current={active === tab.id ? "page" : undefined}
      onClick={() => open(tab.id)}
    ><span aria-hidden="true">{tab.icon}</span>{tab.label}</button>)}
  </nav>;
}

export function App() {
  const [auth, setAuth] = useState<"loading" | "paired" | "unpaired" | "setup" | "locked" | "unavailable">("loading");
  const [tab, setTab] = useState<Tab>("projects");
  const [projectView, setProjectView] = useState<ProjectView>({ kind: "home" });
  const [terminal, setTerminal] = useState<{ project: string; tab: TabRow } | null>(null);
  const [todoCard, setTodoCard] = useState<string | undefined>(undefined);
  /** Why the last attempt failed, shown on the `unavailable` splash. */
  const [unavailable, setUnavailable] = useState<{ reason: UnavailableReason; detail?: string }>({ reason: "unreachable" });
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  // Everything the tab bar navigates between, back at its starting point. Used
  // on every lock and on a dropped session, so a re-entry never lands on a
  // stale board or a detached terminal.
  const reset = useCallback(() => {
    setTab("projects");
    setProjectView({ kind: "home" });
    setTerminal(null);
    setTodoCard(undefined);
  }, []);
  const fail = useCallback((reason: UnavailableReason, detail?: string) => {
    setUnavailable({ reason, detail });
    setAuth("unavailable");
  }, []);

  const resume = useCallback(() => {
    setAuth("loading");
    void resumeAuth().then(async (result) => {
      if (result.kind === "paired") {
        rememberUnlockedSession();
        const restored = await restoreLastTab();
        reset();
        if (restored) {
          // Leaving the Projects tab pointed at the restored terminal's project
          // keeps its back chevron meaningful rather than dumping the reader on
          // the project list.
          setProjectView({ kind: "project", id: restored.projectId });
          setTerminal({ project: restored.projectId, tab: restored.tab });
        }
      } else if (result.kind === "unpaired") {
        forgetUnlockedSession();
        forgetLastTab();
      } else {
        fail(result.reason, result.detail);
        return;
      }
      setAuth(result.kind);
    }).catch((error: unknown) => fail(classifyUnavailable(error), unavailableDetail(error)));
  }, [reset, fail]);

  const begin = useCallback(() => {
    setAuth("loading");
    void Promise.all([hasPairedDevice(), hasLocalUnlock()]).then(([paired, locked]) => {
      if (!paired) {
        forgetUnlockedSession();
        forgetLastTab();
        setAuth("unpaired");
      } else if (locked && hasUnlockedSession()) {
        resume();
      } else {
        setAuth(locked ? "locked" : "setup");
      }
    // Both reads above are the phone's own key store, never the network, so a
    // rejection here is a blocked browser store rather than an absent host.
    }).catch(() => fail("storage_blocked"));
  }, [resume, fail]);
  useEffect(() => begin(), [begin]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (authRef.current !== "paired") return;
      forgetUnlockedSession();
      reset();
      setAuth("locked");
    });
    return () => setUnauthorizedHandler(undefined);
  }, [reset]);

  useEffect(() => {
    const lock = () => {
      if (authRef.current !== "paired") return;
      // Detach terminal UI and remove its opaque route. The server receives a
      // best-effort logout; the next local unlock always performs the signed
      // challenge login anew.
      forgetUnlockedSession();
      // The stored reference is an opaque, server-revalidated id, so it can
      // safely outlive the lock. Clearing it here made `restoreLastTab` dead on
      // a phone: backgrounding is the normal way to leave a PWA, so the tab was
      // always already forgotten by the time the user unlocked.
      reset();
      setAuth("locked");
      void logoutAuth().catch(() => undefined);
    };
    // What ends the session is a stretch with no one there, not the page being
    // hidden: a reload hides it, and so do the notification shade, the share
    // sheet and a glance at the clock — locking on each of those meant the PIN
    // or fingerprint came back after every refresh. Time since the last touch or
    // keystroke is the measure instead, which covers both the phone left face-up
    // until its own screen saver takes it and the app left behind in the
    // background. A reload is covered for free: the timer dies with the page, so
    // the deferred lock never runs and the restored session resumes.
    let lastActive = Date.now();
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // Re-armed against the wall clock rather than trusted to have slept the
        // right amount: a backgrounded page is throttled and then frozen
        // outright, so a fired timer proves nothing about elapsed time.
        if (Date.now() - lastActive >= LOCK_AFTER_IDLE_MS) lock();
        else arm();
      }, Math.max(1_000, LOCK_AFTER_IDLE_MS - (Date.now() - lastActive)));
    };
    const noteActivity = () => {
      const previous = lastActive;
      lastActive = Date.now();
      // A scroll is hundreds of events; re-arming on each would be hundreds of
      // timer resets a second. The deadline only has to move when it has drifted
      // far enough to matter — the timer above re-arms itself when it fires early.
      if (lastActive - previous >= 5_000) arm();
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActive >= LOCK_AFTER_IDLE_MS) lock();
      else arm();
    };
    arm();
    // Capture, so a handler that stops propagation cannot hide activity, and
    // passive, so none of this can delay a scroll.
    const options = { capture: true, passive: true } as const;
    for (const event of ACTIVITY_EVENTS) document.addEventListener(event, noteActivity, options);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) document.removeEventListener(event, noteActivity, options);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reset]);

  const openTerminal = (project: string, next: TabRow) => {
    rememberLastTab(project, next.id);
    setTerminal({ project, tab: next });
  };
  // A card named by an alert opens on the To-do tab; switching tabs by hand
  // clears it, so returning to the board later does not re-open the editor a
  // reader already closed.
  const openTodo = (card?: string) => { setTodoCard(card); setTab("todo"); };
  // Tapping the tab you are already on returns it to its root, the gesture every
  // phone tab bar answers to: back to the project list, or a fresh section with
  // its folder, month and filters cleared. `reseed` remounts the section, which
  // is also the only way to unwind Mail's own message → folder → accounts stack
  // from out here.
  const [reseed, setReseed] = useState(0);
  const openSection = (next: Tab) => {
    setTodoCard(undefined);
    if (next === tab) {
      if (next === "projects") setProjectView({ kind: "home" });
      else setReseed((seed) => seed + 1);
    }
    setTab(next);
  };
  if (auth === "loading") return <Splash message="Connecting to your workspace…" progress />;
  if (auth === "unavailable") {
    const { title, hint } = describeUnavailable(unavailable.reason);
    return (
      <Splash message={title} tone="error">
        <p className="splash-hint">{hint}</p>
        <p className="splash-hint muted">No project or terminal data is loaded from cache.</p>
        {unavailable.detail && <p className="splash-detail">{unavailable.detail}</p>}
        <button className="primary" onClick={begin}>Retry</button>
      </Splash>
    );
  }
  if (auth === "unpaired") return <Pair onDone={begin} />;
  if (auth === "setup") return <LocalUnlock setup onUnlocked={() => setAuth("locked")} />;
  if (auth === "locked") return <LocalUnlock setup={false} onUnlocked={resume} />;
  // A terminal is the one full-bleed screen: it owns every pixel it can get,
  // and the tab bar would sit on the keyboard toolbar besides.
  if (terminal) return <Terminal tab={terminal.tab} back={() => setTerminal(null)} />;
  return <div className="tabbed">
    {tab === "todo" ? <Todo key={reseed} card={todoCard} />
      : tab === "mail" ? <Mail key={reseed} />
        : tab === "calendar" ? <Calendar key={reseed} />
          : projectView.kind === "project"
            ? <Project id={projectView.id} back={() => setProjectView({ kind: "home" })} terminal={(row) => openTerminal(projectView.id, row)} />
            : <Home open={(id) => setProjectView({ kind: "project", id })} todo={openTodo} mail={() => setTab("mail")} />}
    <TabBar active={tab} open={openSection} />
  </div>;
}
