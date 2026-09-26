import "../../index.css";

import {
  ProjectId,
  type PullRequestInvolvement,
  type PullRequestListState,
} from "@t3tools/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { PullRequestFiltersMenu } from "./PullRequestFiltersMenu";

describe("PullRequestFiltersMenu", () => {
  it("opens without a Base UI context error and changes the involvement filter", async () => {
    const onStateChange = vi.fn<(value: PullRequestListState) => void>();
    const onInvolvementChange = vi.fn<(value: PullRequestInvolvement) => void>();
    const onProjectChange = vi.fn();

    await render(
      <PullRequestFiltersMenu
        defaultListState="open"
        effectiveState="open"
        involvement="all"
        projectId={undefined}
        projects={[{ id: ProjectId.make("project-1"), name: "T3 Code" }]}
        onStateChange={onStateChange}
        onInvolvementChange={onInvolvementChange}
        onProjectChange={onProjectChange}
      />,
    );

    await page.getByRole("button", { name: "Filter pull requests" }).click();
    await expect.element(page.getByText("State", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Involvement", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Project", { exact: true })).toBeVisible();

    await page.getByRole("menuitemradio", { name: "Reviewing" }).click();
    expect(onInvolvementChange).toHaveBeenCalledWith("reviewing");
  });
});
