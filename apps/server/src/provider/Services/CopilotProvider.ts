import type { ServerProvider } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ServerProviderShape } from "./ServerProvider.ts";

export interface CopilotProviderShape extends ServerProviderShape {
  readonly refreshForCwd: (cwd: string) => Effect.Effect<ServerProvider>;
}

export class CopilotProvider extends Context.Service<CopilotProvider, CopilotProviderShape>()(
  "t3/provider/Services/CopilotProvider",
) {}
