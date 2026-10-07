# Coding standards

Consulted on demand from [AGENTS.md](AGENTS.md). Load it when the task writes code, verifies it, or claims a user-visible design change. Where a rule already has a home, link it rather than restating it — a second copy is a second thing to keep correct.

## Validation

`pnpm fmt:check`, `pnpm lint`, and `pnpm typecheck` gate a code task; `pnpm test` is the suite. `pnpm test:self` is a pairing and reconnect smoke check: run it when those flows change, and never read it as a gate on feature work.

## Tests

E2E is the primary mechanism. To test a system in isolation, first write down every way it can fail, then write the test, then the implementation; keep the test only when it catches a real bug E2E misses.

An acceptance test exercises the production code responsible for the claimed outcome — mock only dependencies outside the behavior under test, since a mock-data screenshot proves rendering, not backend behavior. End an E2E run with a repeatable artifact recording the tested revision, reproduction steps, assertions, and observed results.

## Proving a change

A user-visible web change earns one [`test-t3-app`](.agents/skills/test-t3-app/SKILL.md) pass, owned by the primary agent; delegated agents leave that dev server alone. Launching the isolated dev server is implied permission unless the user opts out or the flow would touch nonlocal data.

Assert snapshots, page state, console output, and failed-network diagnostics. Record a short video when motion or timing is part of the change — a video is evidence, not the assertion. Keep the dev process, authenticated tab, and test state alive while the loop runs; tear them down when it ends. Pairing tokens and credentials stay out of captures, committed files, and logs.

A design change is not merge-ready without before/after captures showing the changed feature with meaningful data, published to the PR with `pnpm pr:media`. With no live data, capture an isolated render with mock data rather than skipping. Inspect the upload and describe the tested revision, actions, observations, and limitations in the PR.

Credentials, authorization boundaries, the smallest-diff rule, and reuse-before-you-add are [scars.md](scars.md) invariants; subsystem traps are in [full.md](.agents/references/scars/full.md). Delivery boundaries are in `.agents/references/skill-delivery.md`.
