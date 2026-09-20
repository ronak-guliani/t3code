import { createFileRoute } from "@tanstack/react-router";

import { PullRequestCollaborationSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/pull-request-collaboration")({
  component: PullRequestCollaborationSettingsPanel,
});
