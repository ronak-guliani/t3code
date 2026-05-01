import type { TurnDiffScope } from "@t3tools/contracts";
import { GitCommitVerticalIcon, LayersIcon } from "lucide-react";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

interface DiffScopeToggleProps {
  value: TurnDiffScope;
  onChange: (scope: TurnDiffScope) => void;
  className?: string;
}

/** Compact icon-based toggle for switching between turn-only and snapshot diff scopes. */
export function DiffScopeToggle({ value, onChange, className }: DiffScopeToggleProps) {
  return (
    <ToggleGroup
      className={className}
      variant="outline"
      size="xs"
      value={[value]}
      onValueChange={(next) => {
        const scope = next[0];
        if (scope === "turn" || scope === "snapshot") {
          onChange(scope);
        }
      }}
    >
      <Toggle aria-label="Show changes from this turn only" title="Turn" value="turn">
        <GitCommitVerticalIcon className="size-3" />
      </Toggle>
      <Toggle
        aria-label="Show all changes since the prior snapshot"
        title="Snapshot"
        value="snapshot"
      >
        <LayersIcon className="size-3" />
      </Toggle>
    </ToggleGroup>
  );
}
