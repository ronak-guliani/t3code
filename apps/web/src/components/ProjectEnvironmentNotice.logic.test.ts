import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import type { Project } from "../types";
import { findOtherProjectEnvironments } from "./ProjectEnvironmentNotice.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
function project(environmentId: EnvironmentId, name = "app"): Project {
  return {
    environmentId,
    id: ProjectId.make("project"),
    name,
    cwd: "/code/app",
    defaultModelSelection: null,
    scripts: [],
  };
}
describe("possible missing-thread environments", () => {
  it("offers other hosts without treating local same-name folders as shared history", () => {
    const other = project(remote);
    expect(
      findOtherProjectEnvironments(
        [project(local), other, project(remote, "different")],
        local,
        "app",
      ),
    ).toEqual([other]);
  });
  it("does not manufacture a missing-thread destination", () => {
    expect(findOtherProjectEnvironments([project(local)], local, "app")).toEqual([]);
  });
});
