# AGENTS.md restructuring proposals

Three candidate restructurings of the root `AGENTS.md`, each a self-contained drop-in, each more radical than the last. Nothing here is installed — the root `AGENTS.md` is unchanged, and adopting a variant is a separate decision.

Read a variant's `AGENTS.md` as if it sat at the repo root; the links are repo-root-relative.

| Variant                       | Root `AGENTS.md` | New files             | Also changes       | Character                                                                  |
| ----------------------------- | ---------------- | --------------------- | ------------------ | -------------------------------------------------------------------------- |
| [`v1-prune/`](v1-prune)       | 60 → 36 lines    | none                  | —                  | Wording and deletion only. Same shape, same pointers.                      |
| [`v2-disclose/`](v2-disclose) | 60 → 22 lines    | `CODING_STANDARDS.md` | —                  | Spine plus a trigger-first pointer table.                                  |
| [`v3-radical/`](v3-radical)   | 60 → 14 lines    | `CODING_STANDARDS.md` | variant `scars.md` | Deletes non-bounded prose, folds a rule into the always-loaded invariants. |

## What all three found

The `Integrated Product Validation` section — nine bullets, the largest block in the file — restates [`.agents/skills/test-t3-app/SKILL.md`](../../.agents/skills/test-t3-app/SKILL.md) almost bullet for bullet. That skill is 173 lines and already covers the isolated environment, `preview_status`/`preview_open` auth, snapshot plus console and network diagnostics, captures, secrets hygiene, `test:self` scope, and preserve-then-tear-down. Nine bullets were paying context load for a skill the agent can load on demand.

Five more findings are common to all three:

- Toolchain literals (`pnpm@11.10.0`, `node@^24.13.1`) are a verbatim cache of `package.json`.
- Two publication instructions where the standing rule subsumes the other.
- `## Keep This File Updated` names the same two files as `## Scars`, directly above it.
- `## Maintainability` restates `scars.md` universal invariant 5 in prose.
- `## Links in Responses` duplicates `.agents/references/skill-delivery.md` and the `create-pr` skill.

## Choosing

**v1** if the file's shape is load-bearing for you and you want the wins without the churn. Lowest risk, smallest diff, and the duplication is gone either way. Start here.

**v2** if you want the always-loaded file to stop carrying rules that only some tasks need. The pointer table names its branch in the first few words, which is what keeps the hidden rules reachable. The cost is real: a missed pointer is a missed rule.

**v3** goes furthest, dropping `Core Priorities` and `Links in Responses` outright and editing `scars.md`. Its extra reach comes at the price of touching a file that other docs and skills already point at.

Recommendation: **v2**, on the argument that the duplication is worth fixing everywhere but the extra reach of v3 is only worth its second always-loaded home if you are confident the invariant carries it.

## Notes

Each variant's `NOTES.md` lists every deletion with its justification, what moved, and the residual risk a reviewer should check first.
