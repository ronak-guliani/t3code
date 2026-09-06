import { describe, expect, it } from "vitest";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import type { Project } from "../types";
import {
  findGitHubPullRequestProject,
  githubPullRequestNavigation,
  findPullRequestBrowserThread,
} from "./openPullRequestLink";

const ENVIRONMENT_ID = EnvironmentId.make("environment-a");
const PROJECT_ID = ProjectId.make("project-a");

it("routes PR links only to an active explicitly associated thread in the selected project", () => {
  const owner = {
    id: ThreadId.make("owner"),
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    archivedAt: null,
    pullRequest: {
      number: 291,
      title: "Browser",
      url: "https://github.com/owner/repo/pull/291",
      baseBranch: "main",
      headBranch: "feature",
      state: "open" as const,
    },
  };
  const reference = { projectId: PROJECT_ID, repository: "owner/repo", number: 291 };
  const unrelated = [
    { ...owner, environmentId: EnvironmentId.make("other") },
    { ...owner, projectId: ProjectId.make("other") },
    { ...owner, archivedAt: "2026-09-05T00:00:00Z" },
    { ...owner, pullRequest: null },
    {
      ...owner,
      pullRequest: { ...owner.pullRequest, url: "https://github.com/other/repo/pull/291" },
    },
  ];
  expect(findPullRequestBrowserThread(unrelated, ENVIRONMENT_ID, reference)).toBeUndefined();
  expect(findPullRequestBrowserThread([...unrelated, owner], ENVIRONMENT_ID, reference)).toBe(
    owner,
  );
});
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    name: "t3code",
    cwd: "/repo/t3code",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity: {
      canonicalKey: "github.com/t3tools/t3code",
      displayName: "t3tools/t3code",
      provider: "github",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/t3tools/t3code.git",
      },
    },
    ...overrides,
  };
}

describe("githubPullRequestNavigation", () => {
  it("recognizes a GitHub pull request URL", () => {
    expect(githubPullRequestNavigation("https://github.com/t3tools/t3code/pull/4849")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 4849,
      url: "https://github.com/t3tools/t3code/pull/4849",
    });
  });

  it("recognizes Enterprise pull request URLs", () => {
    expect(
      githubPullRequestNavigation("https://github.example.com/t3tools/t3code/pull/4849"),
    ).toMatchObject({
      host: "github.example.com",
      repository: "t3tools/t3code",
      number: 4849,
    });
  });

  it("does not capture non-pull request URLs", () => {
    expect(
      githubPullRequestNavigation("https://gitlab.com/t3tools/t3code/-/merge_requests/4849"),
    ).toBeNull();
  });

  it("matches a project by canonical GitHub host and repository", () => {
    const publicProject = makeProject();
    const enterpriseProject = makeProject({
      id: ProjectId.make("project-enterprise"),
      repositoryIdentity: {
        ...publicProject.repositoryIdentity!,
        canonicalKey: "github.example.com/t3tools/t3code",
      },
    });

    expect(
      findGitHubPullRequestProject([publicProject, enterpriseProject], {
        environmentId: ENVIRONMENT_ID,
        host: "github.example.com",
        repository: "t3tools/t3code",
      }),
    ).toBe(enterpriseProject);
  });
});
