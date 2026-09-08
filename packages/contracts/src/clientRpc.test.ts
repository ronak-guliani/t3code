import { describe, expect, it } from "vite-plus/test";

import { WsClientRpcGroup } from "./clientRpc.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("capability-dependent client protocol", () => {
  it("does not register optional client methods as fork server handlers", () => {
    for (const method of [
      WS_METHODS.attachmentsCreateUploadUrl,
      WS_METHODS.serverGetUsageSummary,
      WS_METHODS.providerUploadFeedback,
      WS_METHODS.subscribeResourceTelemetry,
    ]) {
      expect(WsClientRpcGroup.requests.has(method)).toBe(true);
      expect(WsRpcGroup.requests.has(method)).toBe(false);
    }
  });
});
