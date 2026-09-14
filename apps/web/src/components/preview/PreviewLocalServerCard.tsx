import { BrowserMockup } from "./BrowserMockup";
import type { PreviewableServer } from "./useDiscoveredLocalServers";
import { DiscoveryListRow } from "~/components/ui/discovery-list";

interface Props {
  server: PreviewableServer;
  onOpen: () => void;
}

export function PreviewLocalServerCard({ server, onOpen }: Props) {
  const subtitle = describeServer(server);
  return (
    <DiscoveryListRow
      onClick={onOpen}
      icon={<BrowserMockup className="size-7 shrink-0" />}
      title={subtitle}
      description={`${server.host}:${server.port}`}
      action={server.listening ? <PulsingDot /> : <DimDot />}
    />
  );
}

function describeServer(server: PreviewableServer): string {
  if (server.processName) return server.processName;
  if (server.listening) return "Listening";
  if (server.source === "configured") return "Configured";
  return "Recently seen";
}

function PulsingDot() {
  return (
    <span aria-label="Listening" className="relative inline-flex size-2 shrink-0">
      <span className="absolute inset-0 animate-status-ping rounded-full bg-success opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-success" />
    </span>
  );
}

function DimDot() {
  return (
    <span
      aria-label="Not currently listening"
      className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
    />
  );
}
