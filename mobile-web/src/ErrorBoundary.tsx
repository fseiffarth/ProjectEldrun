import React from "react";

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
