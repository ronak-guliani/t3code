import { Component, type ReactNode } from "react";
import { View } from "react-native";

import { EmptyState } from "./EmptyState";
import { reportClientError } from "../lib/clientLogger";

interface RouteErrorBoundaryProps {
  readonly children: ReactNode;
  readonly routeName: string;
}

interface RouteErrorBoundaryState {
  readonly error: unknown;
  readonly routeName: string;
}

/**
 * Route-level error boundary: a render defect in any route must show a
 * recoverable fallback instead of freezing the UI until reload. The error
 * clears on navigation (tracked via routeName) so moving to another route
 * never shows a stale fallback, without remounting screens on every render.
 */
export class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { error: null, routeName: this.props.routeName };

  static getDerivedStateFromError(error: unknown): Partial<RouteErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: RouteErrorBoundaryProps,
    state: RouteErrorBoundaryState,
  ): Partial<RouteErrorBoundaryState> | null {
    if (props.routeName !== state.routeName) {
      return { error: null, routeName: props.routeName };
    }
    return null;
  }

  componentDidCatch(error: unknown): void {
    reportClientError(`[route-error-boundary] ${this.props.routeName} render failed`, error);
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <View className="flex-1 items-center justify-center bg-screen px-6">
          <EmptyState
            title="Something went wrong"
            detail="This screen hit an unexpected error. Your threads are safe — try again."
            actionLabel="Try again"
            onAction={this.retry}
          />
        </View>
      );
    }
    return this.props.children;
  }
}
