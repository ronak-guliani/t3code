import { useAtomValue } from "@effect/atom-react";
import {
  createArchivedThreadsManager,
  makeArchivedThreadsEnvironmentKey,
  readArchivedThreadsSnapshotState,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { readEnvironmentConnection } from "./environments/runtime";
import { appAtomRegistry } from "./rpc/atomRegistry";

const archivedThreadsManager = createArchivedThreadsManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const connection = readEnvironmentConnection(environmentId);
    return connection
      ? {
          getArchivedShellSnapshot: connection.client.orchestration.getArchivedShellSnapshot,
        }
      : null;
  },
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  archivedThreadsManager.refreshForEnvironment(environmentId);
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>) {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const result = useAtomValue(archivedThreadsManager.getAtom(environmentKey));
  const refresh = useCallback(() => {
    archivedThreadsManager.refresh(environmentIds);
  }, [environmentIds]);

  return {
    ...readArchivedThreadsSnapshotState(result),
    refresh,
  };
}
