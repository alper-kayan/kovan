import { Component, type ReactNode } from 'react';
import { api } from '../services/api';

interface State {
  error: Error | null;
}

/** Keeps one broken screen from blanking the whole app, and reports what happened. */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    void api.invoke(
      'brain:reportError',
      `${this.props.label}: ${error.message}`,
      error.stack ?? null,
    );
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <div className="empty-title">{this.props.label} hit a problem</div>
        <p className="empty-text mono">{this.state.error.message}</p>
        <button className="btn btn-sm" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
