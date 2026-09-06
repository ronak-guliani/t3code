# Project scars index

Keep this file small and load the detailed scar only for the subsystem being changed.

## Universal invariants

- Preserve credentials, tokens, private prompts, and user data; redact them from logs, screenshots, exports, and reports.
- Keep destructive, external, merge, approval, and credentialed operations behind explicit authorization and recoverable boundaries.
- Preserve isolated state, workspace ownership, provider lifecycle, and ambiguous-outcome recovery.
- Validate the acceptance criteria and relevant behavior, report blockers plainly, and do not treat an unrelated passing command as proof.

## Subsystem index

The complete, preserved scar record is in [`.agents/references/scars/full.md`](.agents/references/scars/full.md). Select only the relevant lines by subsystem keywords when working:

| Area                                                                         | Load when working on             |
| ---------------------------------------------------------------------------- | -------------------------------- |
| Browser, auth, pairing, screenshots, and real-client validation              | Browser and app testing          |
| Provider lifecycle, reconnects, approvals, queued turns, and partial streams | Runtime/provider integration     |
| SQLite state, migrations, fixtures, and read-only inspection                 | Database or test fixtures        |
| Checkpoints, revert, recovery, and ambiguous outcomes                        | Session persistence or recovery  |
| Worktrees, branch ownership, patch recovery, and PR delivery                 | Git or workspace workflows       |
| Nested threads, delegation, and workspace handoff                            | T3 orchestration                 |
| Review scope, validation, and issue-tracker conventions                      | Skills, reviews, or tracker docs |

When a new hard-earned lesson is discovered, add it to `full.md` under the matching area and keep this index updated. Do not replace a detailed scar with a generic reminder.
