import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import type { Project, ThreadShell } from "../types";
import { EnvironmentIdentity } from "./EnvironmentIdentity";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { findOtherProjectEnvironments } from "./ProjectEnvironmentNotice.logic";

export function ProjectEnvironmentNotice({
  environmentId,
  projectName,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectName: string;
}) {
  const projects = useStore(selectProjectsAcrossEnvironments);
  const [open, setOpen] = useState(false);
  const alternatives = useMemo(
    () => findOtherProjectEnvironments(projects, environmentId, projectName),
    [projects, environmentId, projectName],
  );
  if (alternatives.length === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button size="xs" variant="ghost" className="no-drag">
            Other environments
          </Button>
        }
      />
      <PopoverPopup className="max-w-sm space-y-3 p-3">
        <p className="text-xs">
          A project with this name exists on other environments. Threads stay on the environment
          where they were created; the same project name does not mean shared history.
        </p>
        {open
          ? alternatives.map((project) => (
              <ProjectEnvironmentDestination
                key={`${project.environmentId}:${project.id}`}
                project={project}
              />
            ))
          : null}
      </PopoverPopup>
    </Popover>
  );
}

function ProjectEnvironmentDestination({ project }: { readonly project: Project }) {
  const navigate = useNavigate();
  const latest = useStore((state) => {
    const environment = state.environmentStateById[project.environmentId];
    let latest: ThreadShell | undefined;
    for (const id of environment?.threadIdsByProjectId[project.id] ?? []) {
      const thread = environment?.threadShellById[id];
      if (thread && !thread.archivedAt && (!latest || thread.createdAt > latest.createdAt))
        latest = thread;
    }
    return latest;
  });
  return (
    <div className="space-y-1 text-xs">
      <EnvironmentIdentity environmentId={project.environmentId} />
      <p className="break-all text-muted-foreground">{project.cwd}</p>
      <Button
        size="xs"
        disabled={!latest}
        onClick={() => {
          if (latest)
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: project.environmentId, threadId: latest.id },
            });
        }}
      >
        {latest ? `Open: ${latest.title}` : "No active threads loaded"}
      </Button>
    </div>
  );
}
