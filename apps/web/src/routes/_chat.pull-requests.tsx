import type { ProjectId, PullRequestInvolvement, PullRequestListState } from "@t3tools/contracts";
import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownUpIcon,
  CalendarArrowDownIcon,
  CalendarArrowUpIcon,
  ChevronDownIcon,
  GitPullRequestIcon,
  LayersIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  Minimize2Icon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { type ReactNode, useDeferredValue, useEffect, useMemo } from "react";

import { PullRequestDetailPanel } from "../components/pullRequest/PullRequestDetailPanel";
import { PullRequestFiltersMenu } from "../components/pullRequest/PullRequestFiltersMenu";
import { PullRequestRow } from "../components/pullRequest/PullRequestRow";
import { Button } from "../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../components/ui/menu";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { usePrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import {
  pullRequestInvalidateMutationOptions,
  pullRequestListInfiniteQueryOptions,
  pullRequestListStatsQueryOptions,
} from "../lib/pullRequestReactQuery";
import { findGitHubPullRequestProject } from "../lib/openPullRequestLink";
import { cn } from "../lib/utils";
import { useSettings } from "../hooks/useSettings";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import type { Project } from "../types";

export interface PullRequestsSearch {
  readonly state?: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly sort?: PullRequestListSort;
  readonly projectId?: ProjectId;
  readonly q?: string;
  readonly host?: string;
  readonly repository?: string;
  readonly number?: number;
  readonly selectedProjectId?: ProjectId;
}
type PullRequestsSearchPatch = {
  readonly [Key in keyof PullRequestsSearch]?: PullRequestsSearch[Key] | undefined;
};

const LIST_STATES = ["all", "open", "closed", "merged"] as const;
const INVOLVEMENTS = ["all", "reviewing", "authored"] as const;
const SORT_OPTIONS = [
  { value: "ready", label: "Merge readiness", Icon: LayersIcon },
  { value: "updated", label: "Recently updated", Icon: RefreshCwIcon },
  { value: "newest", label: "Newest shown", Icon: CalendarArrowDownIcon },
  { value: "oldest", label: "Oldest shown", Icon: CalendarArrowUpIcon },
  { value: "largest", label: "Largest shown", Icon: Maximize2Icon },
  { value: "smallest", label: "Smallest shown", Icon: Minimize2Icon },
] as const;
type PullRequestListSort = (typeof SORT_OPTIONS)[number]["value"];
const INVOLVEMENT_LABELS: Record<(typeof INVOLVEMENTS)[number], string> = {
  all: "All involvement",
  reviewing: "Reviewing",
  authored: "Authored",
};
const PAGE_SIZE = 50;
const STATS_BATCH_SIZE = 500;
const EMPTY_PROJECTS: readonly Project[] = [];

function isListState(value: unknown): value is PullRequestListState {
  return typeof value === "string" && (LIST_STATES as readonly string[]).includes(value);
}

function isInvolvement(value: unknown): value is PullRequestInvolvement {
  return typeof value === "string" && (INVOLVEMENTS as readonly string[]).includes(value);
}

function isPullRequestListSort(value: unknown): value is PullRequestListSort {
  return SORT_OPTIONS.some((option) => option.value === value);
}

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (search: Record<string, unknown>): PullRequestsSearch => ({
    ...(isListState(search.state) ? { state: search.state } : {}),
    involvement: isInvolvement(search.involvement) ? search.involvement : "all",
    ...(isPullRequestListSort(search.sort) ? { sort: search.sort } : {}),
    ...(typeof search.projectId === "string" && search.projectId
      ? { projectId: search.projectId as ProjectId }
      : {}),
    ...(typeof search.q === "string" && search.q.trim() ? { q: search.q.slice(0, 200) } : {}),
    ...(typeof search.host === "string" && search.host ? { host: search.host.slice(0, 300) } : {}),
    ...(typeof search.repository === "string" && search.repository
      ? { repository: search.repository.slice(0, 300) }
      : {}),
    ...(typeof search.number === "number" &&
    Number.isSafeInteger(search.number) &&
    search.number > 0
      ? { number: search.number }
      : {}),
    ...(typeof search.selectedProjectId === "string" && search.selectedProjectId
      ? { selectedProjectId: search.selectedProjectId as ProjectId }
      : {}),
  }),
  component: PullRequestsRoute,
});

function PullRequestsRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const environmentId = usePrimaryEnvironmentId();
  const descriptor = usePrimaryEnvironmentDescriptor();
  const queryClient = useQueryClient();
  const allProjects = useStore(selectProjectsAcrossEnvironments);
  const projects = useMemo(
    () =>
      environmentId
        ? allProjects.filter((project) => project.environmentId === environmentId)
        : EMPTY_PROJECTS,
    [allProjects, environmentId],
  );
  const supported = descriptor?.capabilities.pullRequests === true;
  const defaultListState = useSettings((s) => s.pullRequestsDefaultState);
  const effectiveState = search.state ?? defaultListState;
  const sort = search.sort ?? "ready";
  const deferredQuery = useDeferredValue(search.q ?? "");
  const listQuery = useInfiniteQuery(
    pullRequestListInfiniteQueryOptions({
      environmentId: supported ? environmentId : null,
      request: {
        state: effectiveState,
        involvement: search.involvement,
        limit: PAGE_SIZE,
        ...(search.projectId ? { projectId: search.projectId } : {}),
        ...(deferredQuery.trim() ? { query: deferredQuery.trim() } : {}),
      },
    }),
  );
  const entries = useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.entries) ?? [],
    [listQuery.data?.pages],
  );
  const statReferenceBatches = useMemo(
    () =>
      Array.from({ length: Math.ceil(entries.length / STATS_BATCH_SIZE) }, (_, index) =>
        entries
          .slice(index * STATS_BATCH_SIZE, (index + 1) * STATS_BATCH_SIZE)
          .map(({ projectId, repository, number }) => ({ projectId, repository, number })),
      ),
    [entries],
  );
  const statsQueries = useQueries({
    queries: statReferenceBatches.map((refs) =>
      pullRequestListStatsQueryOptions({
        environmentId: supported ? environmentId : null,
        request: { refs },
      }),
    ),
  });
  const invalidateMutation = useMutation(
    pullRequestInvalidateMutationOptions({
      environmentId: supported ? environmentId : null,
      queryClient,
    }),
  );
  const entriesWithStats = useMemo(() => {
    const stats = new Map(
      statsQueries.flatMap((query) =>
        (query.data?.stats ?? []).map((stat) => [
          `${stat.projectId}:${stat.repository}#${stat.number}`,
          stat,
        ]),
      ),
    );
    return entries.map((entry) => {
      const stat = stats.get(`${entry.projectId}:${entry.repository}#${entry.number}`);
      return stat && entry.additions === 0 && entry.deletions === 0 ? { ...entry, ...stat } : entry;
    });
  }, [entries, statsQueries]);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  /**
   * The list only narrows by title/repository client-side for display; a row
   * whose match came from elsewhere (description, comments) says so on the
   * row rather than reading as a random result.
   */
  const matchRowElsewhere = (entry: { readonly title: string; readonly repository: string }) => {
    if (!normalizedQuery) return false;
    return (
      !entry.title.toLowerCase().includes(normalizedQuery) &&
      !entry.repository.toLowerCase().includes(normalizedQuery)
    );
  };
  const sortedEntries = useMemo(() => {
    if (sort === "ready") return entriesWithStats;
    return entriesWithStats.toSorted((left, right) => {
      if (sort === "updated") return right.updatedAt.localeCompare(left.updatedAt);
      if (sort === "newest") return right.createdAt.localeCompare(left.createdAt);
      if (sort === "oldest") return left.createdAt.localeCompare(right.createdAt);
      const leftSize = left.additions + left.deletions;
      const rightSize = right.additions + right.deletions;
      return sort === "largest" ? rightSize - leftSize : leftSize - rightSize;
    });
  }, [entriesWithStats, sort]);
  const reviewRequestedEntries = useMemo(
    () => sortedEntries.filter((entry) => entry.viewerReviewRequested),
    [sortedEntries],
  );
  const otherEntries = useMemo(
    () => sortedEntries.filter((entry) => !entry.viewerReviewRequested),
    [sortedEntries],
  );
  const explicitSelection = useMemo(
    () =>
      search.repository && search.number && search.selectedProjectId
        ? {
            projectId: search.selectedProjectId,
            repository: search.repository,
            number: search.number,
          }
        : null,
    [search.number, search.repository, search.selectedProjectId],
  );
  const inferredSelection = useMemo(() => {
    const repository = search.repository;
    const number = search.number;
    if (explicitSelection || !repository || !number) {
      return null;
    }
    const project = findGitHubPullRequestProject(projects, {
      environmentId,
      host: search.host,
      repository,
    });
    return project ? { projectId: project.id, repository, number } : null;
  }, [environmentId, explicitSelection, projects, search.host, search.number, search.repository]);
  const selected = explicitSelection ?? inferredSelection;
  const updateSearch = (patch: PullRequestsSearchPatch, clearSelection = false) => {
    void navigate({
      search: (previous: PullRequestsSearch) => {
        const next = { ...previous, ...patch };
        return {
          ...(next.state ? { state: next.state } : {}),
          involvement: next.involvement ?? "all",
          ...(next.sort && next.sort !== "ready" ? { sort: next.sort } : {}),
          ...(next.projectId ? { projectId: next.projectId } : {}),
          ...(next.q ? { q: next.q } : {}),
          ...(!clearSelection && next.repository && next.number && next.selectedProjectId
            ? {
                ...(next.host ? { host: next.host } : {}),
                repository: next.repository,
                number: next.number,
                selectedProjectId: next.selectedProjectId,
              }
            : {}),
        };
      },
      replace: true,
    });
  };
  useEffect(() => {
    if (!inferredSelection || search.selectedProjectId) return;
    void navigate({
      search: (previous: PullRequestsSearch) => ({
        ...previous,
        repository: inferredSelection.repository,
        number: inferredSelection.number,
        selectedProjectId: inferredSelection.projectId,
      }),
      replace: true,
    });
  }, [inferredSelection, navigate, search.selectedProjectId]);
  const errors = listQuery.data?.pages.flatMap((page) => page.errors) ?? [];

  if (!descriptor) {
    return (
      <Surface>
        <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" /> Loading environment…
        </div>
      </Surface>
    );
  }

  if (!supported) {
    return (
      <Surface>
        <EmptyState
          title="Pull requests are unavailable"
          description="This environment does not advertise GitHub pull request support."
        />
      </Surface>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-2 border-b border-border px-3">
          <SidebarTrigger className="size-7" />
          <h1 className="text-sm font-semibold">Pull Requests</h1>
        </header>
        <div
          className={cn(
            "min-h-0 flex-1",
            selected
              ? "grid grid-cols-1 lg:grid-cols-[minmax(20rem,0.9fr)_minmax(28rem,1.1fr)]"
              : "flex flex-col",
          )}
        >
          <section
            className={cn(
              "flex min-h-0 flex-col",
              selected ? "border-r border-border max-lg:hidden" : "w-full",
            )}
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-7 pb-4 sm:px-8">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <InputGroup className="min-w-0 flex-1">
                  <InputGroupAddon>
                    {listQuery.isFetching && !listQuery.isFetchingNextPage ? (
                      <Spinner aria-hidden />
                    ) : (
                      <SearchIcon aria-hidden />
                    )}
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    aria-label="Search pull requests"
                    autoComplete="off"
                    name="pull-request-search"
                    placeholder="Search pull requests, or label:bug"
                    value={search.q ?? ""}
                    onChange={(event) =>
                      updateSearch({ q: event.currentTarget.value || undefined }, true)
                    }
                  />
                </InputGroup>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button aria-label="Sort pull requests" size="default" variant="outline" />
                    }
                  >
                    <ArrowDownUpIcon aria-hidden />
                    <span>Sort</span>
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuRadioGroup
                      value={sort}
                      onValueChange={(value) =>
                        updateSearch({ sort: value as PullRequestListSort }, true)
                      }
                    >
                      {SORT_OPTIONS.map(({ value, label, Icon }) => (
                        <MenuRadioItem key={value} value={value}>
                          <Icon aria-hidden />
                          {label}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>
                <PullRequestFiltersMenu
                  defaultListState={defaultListState}
                  effectiveState={effectiveState}
                  involvement={search.involvement}
                  projectId={search.projectId}
                  projects={projects}
                  onStateChange={(value) => updateSearch({ state: value }, true)}
                  onInvolvementChange={(value) => updateSearch({ involvement: value }, true)}
                  onProjectChange={(value) => updateSearch({ projectId: value }, true)}
                />
                <Menu>
                  <MenuTrigger
                    render={
                      <Button aria-label="Filter by involvement" size="default" variant="outline" />
                    }
                  >
                    <LayersIcon aria-hidden />
                    <span>
                      {INVOLVEMENT_LABELS[search.involvement].replace(" involvement", "")}
                    </span>
                    <ChevronDownIcon aria-hidden />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuRadioGroup
                      value={search.involvement}
                      onValueChange={(value) =>
                        updateSearch({ involvement: value as PullRequestInvolvement }, true)
                      }
                    >
                      {INVOLVEMENTS.map((involvement) => (
                        <MenuRadioItem key={involvement} value={involvement}>
                          {INVOLVEMENT_LABELS[involvement]}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>
                <Button
                  aria-label="Refresh pull requests"
                  disabled={listQuery.isFetching || invalidateMutation.isPending}
                  size="icon"
                  variant="outline"
                  onClick={() => void invalidateMutation.mutateAsync({})}
                >
                  <RefreshCwIcon
                    className={cn(
                      (listQuery.isFetching || invalidateMutation.isPending) && "animate-spin",
                    )}
                  />
                </Button>
              </div>
              <p aria-live="polite" className="sr-only">
                {entriesWithStats.length} pull request{entriesWithStats.length === 1 ? "" : "s"}
                {listQuery.hasNextPage ? ", more available" : ""}
                {listQuery.isFetching && !listQuery.isFetchingNextPage ? ", updating" : ""}
              </p>
              <div className="mt-4">
                {listQuery.isPending ? (
                  <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                    <LoaderCircleIcon className="size-4 animate-spin" /> Loading pull requests…
                  </div>
                ) : null}
                {listQuery.error ? (
                  <EmptyState
                    title="Could not load pull requests"
                    description={
                      listQuery.error instanceof Error
                        ? listQuery.error.message
                        : "Please try again."
                    }
                    action={
                      <Button size="sm" variant="outline" onClick={() => void listQuery.refetch()}>
                        Retry
                      </Button>
                    }
                  />
                ) : null}
                {!listQuery.isPending && !listQuery.error && entriesWithStats.length === 0 ? (
                  <EmptyState
                    title="No pull requests"
                    description={
                      search.q
                        ? "Nothing matches this search."
                        : "No pull requests match these filters."
                    }
                    action={
                      search.q ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => updateSearch({ q: undefined }, true)}
                        >
                          Clear search
                        </Button>
                      ) : undefined
                    }
                  />
                ) : null}
                {reviewRequestedEntries.length > 0 ? (
                  <h2 className="px-3 pb-1 text-xs font-medium text-muted-foreground/70">
                    Awaiting your review
                  </h2>
                ) : null}
                {reviewRequestedEntries.map((entry) => (
                  <PullRequestRow
                    entry={entry}
                    key={`${entry.projectId}:${entry.repository}#${entry.number}`}
                    matchedElsewhere={matchRowElsewhere(entry)}
                    selected={
                      selected?.projectId === entry.projectId &&
                      selected.repository === entry.repository &&
                      selected.number === entry.number
                    }
                    onSelect={(next) =>
                      updateSearch({
                        repository: next.repository,
                        number: next.number,
                        selectedProjectId: next.projectId,
                      })
                    }
                  />
                ))}
                {otherEntries.length > 0 ? (
                  <h2
                    className={cn(
                      "px-3 pb-1 text-xs font-medium text-muted-foreground/70",
                      reviewRequestedEntries.length > 0 && "pt-3",
                    )}
                  >
                    Others
                  </h2>
                ) : null}
                {otherEntries.map((entry) => (
                  <PullRequestRow
                    entry={entry}
                    key={`${entry.projectId}:${entry.repository}#${entry.number}`}
                    matchedElsewhere={matchRowElsewhere(entry)}
                    selected={
                      selected?.projectId === entry.projectId &&
                      selected.repository === entry.repository &&
                      selected.number === entry.number
                    }
                    onSelect={(next) =>
                      updateSearch({
                        repository: next.repository,
                        number: next.number,
                        selectedProjectId: next.projectId,
                      })
                    }
                  />
                ))}
                {listQuery.hasNextPage ? (
                  <div className="flex justify-center p-3">
                    <Button
                      disabled={listQuery.isFetchingNextPage}
                      size="sm"
                      variant="outline"
                      onClick={() => void listQuery.fetchNextPage()}
                    >
                      {listQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                    </Button>
                  </div>
                ) : null}
                {errors.length > 0 ? (
                  <ul className="space-y-1 p-3 text-xs text-muted-foreground">
                    {errors.map((error) => (
                      <li key={error.projectId} className="break-words">
                        <span className="font-medium text-foreground">{error.projectTitle}:</span>{" "}
                        {error.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          </section>
          {selected ? (
            <section className="min-h-0">
              <PullRequestDetailPanel
                environmentId={environmentId!}
                key={`${selected.projectId}:${selected.repository}#${selected.number}`}
                reference={selected}
                onClose={() => updateSearch({}, true)}
              />
            </section>
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
}

function Surface({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 bg-background text-foreground">{children}</SidebarInset>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 p-6 text-center">
      <GitPullRequestIcon className="size-7 text-muted-foreground" />
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}
