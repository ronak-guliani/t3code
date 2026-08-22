export const DELEGATION_PROMPT_BLOCKS = [
  "repository",
  "investigation-only",
  "implementation",
  "validation",
  "commit",
  "push-and-create-pr",
  "reporting",
] as const;

export type DelegationPromptBlock = (typeof DELEGATION_PROMPT_BLOCKS)[number];

interface DelegationPromptTemplate {
  readonly blocks: ReadonlyArray<DelegationPromptBlock>;
  readonly repository?: {
    readonly context?: string;
    readonly instructionFiles?: ReadonlyArray<string>;
  };
  readonly validation?: {
    readonly commands: ReadonlyArray<string>;
  };
  readonly commit?: {
    readonly requirements?: ReadonlyArray<string>;
  };
  readonly pullRequest?: {
    readonly requirements?: ReadonlyArray<string>;
  };
  readonly reporting?: {
    readonly items?: ReadonlyArray<string>;
  };
  readonly overrides: Readonly<Partial<Record<DelegationPromptBlock, string>>>;
  readonly additions: Readonly<Partial<Record<DelegationPromptBlock, ReadonlyArray<string>>>>;
}

const BLOCK_HEADINGS: Readonly<Record<DelegationPromptBlock, string>> = {
  repository: "Repository instructions and context",
  "investigation-only": "Permissions",
  implementation: "Permissions",
  validation: "Validation",
  commit: "Commit requirements",
  "push-and-create-pr": "Push and pull request",
  reporting: "Expected report",
};

const STANDARD_BLOCKS: Readonly<Record<DelegationPromptBlock, string>> = {
  repository:
    "Read and follow all applicable repository instruction files before acting. Treat repository-local guidance as authoritative for the files in its scope.",
  "investigation-only":
    "Investigation only. Do not modify files, create commits, push branches, create or update pull requests, or perform destructive actions. Return evidence-based findings and recommendations.",
  implementation:
    "Implementation is permitted. Make only the focused changes required for the task, preserve unrelated work, and follow repository conventions.",
  validation:
    "Run every listed validation command before reporting success. If a command fails, investigate it and report the unresolved failure rather than claiming completion.",
  commit:
    "After required validation succeeds, create one focused commit containing only task-related changes. Follow repository commit-message and trailer requirements, and do not amend unrelated commits.",
  "push-and-create-pr":
    "Push the task branch and create a focused pull request without asking for title or body confirmation. Derive accurate metadata from the final diff, never force-push, and report the pull request URL.",
  reporting:
    "Report the outcome, material findings or changes, validation results, commit SHA and pull request URL when applicable, blockers, and limitations. Do not claim actions that were not completed.",
};

const BLOCK_SET: ReadonlySet<string> = new Set(DELEGATION_PROMPT_BLOCKS);
const TEMPLATE_KEYS = new Set([
  "blocks",
  "repository",
  "validation",
  "commit",
  "pullRequest",
  "reporting",
  "overrides",
  "additions",
]);

export class DelegationPromptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationPromptValidationError";
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DelegationPromptValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new DelegationPromptValidationError(
      `${label} contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DelegationPromptValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalTextList(
  value: unknown,
  label: string,
  options: { readonly singleLine?: boolean } = {},
): ReadonlyArray<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new DelegationPromptValidationError(`${label} must be a non-empty array`);
  }
  return value.map((item, index) => {
    const text = optionalText(item, `${label}[${String(index)}]`);
    if (!text) {
      throw new DelegationPromptValidationError(
        `${label}[${String(index)}] must be a non-empty string`,
      );
    }
    if (options.singleLine && /[\r\n]/.test(text)) {
      throw new DelegationPromptValidationError(
        `${label}[${String(index)}] must be a single-line command`,
      );
    }
    return text;
  });
}

function parseBlockMap<T>(
  value: unknown,
  label: string,
  parseValue: (value: unknown, label: string) => T,
): Readonly<Partial<Record<DelegationPromptBlock, T>>> {
  if (value === undefined) return {};
  const record = requireRecord(value, label);
  rejectUnknownKeys(record, BLOCK_SET, label);
  return Object.fromEntries(
    Object.entries(record).map(([block, item]) => [block, parseValue(item, `${label}.${block}`)]),
  ) as Partial<Record<DelegationPromptBlock, T>>;
}

function parseOptionalSection(
  template: Record<string, unknown>,
  key: "repository" | "validation" | "commit" | "pullRequest" | "reporting",
  selectedBlock: DelegationPromptBlock,
): Record<string, unknown> | undefined {
  if (template[key] === undefined) return undefined;
  if (!(template.blocks as ReadonlyArray<string>).includes(selectedBlock)) {
    throw new DelegationPromptValidationError(
      `promptTemplate.${key} requires the '${selectedBlock}' block`,
    );
  }
  return requireRecord(template[key], `promptTemplate.${key}`);
}

export function parseDelegationPromptTemplate(value: unknown): DelegationPromptTemplate {
  const template = requireRecord(value, "promptTemplate");
  rejectUnknownKeys(template, TEMPLATE_KEYS, "promptTemplate");

  if (!Array.isArray(template.blocks) || template.blocks.length === 0) {
    throw new DelegationPromptValidationError("promptTemplate.blocks must be a non-empty array");
  }
  const blocks = template.blocks.map((block, index) => {
    if (typeof block !== "string" || !BLOCK_SET.has(block)) {
      throw new DelegationPromptValidationError(
        `promptTemplate.blocks[${String(index)}] is not a supported block`,
      );
    }
    return block as DelegationPromptBlock;
  });
  if (new Set(blocks).size !== blocks.length) {
    throw new DelegationPromptValidationError("promptTemplate.blocks must not contain duplicates");
  }
  if (blocks.includes("investigation-only") && blocks.includes("implementation")) {
    throw new DelegationPromptValidationError(
      "promptTemplate cannot combine investigation-only and implementation permissions",
    );
  }
  if (
    blocks.includes("investigation-only") &&
    (blocks.includes("commit") || blocks.includes("push-and-create-pr"))
  ) {
    throw new DelegationPromptValidationError(
      "promptTemplate investigation-only permissions cannot include commit or push-and-create-pr",
    );
  }

  const repositoryInput = parseOptionalSection(template, "repository", "repository");
  if (repositoryInput) {
    rejectUnknownKeys(
      repositoryInput,
      new Set(["context", "instructionFiles"]),
      "promptTemplate.repository",
    );
  }
  const repositoryContext = repositoryInput
    ? optionalText(repositoryInput.context, "promptTemplate.repository.context")
    : undefined;
  const repositoryInstructionFiles = repositoryInput
    ? optionalTextList(
        repositoryInput.instructionFiles,
        "promptTemplate.repository.instructionFiles",
      )
    : undefined;
  const repository = repositoryInput
    ? {
        ...(repositoryContext ? { context: repositoryContext } : {}),
        ...(repositoryInstructionFiles ? { instructionFiles: repositoryInstructionFiles } : {}),
      }
    : undefined;

  const validationInput = parseOptionalSection(template, "validation", "validation");
  if (blocks.includes("validation") && !validationInput) {
    throw new DelegationPromptValidationError(
      "promptTemplate.validation is required when validation is selected",
    );
  }
  if (validationInput) {
    rejectUnknownKeys(validationInput, new Set(["commands"]), "promptTemplate.validation");
  }
  const validation = validationInput
    ? {
        commands:
          optionalTextList(validationInput.commands, "promptTemplate.validation.commands", {
            singleLine: true,
          }) ?? [],
      }
    : undefined;
  if (validation && validation.commands.length === 0) {
    throw new DelegationPromptValidationError(
      "promptTemplate.validation.commands must be a non-empty array",
    );
  }

  const commitInput = parseOptionalSection(template, "commit", "commit");
  if (commitInput) {
    rejectUnknownKeys(commitInput, new Set(["requirements"]), "promptTemplate.commit");
  }
  const commitRequirements = commitInput
    ? optionalTextList(commitInput.requirements, "promptTemplate.commit.requirements")
    : undefined;
  const commit = commitInput
    ? commitRequirements
      ? { requirements: commitRequirements }
      : {}
    : undefined;

  const pullRequestInput = parseOptionalSection(template, "pullRequest", "push-and-create-pr");
  if (pullRequestInput) {
    rejectUnknownKeys(pullRequestInput, new Set(["requirements"]), "promptTemplate.pullRequest");
  }
  const pullRequestRequirements = pullRequestInput
    ? optionalTextList(pullRequestInput.requirements, "promptTemplate.pullRequest.requirements")
    : undefined;
  const pullRequest = pullRequestInput
    ? pullRequestRequirements
      ? { requirements: pullRequestRequirements }
      : {}
    : undefined;

  const reportingInput = parseOptionalSection(template, "reporting", "reporting");
  if (reportingInput) {
    rejectUnknownKeys(reportingInput, new Set(["items"]), "promptTemplate.reporting");
  }
  const reportItems = reportingInput
    ? optionalTextList(reportingInput.items, "promptTemplate.reporting.items")
    : undefined;
  const reporting = reportingInput ? (reportItems ? { items: reportItems } : {}) : undefined;

  const overrides = parseBlockMap(template.overrides, "promptTemplate.overrides", (item, label) => {
    const result = optionalText(item, label);
    if (!result) throw new DelegationPromptValidationError(`${label} is required`);
    return result;
  });
  const additions = parseBlockMap(template.additions, "promptTemplate.additions", (item, label) => {
    const result = optionalTextList(item, label);
    if (!result) throw new DelegationPromptValidationError(`${label} is required`);
    return result;
  });
  for (const block of [...Object.keys(overrides), ...Object.keys(additions)]) {
    if (!blocks.includes(block as DelegationPromptBlock)) {
      throw new DelegationPromptValidationError(
        `promptTemplate customization for '${block}' requires selecting that block`,
      );
    }
  }

  return {
    blocks,
    ...(repository ? { repository } : {}),
    ...(validation ? { validation } : {}),
    ...(commit ? { commit } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    ...(reporting ? { reporting } : {}),
    overrides,
    additions,
  };
}

function bullets(items: ReadonlyArray<string> | undefined): string {
  return items?.map((item) => `- ${item}`).join("\n") ?? "";
}

function blockDetails(block: DelegationPromptBlock, template: DelegationPromptTemplate): string {
  switch (block) {
    case "repository": {
      const instructionFiles = template.repository?.instructionFiles;
      return [
        instructionFiles ? `Instruction files to read:\n${bullets(instructionFiles)}` : "",
        template.repository?.context ? `Repository context:\n${template.repository.context}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "validation":
      return `Commands:\n${bullets(template.validation?.commands.map((command) => `\`${command}\``))}`;
    case "commit":
      return bullets(template.commit?.requirements);
    case "push-and-create-pr":
      return bullets(template.pullRequest?.requirements);
    case "reporting":
      return bullets(template.reporting?.items);
    case "investigation-only":
    case "implementation":
      return "";
  }
}

export function composeDelegationPrompt(task: string, value: unknown): string {
  const normalizedTask = task.trim();
  if (!normalizedTask) {
    throw new DelegationPromptValidationError("delegation task must be a non-empty string");
  }
  const template = parseDelegationPromptTemplate(value);
  const selected = new Set(template.blocks);
  const sections = DELEGATION_PROMPT_BLOCKS.flatMap((block) => {
    if (!selected.has(block)) return [];
    const content = [
      template.overrides[block] ?? STANDARD_BLOCKS[block],
      blockDetails(block, template),
      bullets(template.additions[block]),
    ]
      .filter(Boolean)
      .join("\n\n");
    return [`## ${BLOCK_HEADINGS[block]}\n${content}`];
  });
  return [`## Task\n${normalizedTask}`, ...sections].join("\n\n");
}
