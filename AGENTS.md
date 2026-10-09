# AGENTS.md

## Finish

1. `pnpm fmt:check`, `pnpm lint`, `pnpm typecheck` gate a code task; `pnpm test` is the suite.
2. Commit and open a pull request without confirming title or body; an explicit "leave uncommitted" overrides. This standing instruction is the publication authorization [skill-delivery.md](.agents/references/skill-delivery.md) otherwise requires.
3. Choose correctness and robustness over convenience, and predictably under restarts and reconnects.
4. Cite a pull request, issue, comment, commit, or run with a Markdown link to its real URL, permalink for comments, `owner/repo#123` across repositories.
5. Before creating a pull request, run `/simplify` and `/code-review`.

## Load

- Any change: [scars.md](scars.md) invariants, then the matching [full.md](.agents/references/scars/full.md) section; add earned lessons there and index new subsystems.
- Wrong workspace, slow provider startup, cleanup failure, missing PR association, misrouted review: [symptom-to-owner map](docs/agents/navigation.md).
- User-visible web behavior: [test-t3-app](.agents/skills/test-t3-app/SKILL.md), one real-client pass.
- Writing or verifying code, or proving a design change: [CODING_STANDARDS.md](CODING_STANDARDS.md).
