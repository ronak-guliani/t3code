# AGENTS.md

## Finish

1. Run `pnpm fmt:check`, `pnpm lint`, and `pnpm typecheck`. Use `pnpm test` for the suite.
2. Commit and open a pull request without separately confirming the title or body. Only an explicit per-request restriction such as "leave uncommitted" overrides this.
3. When a tradeoff is required, choose correctness and robustness over short-term convenience.

## When working on

| Branch                                                                                              | Load                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Any change                                                                                          | [scars.md](scars.md) universal invariants, then the matching [full.md](.agents/references/scars/full.md) subsystem section |
| Wrong workspace, slow provider startup, cleanup failures, missing PR associations, misrouted review | [Symptom-to-owner map](docs/agents/navigation.md)                                                                          |
| User-visible web behavior                                                                           | [test-t3-app](.agents/skills/test-t3-app/SKILL.md) — one real-client pass, owned by the primary agent                      |
| User-visible design change                                                                          | `pnpm pr:media` before/after captures — see [CODING_STANDARDS.md](CODING_STANDARDS.md)                                     |
| Testing, evidence, or capture detail                                                                | [CODING_STANDARDS.md](CODING_STANDARDS.md)                                                                                 |
| Reporting PRs, issues, review comments, or runs                                                     | Link the artifact's real URL; comments use their permalink                                                                 |

## Scars

When you earn a hard lesson, add it to [full.md](.agents/references/scars/full.md) under the matching area and update `scars.md` if a new subsystem needs an index entry.
