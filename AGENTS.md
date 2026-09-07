# AGENTS.md

## Task Completion Requirements

- Run `pnpm fmt:check`, `pnpm lint`, and `pnpm typecheck` before considering code tasks complete.
- Use `pnpm test` for the Vite Plus test suite.
- Current toolchain: `pnpm@11.10.0`, `node@^24.13.1`.
- When creating a worktree for a chat, create a new pull request after the work is complete. Create without separately confirming the title or body.

## Integrated Product Validation

- Treat a request to implement or fix user-visible web behavior as permission to launch a worktree-isolated dev server and use the T3 Code collaborative browser, unless the user explicitly opts out or the flow would access nonlocal data.
- After integrating user-visible web changes, run one real-client pass with the `test-t3-app` skill. The primary agent owns this pass; delegated agents should not launch competing dev servers for the same workspace.
- For browser validation, call `preview_status` first. If no automation-capable tab is attached, call `preview_open` or `preview_open_and_snapshot` before concluding that browser automation is unavailable.
- Navigate local apps with an environment-port target, inspect a snapshot before interacting, prefer snapshot-provided semantic locators, and inspect the final snapshot plus console and failed-network diagnostics.
- A video is evidence, not the assertion. Validate observable behavior with snapshots, page state, console output, and network failures; record a short video when motion or timing is part of the change.
- Capture a final screenshot for visual changes. Keep pairing tokens, credentials, and other secrets out of screenshots, recordings, committed files, and durable logs.
- Include relevant screenshot or recording artifacts in the final handoff and pull request. Do not commit PR-only evidence to the repository.
- Preserve the isolated dev process, authenticated browser tab, selected ports, and test state while the implementation loop is still active. Tear them down only after the task is complete.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures: session restarts, reconnects, and partial streams.

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long-term maintainability is a core priority. Before adding functionality, check whether shared logic should be extracted. Avoid duplicated logic, don't be afraid to change existing code, and don't solve problems with narrow local shortcuts.
Write only the small, concise amount of code needed to solve the problem; avoid unnecessary abstraction, features, and complexity.

## Scars

Read the universal invariants in [scars.md](scars.md), then load the matching detailed subsystem section from [.agents/references/scars/full.md](.agents/references/scars/full.md) for the task at hand.

## Keep This File Updated

- Add hard-earned lessons to [.agents/references/scars/full.md](.agents/references/scars/full.md); keep each scar short, actionable, and specific, and update [scars.md](scars.md) when a new subsystem needs an index entry.
