# Nested-thread creation examples

Load only when constructing a request. Confirm fields and limits against the loaded tool schema.
Use the user's requested model and reasoning rather than copying the example model by default.

## One helper

```json
{
  "children": [
    {
      "title": "Short child-thread title",
      "prompt": "Self-contained task and expected result"
    }
  ]
}
```

Each child requires only `title` and `prompt`. The project defaults to the authenticated parent's
workspace, and the model defaults to the authenticated parent's Copilot model. Put shared overrides in
`defaults`. Reasoning is optional, requires an explicit model, and must be supported by that model.
`defaults.dryRun: true` validates every request and workspace preflight without mutation.

## Structured prompt blocks

The following fields supplement the creation request; they are not a complete request alone:

```json
{
  "defaults": {
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
        "commands": ["pnpm fmt:check", "pnpm lint", "pnpm typecheck", "pnpm test"],
        "scenarios": ["A saved change survives reload and reconnect."],
        "evidence": ["screenshot", "recording"],
        "owner": "parent"
      },
      "commit": {
        "requirements": ["Include the repository's required co-author trailer."]
      }
    }
  },
  "children": [
    {
      "title": "Implement cache invalidation",
      "prompt": "Implement reusable cache invalidation."
    }
  ]
}
```

Select only needed blocks. `investigation-only` conflicts with `implementation`, `commit`, and
`push-and-create-pr`. The server orders selected blocks and rejects contradictory permissions,
duplicates, unknown fields, and missing validation commands. Use `overrides` to replace one
selected block and `additions` to append its requirements. Keep repository context, validation
commands, and delivery requirements in their structured fields.

For user-visible work, include observable `scenarios` and the applicable `evidence` kinds.
Use `owner: "parent"` when children share one integration environment; children must return
browser validation as pending instead of starting competing servers. Use `owner: "child"` only
for independently isolated validation. The parent must check results against the integrated
revision, not promote an assistant's completed turn to verified work.

## Multiple independent helpers

```json
{
  "defaults": {
    "project": "/repo",
    "model": "gpt-5.6-sol"
  },
  "children": [
    {
      "title": "Implement API",
      "prompt": "Implement and test the API slice.",
      "workspace": {
        "mode": "isolated",
        "branch": "feature/api",
        "path": "/repo-worktrees/api"
      }
    },
    {
      "title": "Review docs",
      "prompt": "Review the relevant documentation without editing."
    }
  ],
  "concurrency": 2
}
```

`delegate_work` supports 1-16 children and concurrency 1-4 (default 4). A child may override any
shared default. Results preserve input order with an indexed outcome for each child. Shared
workspace branches or canonical paths reject all colliding items with `VALIDATION_FAILED`;
unrelated items continue. Collision keys are Unicode-normalized and case-folded. Never retry
successful or ambiguous items as part of a batch retry; follow the root skill's outcome and
recovery rules.
