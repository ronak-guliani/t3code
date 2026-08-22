import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@t3tools/shared/Net";
import * as Layer from "effect/Layer";

import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";

export const CliRuntimeLayerLive = WorkspacePathsLive.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NetService.layer),
);
