import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { automaticPrFeedbackBlockReason } from "./automaticPrFeedback.ts";

const current = ProviderInstanceId.make("current");
const target = ProviderInstanceId.make("target");
const copilotSession = { providerName: "copilot", providerInstanceId: current, status: "ready" };

describe("automaticPrFeedbackBlockReason", () => {
  it.each(["copilot", "copilot-acp-native"])(
    "defaults %s off, including custom instances",
    (driver) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [target]: { driver: ProviderDriverKind.make(driver) },
        },
      };
      expect(automaticPrFeedbackBlockReason(settings, target)).toContain("selected Copilot");
      expect(
        automaticPrFeedbackBlockReason(
          {
            ...settings,
            copilotAutomaticPrFeedback: { [target]: true },
          },
          target,
        ),
      ).toBeNull();
    },
  );

  it.each([undefined, null, [], "invalid", 42, true, { allowAutomaticPrFeedback: true }])(
    "does not read automation policy from opaque runtime config %j",
    (config) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [target]: { driver: ProviderDriverKind.make("copilot"), config },
        },
      };
      expect(automaticPrFeedbackBlockReason(settings, target)).not.toBeNull();
      expect(
        automaticPrFeedbackBlockReason(
          {
            ...settings,
            copilotAutomaticPrFeedback: { [target]: true },
          },
          target,
        ),
      ).toBeNull();
    },
  );

  it("requires consent from both the existing and destination Copilot instances", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [target]: { driver: ProviderDriverKind.make("copilot") },
      },
      copilotAutomaticPrFeedback: { [target]: true },
    };
    expect(automaticPrFeedbackBlockReason(settings, target, copilotSession)).toContain(
      "existing Copilot",
    );
    expect(
      automaticPrFeedbackBlockReason(
        {
          ...settings,
          copilotAutomaticPrFeedback: { [target]: true, [current]: true },
        },
        target,
        copilotSession,
      ),
    ).toBeNull();
  });

  it("protects an existing Copilot session when the next provider is Codex", () => {
    const codex = ProviderInstanceId.make("codex");
    expect(
      automaticPrFeedbackBlockReason(DEFAULT_SERVER_SETTINGS, codex, copilotSession),
    ).not.toBeNull();
    expect(
      automaticPrFeedbackBlockReason(
        {
          ...DEFAULT_SERVER_SETTINGS,
          copilotAutomaticPrFeedback: { [current]: true },
        },
        codex,
        copilotSession,
      ),
    ).toBeNull();
    expect(
      automaticPrFeedbackBlockReason(DEFAULT_SERVER_SETTINGS, codex, {
        ...copilotSession,
        status: "stopped",
      }),
    ).toBeNull();
  });
});
