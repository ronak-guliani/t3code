import { expect, it } from "vitest";
import { resolveMobileStageLabel } from "./mobileBranding";

it("identifies the owned build instead of advertising upstream release channels", () => {
  expect(resolveMobileStageLabel("development")).toBe("RG Dev");
  expect(resolveMobileStageLabel("preview")).toBe("RG Preview");
  expect(resolveMobileStageLabel("production")).toBe("RG");
  expect(resolveMobileStageLabel(undefined)).toBe("RG");
});
