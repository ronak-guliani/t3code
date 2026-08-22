---
name: t3code-self-orchestration
description: Coordinates T3 Code from within T3 Code by creating helper threads, delegating prompts, monitoring progress, reading results, and merging findings back into the current chat. Use when the user asks a chat to control T3 Code, spawn or manage other threads, parallelize agent work, delegate tasks, or review results from other T3 chats.
---

# T3 Code Self-Orchestration

Delegate work from the current T3 thread through T3's authenticated MCP control plane.

## Core rule

Create one helper with `create_nested_thread`, or multiple sibling helpers with
`create_nested_threads`. These calls create each child, record the current thread as its parent,
select Copilot, send the first prompt, and optionally create the child's isolated worktree. Do not
assemble those steps with terminal commands or workspace tools.

## Quick start

If the MCP tool is deferred, you MUST use the tool-search API to load the `create_nested_thread`
function definition from the `t3-tools` tool resource, then call the loaded function. Do not use
MCP resources/list as an availability check: zero non-invokable resources does not mean the server
exposes zero tools. Do not infer that the authenticated `t3-tools` server lacks the tool from the
initially loaded tool list or resource count. Search for `create_nested_threads` when delegating
multiple independent sibling tasks.

Call `create_nested_thread` with:

```json
{
  "project": "project id, title, or workspace root",
  "title": "Short child-thread title",
  "prompt": "Self-contained task and expected result",
  "model": "gpt-5.6-sol",
  "reasoning": "low"
}
```

`project`, `title`, `prompt`, and `model` are required. `reasoning` is optional and supports
`low`, `medium`, `high`, or `xhigh` only when the selected model exposes that setting. Set
`dryRun: true` to validate the request and any workspace collision preflight without mutation.

Use `promptTemplate` to add only the standard blocks the child needs. The server composes selected
blocks in canonical order and rejects duplicate blocks, unknown fields, missing validation
commands, and contradictory permissions. Keep `prompt` focused on the task itself:

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

Available blocks are `repository`, `investigation-only`, `implementation`, `validation`, `commit`,
`push-and-create-pr`, and `reporting`. Omit irrelevant blocks. Use `overrides` to replace the
standard text for one selected block and `additions` to append block-specific bullet items.
Repository context, commands, commit/PR requirements, and report items remain structured fields.
Never combine `investigation-only` with `implementation`, `commit`, or `push-and-create-pr`.

Every call returns `status`, `threadId`, `retryable`, `workspaceCreated`, `cleanupPerformed`,
`errorCode`, and `message`. A `created` outcome always has a `threadId`. For an `ambiguous`
outcome with a non-null `threadId`, inspect that exact child before retrying; when it is null,
inspect the parent's children and any requested workspace state instead. Retry a failed call only
when `retryable` is true and follow any remediation in `message`.

For multiple siblings, call `create_nested_threads` with `children` containing 1-16 objects using
the same child fields shown above and optional `concurrency` from 1-4 (default 4). Its `results`
array is always in input order and contains `{ index, outcome }` for every child, even when only
some children succeed. Items that share a workspace branch or canonical path are all rejected with
`VALIDATION_FAILED` before mutation; unrelated items continue. Never retry the whole batch: inspect
and retry only individual outcomes whose `retryable` field is true. Branch and path collision keys
are Unicode-normalized and case-folded so case-only variants cannot race on macOS or Windows.

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

## Delegation workflow

1. Decide whether delegation is worthwhile; keep simple lookups and tightly coupled edits local.
2. Resolve the project and choose an available Copilot model. Pass the model explicitly.
3. Put the goal and task-specific constraints in `prompt`; select reusable context, permissions,
   validation, delivery, and reporting blocks with `promptTemplate`.
4. If isolation is needed, include `workspace` in the same `create_nested_thread` call.
5. Call the selected creation tool once, check each outcome, and capture every non-null `threadId`.
6. Monitor by `threadId` only when needed, then consolidate the result in the parent.

## Workspace ownership

- Parent stays in its current workspace.
- Child without isolation: omit `workspace`.
- Child with isolation: pass `workspace: { mode: "isolated", branch, path, baseRef? }` in its
  single or batch specification; `path` must be absolute.
- `create_isolated_workspace` and `switch_workspace` always move the thread that calls them. Use
  them only when the current thread itself must move, never to prepare a future child.
- Never run raw `git worktree add` or `git worktree move` for T3-managed delegation.
- Never use terminal-based `t3 chat new`; it lacks the authenticated parent and can target the
  wrong app flavor.

## Child prompt contract

Helper prompts must be self-contained:

- Goal and expected output.
- Repository, branch, PR, issue, or file context needed to begin.
- Relevant decisions and constraints from this conversation.
- Whether the helper may edit code or should only investigate.
- Required validation and whether it may commit, push, or update a PR.
- A concise reporting format.

The child cannot see the parent conversation; include every required decision and constraint.

## Monitoring

Use point-in-time commands by child `threadId`:

```sh
t3 chat list --parent <threadId>
t3 chat show <threadId> --messages
t3 diff thread <threadId>
t3 checkpoint list <threadId>
t3 approval list --thread <threadId>
t3 input list --thread <threadId>
```

`t3 chat stream` is persistent and does not exit when a turn completes. Do not use it as an
attached completion waiter. Use approval/input skills only with the user's authorization.

## Failure handling

- Tool returns a `threadId`: creation committed; use that child for all follow-up.
- Tool fails without a `threadId`: report the error. If the response says creation may have
  committed or a child worktree was preserved, inspect the parent's children before retrying.
- Copilot reports `Missing namespace for function_call` or says the conversation cannot continue:
  do not retry in that parent. Its Copilot history is poisoned. Start a fresh controlling thread,
  inspect whether a child was created, and delegate from there.
- Never assume a failed response means no child or worktree exists when the outcome is ambiguous.

## Safety

Report facts, changes, blockers, open questions, and child IDs needed for follow-up.

Keep destructive operations in the parent unless explicitly delegated. Never delegate credentials.
Stop or interrupt a child only when requested or obsolete; report failures plainly.
