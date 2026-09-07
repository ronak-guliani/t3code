# Nested-thread creation examples

Load only when constructing a request. Confirm fields and limits against the loaded tool schema.
Use the user's requested model and reasoning rather than copying the example model by default.

## One helper

```json
{
  "project": "project id, title, or workspace root",
  "title": "Short child-thread title",
  "prompt": "Self-contained task and expected result",
  "model": "gpt-5.6-sol",
  "reasoning": "low"
}
```

`project`, `title`, `prompt`, and `model` are required. Reasoning is optional and must be supported
by the selected model. `dryRun: true` validates the request and workspace preflight without mutation.

## Structured prompt blocks

The following fields supplement the creation request; they are not a complete request alone:

```json
{
  "prompt": "Implement reusable cache invalidation.",
  "promptTemplate": {
    "blocks": [
      "repository",
      "implementation",
      "validation",
      "commit",
      "push-and-create-pr",
      "reporting"
    ],
    "repository": {
      "context": "Work in acme/widgets on the current feature branch.",
      "instructionFiles": ["AGENTS.md", "scars.md"]
    },
    "validation": {
      "commands": ["pnpm fmt:check", "pnpm lint", "pnpm typecheck", "pnpm test"]
    },
    "commit": {
      "requirements": ["Include the repository's required co-author trailer."]
    }
  }
}
```

Select only needed blocks. `investigation-only` conflicts with `implementation`, `commit`, and
`push-and-create-pr`. The server orders selected blocks and rejects contradictory permissions,
duplicates, unknown fields, and missing validation commands. Use `overrides` to replace one
selected block and `additions` to append its requirements. Keep repository context, validation
commands, and delivery requirements in their structured fields.

## Multiple independent helpers

```json
{
  "children": [
    {
      "project": "/repo",
      "title": "Implement API",
      "prompt": "Implement and test the API slice.",
      "model": "gpt-5.6-sol",
      "workspace": {
        "mode": "isolated",
        "branch": "feature/api",
        "path": "/repo-worktrees/api"
      }
    },
    {
      "project": "/repo",
      "title": "Review docs",
      "prompt": "Review the relevant documentation without editing.",
      "model": "gpt-5.6-sol"
    }
  ],
  "concurrency": 2
}
```

The batch supports 1-16 children and concurrency 1-4 (default 4). Results preserve input order
with an indexed outcome for each child. Shared workspace branches or canonical paths reject all
colliding items with `VALIDATION_FAILED`; unrelated items continue. Collision keys are
Unicode-normalized and case-folded. Never retry successful or ambiguous items as part of a
batch retry; follow the root skill's outcome and recovery rules.
