# AGENTS.md

## Finish

1. `pnpm fmt:check`, `pnpm lint`, `pnpm typecheck` gate a code task; `pnpm test` is the suite.
2. Commit and open a pull request without confirming title or body; an explicit "leave uncommitted" overrides.
3. Choose correctness and robustness over convenience, and predictably under restarts and reconnects.

## Load

- Any change: [scars.md](scars.md) invariants, then the matching [full.md](.agents/references/scars/full.md) section; add earned lessons there and index new subsystems.
- Wrong workspace, slow provider startup, cleanup failure, missing PR association, misrouted review: [symptom-to-owner map](docs/agents/navigation.md).
- User-visible web behavior: [test-t3-app](.agents/skills/test-t3-app/SKILL.md), one real-client pass.
- Writing or verifying code, or proving a design change: [CODING_STANDARDS.md](CODING_STANDARDS.md).
