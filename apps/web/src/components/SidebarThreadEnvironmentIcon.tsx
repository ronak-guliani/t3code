import { ServerIcon } from "lucide-react";

export function SidebarThreadEnvironmentIcon({
  environmentLabel,
}: {
  readonly environmentLabel: string | null;
}) {
  return environmentLabel === null ? null : (
    <span
      role="img"
      aria-label={`Execution environment: ${environmentLabel}`}
      title={environmentLabel}
      className="inline-flex shrink-0 items-center text-muted-foreground/70"
    >
      <ServerIcon aria-hidden="true" className="size-3" />
    </span>
  );
}
