import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterHistory } from "@tanstack/react-router";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { routeTree } from "./routeTree.gen";
import { retryUnlessRateLimited } from "./lib/rateLimitQuery";

export function getRouter(history: RouterHistory) {
  const queryClient = new QueryClient({
    defaultOptions: {
      // A rate-limit refusal cannot succeed on immediate retry — the quota
      // resets server-side — so fail fast instead of re-issuing it 3x per
      // mount. Everything else keeps TanStack's default three attempts.
      queries: { retry: retryUnlessRateLimited },
    },
  });

  return createRouter({
    routeTree,
    history,
    context: {
      queryClient,
    },
    Wrap: ({ children }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AppAtomRegistryProvider, undefined, children),
      ),
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
