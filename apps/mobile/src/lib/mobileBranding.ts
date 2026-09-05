export type MobileStageLabel = "RG" | "RG Dev" | "RG Preview";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "RG Dev";
  if (appVariant === "preview") return "RG Preview";
  return "RG";
}
