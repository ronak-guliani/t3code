# AGENTS.md restructuring — superseded

The three candidate restructurings that lived here were consolidated into a single installed change; this directory is retained only as the record of the deliberation.

The installed result is in the root [`AGENTS.md`](../../AGENTS.md), [`CODING_STANDARDS.md`](../../CODING_STANDARDS.md), [`scars.md`](../../scars.md), and [`full.md`](../../.agents/references/scars/full.md). Start there.

Each variant below is a self-contained drop-in, written as if installed at the repo root, with its own `NOTES.md` listing every deletion and its justification. They are kept for the arguments, not as installable options — the v1 and v2 rungs are superseded in full, and the v3 rung is installed with one deviation noted in its `NOTES.md`.

| Variant                       | Root `AGENTS.md` | New files             | Also changes       | Status                                                                |
| ----------------------------- | ---------------- | --------------------- | ------------------ | --------------------------------------------------------------------- |
| [`v1-prune/`](v1-prune)       | 60 → 36 lines    | none                  | —                  | Superseded; its deletions are all in the installed result.            |
| [`v2-disclose/`](v2-disclose) | 60 → 22 lines    | `CODING_STANDARDS.md` | —                  | Superseded; its pointer table became the installed `Load` list.       |
| [`v3-radical/`](v3-radical)   | 60 → 14 lines    | `CODING_STANDARDS.md` | variant `scars.md` | Installed, except that `Links in Responses` was kept as spine step 4. |

## What all three found

The `Integrated Product Validation` section — nine bullets, the largest block in the file — restates [`.agents/skills/test-t3-app/SKILL.md`](../../.agents/skills/test-t3-app/SKILL.md) almost bullet for bullet. That skill is 173 lines and already covers the isolated environment, `preview_status`/`preview_open` auth, snapshot plus console and network diagnostics, captures, secrets hygiene, `test:self` scope, and preserve-then-tear-down. Nine bullets were paying context load for a skill the agent can load on demand.

Five more findings were common to all three:

- Toolchain literals (`pnpm@11.10.0`, `node@^24.13.1`) are a verbatim cache of `package.json`.
- Two publication instructions where the standing rule subsumes the other.
- `## Keep This File Updated` names the same two files as `## Scars`, directly above it.
- `## Maintainability` restates a `scars.md` universal invariant in prose.
- `## Links in Responses` duplicates `.agents/references/skill-delivery.md` and the `create-pr` skill.
