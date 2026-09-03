import React from "react";
import { forgetLastPlace } from "./lastPlace";

/**
 * A render error anywhere used to leave a permanently blank PWA that only a
 * force-quit could clear — there was no boundary at all, and the app root is
 * the one place a phone user cannot work around.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    // Both ways out of here remount the app from scratch, and the app resumes
    // at the saved place — which is the screen that just threw. With the place
    // kept, "Try again" and "Reload" were a loop back into the same crash; the
    // project list is the one landing that cannot be it.
    forgetLastPlace();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="screen splash">
        <p>Eldrun Mobile hit an unexpected error and stopped drawing this screen.</p>
        <button className="primary" onClick={() => this.setState({ failed: false })}>
          Try again
        </button>
        <button onClick={() => location.reload()}>Reload</button>
      </main>
    );
  }
}
