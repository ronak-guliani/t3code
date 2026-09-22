import type { PullRequestRef } from "@t3tools/contracts";

import type { RightPanelSurface } from "../../rightPanelStore";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";

export type PullRequestSurface = Extract<RightPanelSurface, { kind: "pull-request" }>;

export function selectActivePullRequestSurface(
  present: boolean,
  surfaces: readonly RightPanelSurface[],
  activeSurfaceId: string | null,
): PullRequestSurface | null {
  if (!present) return null;
  const surface = surfaces.find((candidate) => candidate.id === activeSurfaceId);
  return surface?.kind === "pull-request" ? surface : null;
}

export function PullRequestDetailSurface({
  present,
  surfaces,
  activeSurfaceId,
  onClose,
}: {
  readonly present: boolean;
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurfaceId: string | null;
  readonly onClose: (surface: PullRequestSurface) => void;
}) {
  const surface = selectActivePullRequestSurface(present, surfaces, activeSurfaceId);
  if (!surface) return null;

  const reference: PullRequestRef = surface.reference;
  return (
    <div className="min-h-0 flex-1">
      <PullRequestDetailPanel
        key={surface.id}
        environmentId={surface.environmentId}
        reference={reference}
        onClose={() => onClose(surface)}
      />
    </div>
  );
}
