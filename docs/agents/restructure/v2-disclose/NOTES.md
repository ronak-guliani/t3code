# v2 disclose — rationale

Mid rung: the always-loaded file becomes an ordered spine plus a trigger-first pointer table, and the reference only some branches need moves behind it. 60 → 22 lines in `AGENTS.md`, with 26 lines of detail disclosed in `CODING_STANDARDS.md`.

## Deleted from AGENTS.md

- All nine `## Integrated Product Validation` bullets — a near bullet-for-bullet restatement of `.agents/skills/test-t3-app/SKILL.md`, which already covers the isolated environment, auth, diagnostics, captures, secrets, `test:self` scope, and teardown. Reduced to one pointer row; the four facts the skill does not state live in `CODING_STANDARDS.md`.
- Toolchain literals — cache of `package.json` `packageManager` / `engines`.
- The worktree PR bullet — subsumed by the standing publication rule.
- `## Links in Responses` — duplicated `.agents/references/skill-delivery.md` and the `create-pr` skill; survives as one row stating the rule without the worked examples.
- `## Core Priorities` prose and `## Maintainability` — both restate `scars.md` universal invariants. The single sentence that changes a decision (correctness over convenience) survives as step 3.
- `## Keep This File Updated` — repeated the `## Scars` section above it. One line now.

## Moved to CODING_STANDARDS.md

Validation commands and the `pnpm test` / `pnpm test:self` distinction; the test-first isolation rule; the acceptance-test rule; the E2E evidence artifact; the real-client pass; and the `pr:media` design-evidence gate.

## What this rung costs

Every hot rule now costs one pointer load, so a missed pointer is a missed rule. The pointer table compensates by naming its branch in the first few words — "user-visible web behavior", "wrong workspace, slow provider startup" — rather than describing the target. Review whether that wording is sharp enough to fire reliably, and whether the real-client pass and design-evidence rules stay reachable from a non-web task.
