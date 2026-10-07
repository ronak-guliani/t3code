# Coding standards

Consulted on demand from [AGENTS.md](AGENTS.md). Load it when the task writes or verifies code. Rules that already have an authoritative home are linked, not repeated here.

## Validation

- `pnpm fmt:check`, `pnpm lint`, and `pnpm typecheck` gate a code task.
- `pnpm test` is the Vite Plus suite. `pnpm test:self` is a pairing and reconnect smoke check, relevant when those flows change; it is neither a prerequisite nor a substitute for feature testing.

## Tests

- E2E is the primary mechanism. When a system must be tested in isolation, first write down every way it can fail, then write the test, then the implementation. Keep an isolated test only when it catches a real bug E2E misses.
- An acceptance test exercises the production code responsible for the claimed outcome. Mock only dependencies outside the behavior under test; a mock-data screenshot proves rendering, not backend behavior.
- An E2E run ends with a repeatable artifact recording the tested revision, reproduction steps, assertions, and observed results — a report with a trace or recording.

## Real-client validation

A user-visible web change earns one pass with the [`test-t3-app`](.agents/skills/test-t3-app/SKILL.md) skill. The primary agent owns that pass; delegated agents do not launch competing dev servers in the same workspace. Launching the isolated dev server is implied permission unless the user opts out or the flow would touch nonlocal data.

Assert observable behavior — snapshots, page state, console output, failed-network diagnostics — and record a short video when motion or timing is part of the change. Keep the dev process, authenticated tab, and test state alive while the loop runs, and tear them down once it finishes. Keep pairing tokens and credentials out of captures, committed files, and logs.

## Design evidence

A user-visible design change is not merge-ready without before/after captures published to the PR with `pnpm pr:media`, showing the changed feature with meaningful data. When live data is unavailable, capture an isolated render with mock data rather than skipping. Inspect the uploaded media and describe the tested revision, actions, observations, and limitations in the PR.

Universal invariants in [scars.md](scars.md) cover credentials, authorization boundaries, and the smallest-diff rule; subsystem scars in [full.md](.agents/references/scars/full.md) cover the traps for the area you are touching.
