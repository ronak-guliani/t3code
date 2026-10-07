# AGENTS.md

## Task Completion Requirements

- Run `pnpm fmt:check`, `pnpm lint`, and `pnpm typecheck` before considering code tasks complete.
- Use `pnpm test` for the Vite Plus test suite.
- Commit and open a pull request once the work is complete, without separately confirming the title or body. Only an explicit per-request restriction such as "leave uncommitted" overrides this.

## Testing Strategy

- E2E tests are the primary mechanism. Write an isolated test before its implementation, once you have written down how it can fail; keep one only when it catches a bug E2E misses.
- An acceptance test exercises the production code responsible for the claimed outcome. Mock only dependencies outside the behavior under test, and produce a repeatable artifact recording the tested revision, reproduction steps, assertions, and observed results.
- A user-visible web change is not merge-ready without before/after captures published to the PR via `pnpm pr:media`.

## Links in Responses

- Link pull requests, issues, review comments, commits, and workflow runs with explicit Markdown using their real URLs, permalinks for comments, and `owner/repo#123` for other repositories.

## Integrated Product Validation

- User-visible web work earns one real-client pass with the `test-t3-app` skill. The primary agent owns that pass; delegated agents do not launch competing dev servers in the same workspace.
- Validate observable behavior with snapshots, page state, console output, and failed-network diagnostics; a video is evidence, not the assertion.
- Keep the dev process, authenticated tab, and test state alive while the loop runs, and tear them down when it is done.
- Keep pairing tokens and credentials out of captures, committed files, and logs.

## Core Priorities

- Correctness and robustness over short-term convenience; behavior stays predictable under load, restarts, reconnects, and partial streams.

## Scars

Read the universal invariants in [scars.md](scars.md), then load the matching subsystem section from [.agents/references/scars/full.md](.agents/references/scars/full.md). When you earn a hard lesson, add it to `full.md` under the matching area and update `scars.md` if a new subsystem needs an index entry.

## Navigation

For wrong-workspace behavior, slow provider startup, cleanup failures, missing PR associations, or misrouted review feedback, start with the [symptom-to-owner map](docs/agents/navigation.md).
