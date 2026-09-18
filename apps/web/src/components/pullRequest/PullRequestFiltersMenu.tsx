import type { ProjectId, PullRequestInvolvement, PullRequestListState } from "@t3tools/contracts";
import { ListFilterIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

const LIST_STATES = ["all", "open", "closed", "merged"] as const;
const INVOLVEMENTS = ["all", "reviewing", "authored"] as const;
const ALL_PROJECTS_VALUE = "all";

const LIST_STATE_LABELS: Record<(typeof LIST_STATES)[number], string> = {
  all: "All states",
  open: "Open",
  closed: "Closed",
  merged: "Merged",
};

const INVOLVEMENT_LABELS: Record<(typeof INVOLVEMENTS)[number], string> = {
  all: "All involvement",
  reviewing: "Reviewing",
  authored: "Authored",
};

export interface PullRequestFilterProject {
  readonly id: ProjectId;
  readonly name: string;
}

interface PullRequestFiltersMenuProps {
  readonly defaultListState: PullRequestListState;
  readonly effectiveState: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly projectId: ProjectId | undefined;
  readonly projects: readonly PullRequestFilterProject[];
  readonly onStateChange: (value: PullRequestListState) => void;
  readonly onInvolvementChange: (value: PullRequestInvolvement) => void;
  readonly onProjectChange: (value: ProjectId | undefined) => void;
}

export function PullRequestFiltersMenu({
  defaultListState,
  effectiveState,
  involvement,
  projectId,
  projects,
  onStateChange,
  onInvolvementChange,
  onProjectChange,
}: PullRequestFiltersMenuProps) {
  const filterCount =
    (effectiveState === defaultListState ? 0 : 1) +
    (involvement === "all" ? 0 : 1) +
    (projectId ? 1 : 0);

  return (
    <Menu>
      <MenuTrigger
        className="relative"
        render={
          <Button
            aria-label={`Filter pull requests${filterCount > 0 ? `, ${filterCount} active` : ""}`}
            size="default"
            variant="outline"
          />
        }
      >
        <ListFilterIcon aria-hidden />
        <span>Filters</span>
        {filterCount > 0 ? (
          <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground tabular-nums">
            {filterCount}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={effectiveState}
          onValueChange={(value) => onStateChange(value as PullRequestListState)}
        >
          <MenuGroupLabel>State</MenuGroupLabel>
          {LIST_STATES.map((state) => (
            <MenuRadioItem key={state} value={state}>
              {LIST_STATE_LABELS[state]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuRadioGroup
          value={involvement}
          onValueChange={(value) => onInvolvementChange(value as PullRequestInvolvement)}
        >
          <MenuGroupLabel>Involvement</MenuGroupLabel>
          {INVOLVEMENTS.map((option) => (
            <MenuRadioItem key={option} value={option}>
              {INVOLVEMENT_LABELS[option]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuRadioGroup
          value={projectId ?? ALL_PROJECTS_VALUE}
          onValueChange={(value) =>
            onProjectChange(value === ALL_PROJECTS_VALUE ? undefined : (value as ProjectId))
          }
        >
          <MenuGroupLabel>Project</MenuGroupLabel>
          <MenuRadioItem value={ALL_PROJECTS_VALUE}>All projects</MenuRadioItem>
          {projects.map((project) => (
            <MenuRadioItem key={project.id} value={project.id}>
              {project.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
