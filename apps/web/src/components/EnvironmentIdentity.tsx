import type { EnvironmentId } from "@t3tools/contracts";
import { ServerIcon } from "lucide-react";
import { memo } from "react";
import { useEnvironment } from "../state/environments";

export const EnvironmentIdentity = memo(function EnvironmentIdentity({
  environmentId,
  compact = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly compact?: boolean;
}) {
  const environment = useEnvironment(environmentId);
  return (
    <span
      className={`inline-flex min-w-0 max-w-48 items-center gap-1 truncate text-xs text-muted-foreground ${compact ? "shrink-0" : ""}`}
      title={`Execution environment: ${environment?.label ?? "Unavailable"}\n${environmentId}\nThreads belong to this environment, not to the client viewing them.`}
      aria-label={`Execution environment: ${environment?.label ?? environmentId}`}
    >
      <ServerIcon className="size-3 shrink-0" />
      {!compact ? <span className="truncate">{environment?.label ?? environmentId}</span> : null}
      <span className="shrink-0 font-mono text-[10px]">
        {compact ? "" : "· "}
        {environmentId.slice(0, 6)}
      </span>
    </span>
  );
});
