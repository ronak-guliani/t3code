import { EnvironmentId, type PullRequestRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RightPanelSurface } from "../../rightPanelStore";

const lifecycle = vi.hoisted(() => ({
  mounted: [] as number[],
  unmounted: [] as number[],
}));

vi.mock("./PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: ({ reference }: { reference: PullRequestRef }) => {
    useEffect(() => {
      lifecycle.mounted.push(reference.number);
      return () => {
        lifecycle.unmounted.push(reference.number);
      };
    }, [reference.number]);
    return <div data-pull-request-number={reference.number} />;
  },
}));

import { PullRequestDetailSurface } from "./PullRequestDetailSurface";

const environmentId = EnvironmentId.make("environment-test");
const firstSurface: RightPanelSurface = {
  id: "pull-request:environment-test:project-a:owner/repo:12",
  kind: "pull-request",
  environmentId,
  reference: { projectId: "project-a" as never, repository: "owner/repo", number: 12 },
};
const secondSurface: RightPanelSurface = {
  id: "pull-request:environment-test:project-a:owner/repo:13",
  kind: "pull-request",
  environmentId,
  reference: { projectId: "project-a" as never, repository: "owner/repo", number: 13 },
};

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  lifecycle.mounted.length = 0;
  lifecycle.unmounted.length = 0;
  vi.unstubAllGlobals();
});

describe("PullRequestDetailSurface", () => {
  it("mounts only the active detail and releases it when the panel is hidden", () => {
    act(() => {
      renderer = create(
        <PullRequestDetailSurface
          present
          surfaces={[firstSurface, secondSurface]}
          activeSurfaceId={firstSurface.id}
          onClose={vi.fn()}
        />,
      );
    });

    expect(lifecycle.mounted).toEqual([12]);
    expect(renderer?.root.findAllByProps({ "data-pull-request-number": 12 })).toHaveLength(1);
    expect(renderer?.root.findAllByProps({ "data-pull-request-number": 13 })).toHaveLength(0);

    act(() => {
      renderer?.update(
        <PullRequestDetailSurface
          present
          surfaces={[firstSurface, secondSurface]}
          activeSurfaceId={secondSurface.id}
          onClose={vi.fn()}
        />,
      );
    });

    expect(lifecycle.mounted).toEqual([12, 13]);
    expect(lifecycle.unmounted).toEqual([12]);
    expect(renderer?.root.findAllByProps({ "data-pull-request-number": 12 })).toHaveLength(0);
    expect(renderer?.root.findAllByProps({ "data-pull-request-number": 13 })).toHaveLength(1);

    act(() => {
      renderer?.update(
        <PullRequestDetailSurface
          present={false}
          surfaces={[firstSurface, secondSurface]}
          activeSurfaceId={secondSurface.id}
          onClose={vi.fn()}
        />,
      );
    });

    expect(renderer?.toJSON()).toBeNull();
    expect(lifecycle.unmounted).toEqual([12, 13]);
  });
});
