import { createFileRoute, redirect } from "@tanstack/react-router";
import { isConnectCliAuthEnabled } from "../cloud/connectCliAuth";
import { ConnectAccountSurface } from "../components/ConnectAccountSurface";

export const Route = createFileRoute("/connect_/environments")({
  beforeLoad: () => {
    if (!isConnectCliAuthEnabled()) throw redirect({ to: "/", replace: true });
  },
  component: ConnectAccountSurface,
});
