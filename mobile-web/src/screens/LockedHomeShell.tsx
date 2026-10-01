import { BUNDLE_VERSION } from "../buildInfo";
import { EldrunMark } from "../EldrunMark";
import { BRAND } from "../../../src/lib/brand";

/**
 * Home's own header, drawn behind the lock sheet while the app is locked.
 * The local lock precedes the desktop re-login (`App`'s `resume()`), so no
 * project or alert data may be fetched yet — this is a static echo of Home's
 * chrome, not the interactive screen, which mounts fresh once unlocked.
 */
export function LockedHomeShell() {
  return <main className="screen home-screen" aria-hidden="true">
    <header className="home-header">
      <div className="home-brand" aria-label={BRAND.display}>
        <span className="home-logo-frame" aria-hidden="true"><EldrunMark className="home-logo" /></span>
        <span className="home-brand-copy"><strong>{BRAND.display}</strong><small>{BUNDLE_VERSION}</small></span>
      </div>
    </header>
    <div className="projects-row"><h1>Projects</h1></div>
  </main>;
}
