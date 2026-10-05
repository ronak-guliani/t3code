import type {
  EnvironmentId,
  StorageCleanupPlan,
  StorageCleanupResult,
  StorageExecuteCleanupInput,
  StorageGetUsageInput,
  StorageUsageSnapshot,
} from "@t3tools/contracts";
import { mutationOptions, type QueryClient, queryOptions } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "../environmentApi";

const POLL_WHILE_BUSY_MS = 1_000;

export const storageQueryKeys = {
  usage: (environmentId: EnvironmentId | null) => ["storage", environmentId, "usage"] as const,
};

function requireStorageApi(environmentId: EnvironmentId | null) {
  if (!environmentId) throw new Error("Storage cleanup is unavailable.");
  return ensureEnvironmentApi(environmentId).storage;
}

/** Usage is measured in a server background job; poll while it or a reset runs. */
export function storageUsageQueryOptions(environmentId: EnvironmentId | null) {
  return queryOptions<StorageUsageSnapshot>({
    queryKey: storageQueryKeys.usage(environmentId),
    queryFn: () => requireStorageApi(environmentId).getUsage({}),
    enabled: environmentId !== null,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === "measuring" || data?.cleanup?.status === "running"
        ? POLL_WHILE_BUSY_MS
        : false;
    },
  });
}

export function storageUsageMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationFn: (request: StorageGetUsageInput) =>
      requireStorageApi(input.environmentId).getUsage(request),
    onSuccess: (snapshot) =>
      input.queryClient.setQueryData(storageQueryKeys.usage(input.environmentId), snapshot),
  });
}

export function storagePreviewCleanupMutationOptions(environmentId: EnvironmentId | null) {
  return mutationOptions<StorageCleanupPlan, Error, void>({
    mutationFn: () => requireStorageApi(environmentId).previewCleanup({}),
  });
}

export function storageExecuteCleanupMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly queryClient: QueryClient;
}) {
  return mutationOptions<StorageCleanupResult, Error, StorageExecuteCleanupInput>({
    mutationFn: (request) => requireStorageApi(input.environmentId).executeCleanup(request),
    onSettled: () =>
      input.queryClient.invalidateQueries({
        queryKey: storageQueryKeys.usage(input.environmentId),
      }),
  });
}
