# v1 prune — rationale

Least radical rung: same file, same shape, no new files. 60 → 36 lines.

## Deleted

- Toolchain literals `pnpm@11.10.0` / `node@^24.13.1` — verbatim cache of `package.json` `packageManager` and `engines`, and a file that can only go stale.
- The worktree-specific PR bullet — fully subsumed by the standing publication rule three lines below it.
- `## Keep This File Updated` — named the same two files as `## Scars` directly above it, and repeated the closing line of `scars.md`. Folded into one line under Scars.
- `## Maintainability` — its two claims ("small concise diff", "no duplicated logic") are `scars.md` universal invariant 5 verbatim in prose form.
- The `#123` / `owner/repo#123` worked examples — the rule survives, the tutorial is `skill-delivery.md`'s job.
- Eight of the nine `## Integrated Product Validation` bullets — a near bullet-for-bullet restatement of `.agents/skills/test-t3-app/SKILL.md` (173 lines), which already covers isolated environment start, `preview_status`/`preview_open` auth, snapshot plus console/network diagnostics, captures, secrets hygiene, `test:self` scope, and preserve-then-teardown. Replaced by a pointer plus the four facts the skill does not state.

## Reworded

- Publication rule: dropped the cross-reference to `skill-delivery.md` and the parenthetical, keeping the behaviour and the override condition.
- Testing: five scattered prohibitions became three positive rules. The "never write tests after the code" ban is unenforceable as written; the rewrite states the mechanism that works — enumerate failure modes, then write the test, then the implementation.
- Video line now leads with the assertion and demotes the recording, so the sentence reads as a rule rather than a hedge.

## Residual risk to review first

The compressed browser guidance. Four live facts survive only as one clause each and should be checked against `test-t3-app`: the nonlocal-data opt-out, primary-agent ownership of the real-client pass, `test:self` as a smoke check rather than a feature gate, and retaining the environment until the loop finishes.
