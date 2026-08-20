import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from './error-reporting';

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { error: Error | null };

/**
 * Stops a render-time throw from becoming a white screen.
 *
 * A map that renders 6,500 vehicles from a live feed has a wide surface for bad
 * data, and React unmounts the entire tree on an uncaught render error — so
 * without this, one malformed payload is a blank page with no way back short of
 * the user working out how to reload a WebView.
 *
 * A class because `componentDidCatch` has no hook equivalent; there is no
 * function-component way to write this.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(error, {
      source: 'render',
      detail: { componentStack: info.componentStack },
    });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-card panel">
          <h1>Something went wrong</h1>
          <p>
            The map stopped unexpectedly. Reloading usually clears it — the live feed is
            rebuilt from scratch on reconnect.
          </p>
          {/* The message, not the stack: it is occasionally meaningful to a user
              ("you are offline") and always useful in a bug report, while a
              minified stack is neither. */}
          <p className="error-boundary-detail">{error.message}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
