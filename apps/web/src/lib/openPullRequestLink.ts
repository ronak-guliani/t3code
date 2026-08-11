import { readLocalApi } from "../localApi";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

const GITHUB_PULL_REQUEST_URL =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

export interface InternalPullRequestNavigation {
  readonly repository: string;
  readonly number: number;
}

export const INTERNAL_PULL_REQUEST_NAVIGATION_EVENT = "t3:open-pull-request";

export function githubPullRequestNavigation(url: string): InternalPullRequestNavigation | null {
  const match = GITHUB_PULL_REQUEST_URL.exec(url.trim());
  const owner = match?.[1];
  const repository = match?.[2];
  const number = Number(match?.[3]);
  return owner && repository && Number.isSafeInteger(number) && number > 0
    ? { repository: `${owner}/${repository}`, number }
    : null;
}

/**
 * Routes GitHub pull requests into the app and opens other links in the user's
 * real browser. Shared by both sidebars so desktop shell handoff (and its
 * failure toasts) has a single definition.
 */
export function openPullRequestLink(
  // Structural rather than React.MouseEvent so keyboard activation shares it.
  event: { preventDefault: () => void; stopPropagation: () => void },
  prUrl: string,
): void {
  event.preventDefault();
  event.stopPropagation();

  const internalNavigation = githubPullRequestNavigation(prUrl);
  if (internalNavigation) {
    window.dispatchEvent(
      new CustomEvent<InternalPullRequestNavigation>(INTERNAL_PULL_REQUEST_NAVIGATION_EVENT, {
        detail: internalNavigation,
      }),
    );
    return;
  }

  const api = readLocalApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: "Link opening is unavailable.",
    });
    return;
  }

  void api.shell.openExternal(prUrl).catch((error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  });
}
