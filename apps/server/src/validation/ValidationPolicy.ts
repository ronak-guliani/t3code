export type ValidationScope = "changed-behavior" | "full";

export type ValidationRequirementId =
  | "focused-tests"
  | "full-tests"
  | "format"
  | "lint"
  | "typecheck"
  | "pairing-self-test"
  | "browser-validation";

export type ValidationArea =
  | "server"
  | "web"
  | "contracts"
  | "self-test"
  | "preview"
  | "pairing"
  | "auth"
  | "bootstrap"
  | "environment"
  | "docs"
  | "other";

export interface ValidationRequirement {
  readonly id: ValidationRequirementId;
  readonly reasons: ReadonlyArray<ValidationArea>;
}

export interface ValidationPlan {
  readonly scope: ValidationScope;
  readonly changedPaths: ReadonlyArray<string>;
  readonly areas: ReadonlyArray<ValidationArea>;
  readonly requirements: ReadonlyArray<ValidationRequirement>;
}

export interface ValidationPolicyInput {
  readonly changedPaths: ReadonlyArray<string>;
  readonly scope: ValidationScope;
}

const REQUIREMENT_ORDER: readonly ValidationRequirementId[] = [
  "focused-tests",
  "full-tests",
  "format",
  "lint",
  "typecheck",
  "pairing-self-test",
  "browser-validation",
];

const AREA_ORDER: readonly ValidationArea[] = [
  "server",
  "web",
  "contracts",
  "self-test",
  "preview",
  "pairing",
  "auth",
  "bootstrap",
  "environment",
  "docs",
  "other",
];

function normalizePath(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
}

function isDocumentationPath(path: string): boolean {
  return (
    path.startsWith("docs/") ||
    path.startsWith(".docs/") ||
    /\.(?:md|mdx|txt|adoc)$/i.test(path) ||
    /^(?:CHANGELOG|LICENSE)(?:\..*)?$/i.test(path)
  );
}

function hasSegment(path: string, segment: string): boolean {
  return path === segment || path.startsWith(`${segment}/`) || path.includes(`/${segment}/`);
}

function classifyArea(path: string): ValidationArea {
  if (isDocumentationPath(path)) return "docs";
  if (
    /(?:^|\/)(?:self-test|selfTest)(?:\.|\/|$)/i.test(path) ||
    /(?:^|\/)(?:directConnectSmoke|reconnect)(?:\.|\/|$)/i.test(path)
  ) {
    return "self-test";
  }
  if (hasSegment(path, "preview")) return "preview";
  if (/(?:^|\/)(?:pairing|pair)(?:\.|\/|$)/i.test(path)) return "pairing";
  if (hasSegment(path, "auth") || /(?:^|\/)oauth(?:\.|\/|$)/i.test(path)) return "auth";
  if (hasSegment(path, "bootstrap")) return "bootstrap";
  if (hasSegment(path, "environment") || hasSegment(path, "connection")) {
    return "environment";
  }
  if (path.startsWith("apps/server/")) return "server";
  if (path.startsWith("apps/web/") || path.startsWith("packages/client-runtime/")) {
    return "web";
  }
  if (path.startsWith("packages/contracts/")) return "contracts";
  return "other";
}

function isUserVisibleWebPath(path: string): boolean {
  return path.startsWith("apps/web/") || path.startsWith("packages/client-runtime/");
}

function isCodePath(path: string): boolean {
  return !isDocumentationPath(path);
}

function addReason(
  reasons: Map<ValidationRequirementId, Set<ValidationArea>>,
  id: ValidationRequirementId,
  area: ValidationArea,
): void {
  const current = reasons.get(id) ?? new Set<ValidationArea>();
  current.add(area);
  reasons.set(id, current);
}

export class ValidationPolicy {
  classify(input: ValidationPolicyInput): ValidationPlan {
    const changedPaths = [
      ...new Set(input.changedPaths.map(normalizePath).filter(Boolean)),
    ].toSorted();
    const areas = [...new Set(changedPaths.map(classifyArea))].toSorted(
      (left, right) => AREA_ORDER.indexOf(left) - AREA_ORDER.indexOf(right),
    );
    const codePaths = changedPaths.filter(isCodePath);
    const reasons = new Map<ValidationRequirementId, Set<ValidationArea>>();

    if (codePaths.length > 0) {
      addReason(
        reasons,
        input.scope === "full" ? "full-tests" : "focused-tests",
        areas.find((area) => area !== "docs") ?? "other",
      );
      for (const requirement of ["format", "lint", "typecheck"] as const) {
        for (const area of areas) {
          if (area !== "docs") addReason(reasons, requirement, area);
        }
      }
    }

    for (const area of [
      "self-test",
      "preview",
      "pairing",
      "auth",
      "bootstrap",
      "environment",
    ] as const) {
      if (areas.includes(area)) addReason(reasons, "pairing-self-test", area);
    }

    if (changedPaths.some((path) => isUserVisibleWebPath(path) && isCodePath(path))) {
      addReason(reasons, "browser-validation", "web");
    }

    const requirements = REQUIREMENT_ORDER.flatMap((id) => {
      const requirementReasons = reasons.get(id);
      return requirementReasons
        ? [
            {
              id,
              reasons: AREA_ORDER.filter((area) => requirementReasons.has(area)),
            },
          ]
        : [];
    });

    return {
      scope: input.scope,
      changedPaths,
      areas,
      requirements,
    };
  }
}

export const classifyValidationRequirements = (input: ValidationPolicyInput): ValidationPlan =>
  new ValidationPolicy().classify(input);
