export const deferredRouteLoaders = {
  connectionsNew: () =>
    import("./features/connection/ConnectionsNewRouteScreen").then(
      (module) => module.ConnectionsNewRouteScreen,
    ),
  legal: () =>
    import("./features/settings/SettingsLegalRouteScreen").then(
      (module) => module.SettingsLegalRouteScreen,
    ),
  terminal: () =>
    import("./features/terminal/ThreadTerminalRouteScreen").then(
      (module) => module.ThreadTerminalRouteScreen,
    ),
  review: () => import("./features/review/ReviewSheet").then((module) => module.ReviewSheet),
  reviewComment: () =>
    import("./features/review/ReviewCommentComposerSheet").then(
      (module) => module.ReviewCommentComposerSheet,
    ),
  threadFiles: () =>
    import("./features/files/ThreadFilesRouteScreen").then(
      (module) => module.ThreadFilesTreeScreen,
    ),
  threadFile: () =>
    import("./features/files/ThreadFilesRouteScreen").then((module) => module.ThreadFileScreen),
} as const;
