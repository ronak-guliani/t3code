import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPullRequestReviewWorkflowInput,
  reviewThreadRef,
  reviewWorkflowDisabledReason,
} from "./pullRequestReviewWorkflow";

const modelSelection = {
  instanceId: ProviderInstanceId.make("copilot"),
  model: "gpt-5",
};

describe("pull request review workflow", () => {
  it("builds the existing review workflow child-chat request", () => {
    expect(
      buildPullRequestReviewWorkflowInput({
        threadId: ThreadId.make("thread-parent"),
        projectId: ProjectId.make("project"),
        cwd: "/repo",
        pullRequestNumber: 42,
        idempotencyKey: "review-request",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ).toEqual({
      workflowId: "review-changes",
      threadId: "thread-parent",
      projectId: "project",
      cwd: "/repo",
      input: {
        scope: "pull-request",
        pullRequestNumber: 42,
      },
      destinationMode: "child-chat",
      trigger: "manual",
      idempotencyKey: "review-request",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
  });

  it("reports the first unavailable prerequisite", () => {
    expect(
      reviewWorkflowDisabledReason({
        supported: true,
        connected: false,
        enabled: true,
        isRepo: true,
        cwd: "/repo",
        modelSelection,
      }),
    ).toBe("Connect to the environment to review a pull request.");
  });

  it("builds a scoped child thread reference", () => {
    expect(reviewThreadRef(EnvironmentId.make("local"), ThreadId.make("thread-child"))).toEqual({
      environmentId: "local",
      threadId: "thread-child",
    });
  });
});
