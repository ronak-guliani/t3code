import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";

export function removedThreadProject(input: {
  readonly route: ScopedThreadRef | null;
  readonly shell: EnvironmentThreadShell | null;
  readonly detail: EnvironmentThreadShell | null;
  readonly previous: EnvironmentThreadShell | null;
  readonly shellStatus: EnvironmentShellStatus;
}): ScopedProjectRef | null {
  const matchesRoute = (thread: EnvironmentThreadShell | null) =>
    thread !== null &&
    thread.id === input.route?.threadId &&
    thread.environmentId === input.route.environmentId;
  const archived =
    input.shell?.archivedAt != null
      ? input.shell
      : input.detail?.archivedAt != null
        ? input.detail
        : null;
  const removed = input.shellStatus === "live" && input.shell === null ? input.previous : null;
  const thread = matchesRoute(archived) ? archived : matchesRoute(removed) ? removed : null;
  return thread ? { environmentId: thread.environmentId, projectId: thread.projectId } : null;
}
