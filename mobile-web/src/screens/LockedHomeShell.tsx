import { formatBuildStamp } from "../buildInfo";
// Kept in lockstep with Home's own build line (`Home.tsx`); the same reason
// applies here too.
import { version as APP_VERSION } from "../../../package.json";
import { EldrunMark } from "../EldrunMark";

const BUILD_STAMP = formatBuildStamp();

/**
 * Home's own header, drawn behind the lock sheet while the app is locked.
 * The local lock precedes the desktop re-login (`App`'s `resume()`), so no
 * project or alert data may be fetched yet — this is a static echo of Home's
 * chrome, not the interactive screen, which mounts fresh once unlocked.
 */
export function LockedHomeShell() {
  return <main className="screen home-screen" aria-hidden="true">
    <header className="home-header">
      <div className="home-brand" aria-label="Eldrun">
        <span className="home-logo-frame" aria-hidden="true"><EldrunMark className="home-logo" /></span>
        <span className="home-brand-copy"><strong>Eldrun</strong><small>v{APP_VERSION}{BUILD_STAMP && ` · ${BUILD_STAMP}`}</small></span>
      </div>
    </header>
    <div className="projects-row"><h1>Projects</h1></div>
  </main>;
}
