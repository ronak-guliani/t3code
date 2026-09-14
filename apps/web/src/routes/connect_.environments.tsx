import { createFileRoute, redirect } from "@tanstack/react-router";
import { isConnectAccountManagementEnabled } from "../cloud/connectCliAuth";
import { ConnectAccountSurface } from "../components/ConnectAccountSurface";

export const Route = createFileRoute("/connect_/environments")({
  beforeLoad: () => {
    if (!isConnectAccountManagementEnabled()) throw redirect({ to: "/", replace: true });
  },
  component: ConnectAccountSurface,
});
