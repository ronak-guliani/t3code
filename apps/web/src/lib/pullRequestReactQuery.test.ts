import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EnvironmentId, ProjectId, ThreadId, type PullRequestListResult } from "@t3tools/contracts";

import * as environmentApi from "../environmentApi";
import {
  prefetchPullRequestDetail,
  pullRequestDiffInfiniteQueryOptions,
  pullRequestListQueryOptions,
  pullRequestListInfiniteQueryOptions,
  pullRequestMutationKeys,
  pullRequestQueryKeys,
} from "./pullRequestReactQuery";

const ENVIRONMENT_ID = EnvironmentId.make("environment-a");
const PROJECT_ID = ProjectId.make("project-a");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pullRequestReactQuery", () => {
  it("scopes list keys by environment and filters", () => {
    expect(
      pullRequestQueryKeys.list(ENVIRONMENT_ID, {
        state: "open",
        projectId: PROJECT_ID,
      }),
    ).not.toEqual(
      pullRequestQueryKeys.list(ENVIRONMENT_ID, {
        state: "closed",
        projectId: PROJECT_ID,
      }),
    );
  });

  it("does not put continuation cursors in the infinite query key", () => {
    const options = pullRequestListInfiniteQueryOptions({
      environmentId: ENVIRONMENT_ID,
      request: { state: "open", projectId: PROJECT_ID },
    });

    expect(options.queryKey).toEqual(
      pullRequestQueryKeys.list(ENVIRONMENT_ID, { state: "open", projectId: PROJECT_ID }),
    );
  });

  it("stops a cursorless truncated listing", () => {
    const options = pullRequestListInfiniteQueryOptions({
      environmentId: ENVIRONMENT_ID,
      request: { state: "open", projectId: PROJECT_ID },
    });
    const page = {
      viewers: {},
      providers: [],
      entries: [],
      errors: [],
      truncated: true,
      nextCursors: {},
    } satisfies PullRequestListResult;

    expect(options.getNextPageParam(page, [page], null, [null])).toBeUndefined();
  });

  it("resolves the first page without fetching its continuation", async () => {
    const request = { state: "open", projectId: PROJECT_ID, limit: 50 } as const;
    const firstPage = {
      viewers: {},
      providers: [],
      entries: [],
      errors: [],
      truncated: true,
      nextCursors: { "github.com acme/web": "cursor-2" },
    } satisfies PullRequestListResult;
    const list = vi.fn().mockResolvedValue(firstPage);
    vi.spyOn(environmentApi, "ensureEnvironmentApi").mockReturnValue({
      pullRequests: { list },
    } as never);

    const result = await new QueryClient().fetchQuery(
      pullRequestListQueryOptions({
        environmentId: ENVIRONMENT_ID,
        request,
      }),
    );

    expect(result).toBe(firstPage);
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith(request);
  });

  it("passes returned cursors only when loading a continuation", async () => {
    const request = { state: "open", projectId: PROJECT_ID, limit: 50 } as const;
    const firstPage = {
      viewers: {},
      providers: [],
      entries: [],
      errors: [],
      truncated: true,
      nextCursors: { "github.com acme/web": "cursor-2" },
    } satisfies PullRequestListResult;
    const secondPage = {
      ...firstPage,
      truncated: false,
      nextCursors: {},
    } satisfies PullRequestListResult;
    const list = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
    vi.spyOn(environmentApi, "ensureEnvironmentApi").mockReturnValue({
      pullRequests: { list },
    } as never);
    const queryClient = new QueryClient();

    await queryClient.fetchQuery(
      pullRequestListQueryOptions({
        environmentId: ENVIRONMENT_ID,
        request,
      }),
    );
    await queryClient.fetchQuery(
      pullRequestListQueryOptions({
        environmentId: ENVIRONMENT_ID,
        request: { ...request, cursors: firstPage.nextCursors },
      }),
    );

    expect(list).toHaveBeenNthCalledWith(1, request);
    expect(list).toHaveBeenNthCalledWith(2, {
      ...request,
      cursors: firstPage.nextCursors,
    });
  });

  it("does not put diff continuation cursors in the infinite query key", () => {
    const options = pullRequestDiffInfiniteQueryOptions({
      environmentId: ENVIRONMENT_ID,
      request: {
        projectId: PROJECT_ID,
        repository: "t3tools/t3code",
        number: 42,
      },
    });

    expect(options.queryKey).toEqual(
      pullRequestQueryKeys.diffInfinite(ENVIRONMENT_ID, {
        projectId: PROJECT_ID,
        repository: "t3tools/t3code",
        number: 42,
      }),
    );
  });

  it("scopes mutation keys by environment", () => {
    expect(pullRequestMutationKeys.comment(ENVIRONMENT_ID)).not.toEqual(
      pullRequestMutationKeys.comment(null),
    );
  });

  it("scopes collaborative acceptance lookups by thread and pull request", () => {
    const reference = { projectId: PROJECT_ID, repository: "acme/web", number: 42 };

    expect(
      pullRequestQueryKeys.collaborativeAcceptanceLookup(
        ENVIRONMENT_ID,
        ThreadId.make("thread-a"),
        reference,
      ),
    ).not.toEqual(
      pullRequestQueryKeys.collaborativeAcceptanceLookup(
        ENVIRONMENT_ID,
        ThreadId.make("thread-b"),
        reference,
      ),
    );
  });

  it("prefetches the detail a hovered row is about to open", async () => {
    const queryClient = new QueryClient();
    const prefetch = vi
      .spyOn(queryClient, "prefetchQuery")
      .mockImplementation(() => Promise.resolve());
    const reference = { projectId: PROJECT_ID, repository: "acme/web", number: 42 };

    await prefetchPullRequestDetail(queryClient, {
      environmentId: ENVIRONMENT_ID,
      reference,
    });

    expect(prefetch).toHaveBeenCalledOnce();
    expect(prefetch.mock.calls[0]?.[0]).toMatchObject({
      queryKey: pullRequestQueryKeys.detail(ENVIRONMENT_ID, reference),
    });
    prefetch.mockRestore();
  });

  it("prefetches nothing without an environment", async () => {
    const queryClient = new QueryClient();
    const prefetch = vi
      .spyOn(queryClient, "prefetchQuery")
      .mockImplementation(() => Promise.resolve());

    await prefetchPullRequestDetail(queryClient, {
      environmentId: null,
      reference: { projectId: PROJECT_ID, repository: "acme/web", number: 42 },
    });

    expect(prefetch).not.toHaveBeenCalled();
    prefetch.mockRestore();
  });
});
