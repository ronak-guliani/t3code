import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { useState } from "react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderInstanceCard } from "./ProviderInstanceCard";

function Harness({
  driver = "copilot",
  onUpdate,
}: {
  driver?: string;
  onUpdate: (instance: ProviderInstanceConfig) => void;
}) {
  const [instance, setInstance] = useState<ProviderInstanceConfig>({
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    config: { binaryPath: "/custom/copilot", customModels: ["custom-model"] },
  });
  return (
    <ProviderInstanceCard
      instanceId={ProviderInstanceId.make("test-instance")}
      instance={instance}
      driverOption={undefined}
      liveProvider={undefined}
      isExpanded
      onExpandedChange={() => {}}
      onUpdate={(next) => {
        setInstance(next);
        onUpdate(next);
      }}
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onModelOrderChange={() => {}}
    />
  );
}

describe("Copilot automatic PR feedback containment", () => {
  it.each(["copilot", "copilot-acp-native"])(
    "defaults off and persists a reversible opt-in for %s",
    async (driver) => {
      const onUpdate = vi.fn();
      await render(<Harness driver={driver} onUpdate={onUpdate} />);
      const toggle = page.getByRole("switch", {
        name: "Allow automatic PR feedback (interrupt risk)",
      });
      await expect.element(toggle).not.toBeChecked();
      await expect
        .element(page.getByText(/This does not fix hidden activity or checkpoints/))
        .toBeVisible();
      await toggle.click();
      await expect.element(toggle).toBeChecked();
      expect(onUpdate).toHaveBeenLastCalledWith({
        driver,
        enabled: true,
        config: {
          binaryPath: "/custom/copilot",
          customModels: ["custom-model"],
          allowAutomaticPrFeedback: true,
        },
      });
      await toggle.click();
      await expect.element(toggle).not.toBeChecked();
      expect(onUpdate.mock.lastCall?.[0].config.allowAutomaticPrFeedback).toBe(false);
    },
  );

  it("does not expose Copilot containment for other drivers", async () => {
    await render(<Harness driver="codex" onUpdate={vi.fn()} />);
    await expect
      .element(page.getByRole("switch", { name: "Allow automatic PR feedback (interrupt risk)" }))
      .not.toBeInTheDocument();
  });
});
