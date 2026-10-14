/**
 * The last line of defence: a screen that fails to render is replaced by a plain screen that says so and offers a
 * restart, instead of a blank app. Nothing of the error is shown or logged beyond its class (no content in logs).
 * From S4 this screen also carries the help area, which must never depend on the rest of the UI.
 */
import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode; text: { title: string; restart: string } }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn(`screen failed: ${error instanceof Error ? error.name : 'error'}`);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="page" role="alert">
        <h1>{this.props.text.title}</h1>
        <button type="button" className="button primary" onClick={() => location.reload()}>
          {this.props.text.restart}
        </button>
      </main>
    );
  }
}
