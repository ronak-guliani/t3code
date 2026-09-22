import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import React, { lazy, Suspense, type ReactNode } from "react";

type PullRequestDetailPanelModule = {
  readonly default: typeof import("./PullRequestDetailPanel").PullRequestDetailPanel;
};

let pullRequestDetailPanelPromise: Promise<PullRequestDetailPanelModule> | undefined;

function loadPullRequestDetailPanel(): Promise<PullRequestDetailPanelModule> {
  return (pullRequestDetailPanelPromise ??= import("./PullRequestDetailPanel").then(
    ({ PullRequestDetailPanel }) => ({ default: PullRequestDetailPanel }),
  ));
}

const LazyPullRequestDetailPanel = lazy(loadPullRequestDetailPanel);

export function preloadPullRequestDetailPanel(): Promise<void> {
  return loadPullRequestDetailPanel().then(() => undefined);
}

class PullRequestDetailPanelErrorBoundary extends React.Component<
  { readonly children: ReactNode },
  { readonly error: unknown }
> {
  override state: { readonly error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { readonly error: unknown } {
    return { error };
  }

  override render() {
    if (this.state.error !== null) {
      const message =
        this.state.error instanceof Error
          ? this.state.error.message
          : "The detail module could not be loaded.";
      return (
        <div role="alert" className="flex min-h-0 flex-1 flex-col gap-2 p-4 text-sm">
          <p className="font-medium text-destructive">Could not load pull request details.</p>
          <p className="text-muted-foreground">{message}</p>
        </div>
      );
    }

    return this.props.children;
  }
}

export function PullRequestDetailPanelBoundary({
  environmentId,
  reference,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly onClose: () => void;
}) {
  return (
    <PullRequestDetailPanelErrorBoundary>
      <Suspense
        fallback={
          <div role="status" className="p-4 text-sm text-muted-foreground">
            Loading pull request details…
          </div>
        }
      >
        <LazyPullRequestDetailPanel
          environmentId={environmentId}
          reference={reference}
          onClose={onClose}
        />
      </Suspense>
    </PullRequestDetailPanelErrorBoundary>
  );
}
