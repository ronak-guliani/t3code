# GitHub Copilot Integration Action Plan

## Goal

Add GitHub Copilot as a first-class t3code provider with canonical provider id
`copilot`, using Copilot CLI's ACP stdio mode:

```text
copilot --acp --stdio
```

The integration should reuse t3code's existing ACP runtime and Cursor ACP
adapter patterns. Copilot-specific behavior should live in provider metadata,
ACP support helpers, adapter logic, permission handling, mode mapping, and
parser normalization. The web app should primarily consume provider-neutral
server data and canonical runtime events.

## Phase 1: Provider Identity And Contracts

1. Add `copilot` to the provider contract surface.

   Files:
   - `packages/contracts/src/orchestration.ts`
   - `packages/contracts/src/model.ts`
   - `packages/contracts/src/provider.ts`
   - `packages/contracts/src/providerRuntime.ts`

   Changes:
   - Add `"copilot"` to `ProviderKind`.
   - Add `CopilotModelSelection` to `ModelSelection`.
   - Add `CopilotModelOptions` only if needed. Initial recommendation: keep
     options empty/omitted because Copilot owns model config through its own
     config files.
   - Add `copilot` entries to:
     - `DEFAULT_MODEL_BY_PROVIDER`, likely `"auto"`
     - `DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER`, likely keep
       Codex/Claude for text generation unless Copilot text generation support
       is explicitly added
     - `MODEL_SLUG_ALIASES_BY_PROVIDER`, likely `{}`
     - `PROVIDER_DISPLAY_NAMES`, `"GitHub Copilot"`
     - `ProviderModelOptions`

2. Add Copilot server settings.

   File:
   - `packages/contracts/src/settings.ts`

   Changes:
   - Add `CopilotSettings`:
     - `enabled`, default probably `false` for first rollout
     - `binaryPath`, default `"copilot"`
     - `customModels`, default `[]`
   - Add `providers.copilot`.
   - Add `CopilotSettingsPatch`.
   - Update `ServerSettingsPatch.providers`.

3. Update shared settings helpers.

   Files:
   - `packages/shared/src/serverSettings.ts`
   - `packages/shared/src/model.ts`

   Changes:
   - Update provider-specific branches to handle `copilot`.
   - Ensure `applyServerSettingsPatch` does not fall through to OpenCode for
     Copilot.
   - Add tests for Copilot defaults and model normalization.

## Phase 2: Provider Snapshot / Availability

4. Add a Copilot provider service interface and live layer.

   New files:
   - `apps/server/src/provider/Services/CopilotProvider.ts`
   - `apps/server/src/provider/Layers/CopilotProvider.ts`

   Implementation:
   - Mirror the shape of `apps/server/src/provider/Layers/CursorProvider.ts`.
   - Build `ServerProvider` with:
     - `provider: "copilot"`
     - `enabled` from server settings
     - `installed` from binary probe
     - `auth.status: "unknown"` initially unless a reliable auth probe exists
     - `models`: at minimum `auto`
     - `message`: actionable installation/login details when unavailable

5. Implement binary probing.

   Behavior:
   - Resolve `settings.providers.copilot.binaryPath || "copilot"`.
   - Run a cheap version command if available. If `copilot --version` is not
     stable, probe executable existence by spawning `copilot --help` with a
     short timeout.
   - Missing binary should produce: - `installed: false` - `status: "warning"` if enabled - message like `GitHub Copilot CLI was not found. Install it or configure
the binary path.`
   - Login should not be hard-failed during provider status. Runtime
     initialization should own login validation.

6. Register the provider.

   Files:
   - `apps/server/src/provider/Layers/ProviderRegistry.ts`
   - `apps/server/src/provider/providerStatusCache.ts`

   Changes:
   - Add `CopilotProviderLive`.
   - Add `copilotProvider` to `providerSources`.
   - Add `copilot` to `PROVIDER_CACHE_IDS`, likely after `cursor` or before
     `opencode` depending desired UI order.
   - Add ProviderRegistry tests for ordering, cache hydration, disabled state,
     and missing binary state.

## Phase 3: ACP Runtime Generalization

7. Make ACP authentication provider-aware.

   File:
   - `apps/server/src/provider/acp/AcpSessionRuntime.ts`

   Current issue:
   - Runtime always calls `authenticate({ methodId: options.authMethodId })`.

   Required change:
   - Add an option such as:
     - `auth?: { methodId: string; required?: boolean; missingMessage?: string }`
   - After `initialize`, check `initializeResult.authMethods`.
   - If required method is missing for Copilot, fail with an actionable error: - `GitHub Copilot login is unavailable. Run "copilot login" in a
terminal, then try again.`
   - Preserve Cursor behavior for `cursor_login`.

8. Add restricted environment support.

   File:
   - `apps/server/src/provider/acp/AcpSessionRuntime.ts`

   Current issue:
   - Spawn env is `{ ...process.env, ...options.spawn.env }`.

   Required change:
   - Add `spawn.inheritEnv?: boolean`, default `true` to avoid breaking
     existing providers.
   - For Copilot use `inheritEnv: false`.
   - Add allowlisted env builder:
     - `PATH`
     - `HOME`
     - `TERM`
     - `TMPDIR`
     - `SHELL`
     - `USER`
     - `LANG`
     - `LC_ALL`
     - `LC_CTYPE`
     - `SSH_AUTH_SOCK`
     - `GH_TOKEN`
     - `GITHUB_TOKEN`
     - `GITHUB_ENTERPRISE_TOKEN`

9. Support real ACP `session/set_mode`.

   Files:
   - `apps/server/src/provider/acp/AcpSessionRuntime.ts`
   - possibly `packages/effect-acp/src/client.ts`
   - possibly `packages/effect-acp/src/rpc.ts`

   Current issue:
   - `setMode` maps to `session/set_config_option` with config id `"mode"`.

   Required change:
   - Add support for actual `session/set_mode`.
   - Either expose `acp.agent.setSessionMode` in `effect-acp`, or call
     `runtime.request("session/set_mode", { sessionId, modeId })`.
   - Keep old config-option mode path available for Cursor if needed.
   - Add a runtime option:
     - `modeSwitchMethod: "set_mode" | "config_option"`
   - Copilot should use `"set_mode"`.

## Phase 4: Copilot ACP Support Module

10. Add Copilot ACP support helpers.

    New file:
    - `apps/server/src/provider/acp/CopilotAcpSupport.ts`

    Responsibilities:
    - Build spawn:
      - `command: settings.binaryPath || "copilot"`
      - `args: ["--acp", "--stdio"]`
      - `cwd`
      - restricted env
    - Build runtime:
      - `authMethodId: "copilot-login"`
      - client info `{ name: "t3-code", version: "0.0.0" }`
      - default ACP client capabilities
    - Map t3code modes to Copilot ACP URIs:
      - `default` / build ->
        `https://agentclientprotocol.com/protocol/session-modes#agent`
      - `plan` ->
        `https://agentclientprotocol.com/protocol/session-modes#plan`
    - Accept legacy inbound Copilot mode URIs during normalization:
      - `https://github.com/github/copilot-cli/mode#agent`
      - `https://github.com/github/copilot-cli/mode#autopilot`
      - `https://github.com/github/copilot-cli/mode#plan`

11. Add Copilot config reader.

    New file:
    - `apps/server/src/provider/acp/CopilotSettings.ts`

    Responsibilities:
    - Read `~/.copilot/config.json`.
    - Read `<cwd>/.copilot/config.json`.
    - Merge project config over user config.
    - Extract configured `model`.
    - If ACP reports empty/`auto` current model, surface configured model in
      provider model metadata.
    - Reject malformed JSON gracefully with a provider warning, not a hard
      crash.

## Phase 5: Copilot Adapter

12. Add Copilot adapter service and live implementation.

    New files:
    - `apps/server/src/provider/Services/CopilotAdapter.ts`
    - `apps/server/src/provider/Layers/CopilotAdapter.ts`

    Structure:
    - Follow `apps/server/src/provider/Layers/CursorAdapter.ts`.
    - Use `Map<ThreadId, CopilotSessionContext>`.
    - Context should include:
      - `threadId`
      - `session`
      - `scope`
      - `acp`
      - `notificationFiber`
      - `pendingApprovals`
      - `pendingUserInputs`
      - `turns`
      - `activeTurnId`
      - `stopped`

13. Implement `startSession`.

    Behavior:
    - Validate provider is `copilot`.
    - Require non-empty `cwd`.
    - Stop existing Copilot session for same thread if active.
    - Resolve persisted resume cursor.
    - Start ACP runtime.
    - Register permission handler before `start()`.
    - `AcpSessionRuntime.start()` should:
      - initialize
      - authenticate with `copilot-login`
      - use `session/load` when `resumeSessionId` exists
      - use `session/new` otherwise
    - Apply requested mode:
      - `interactionMode === "plan"` -> plan URI
      - otherwise agent URI
    - Return `ProviderSession` with:
      - `provider: "copilot"`
      - `status: "ready"`
      - `runtimeMode`
      - `cwd`
      - `model`
      - `resumeCursor: { schemaVersion: 1, sessionId }`

14. Implement `sendTurn`.

    Behavior:
    - Require active session.
    - Generate `TurnId`.
    - Apply mode for the turn.
    - Convert text and image attachments into ACP content blocks.
    - Send `session/prompt`.
    - Emit:
      - `turn.started`
      - canonical item/content/tool events from ACP stream
      - `turn.completed`
    - Persist resume cursor through `ProviderService`.

15. Implement interruption and shutdown.

    Behavior:
    - `interruptTurn`: settle pending approvals as cancelled, settle pending
      user inputs as empty, call `session/cancel`.
    - `stopSession`: interrupt notification fiber, close scope, emit
      `session.exited`, remove session.
    - `stopAll`: stop all active sessions.

16. Implement permission handling.

    Behavior:
    - Register `handleRequestPermission`.
    - If runtime mode is `full-access`, auto-select an allow option when safe.
    - Prefer `allow_once` for auto-accept unless there is a clear reason to use
      `allow_always`.
    - Do not auto-accept question-like prompts or exit-plan prompts.
    - For manual permissions:
      - parse into canonical permission request
      - emit `request.opened`
      - wait for frontend response
      - emit `request.resolved`
      - map t3code decisions to Copilot option ids:
        - `accept` -> `allow_once`
        - `acceptForSession` -> `allow_always`
        - `decline` -> `reject_once`
        - `cancel` -> cancelled outcome

17. Register the adapter.

    Files:
    - `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
    - `apps/server/src/server.ts`

    Changes:
    - Add `CopilotAdapter` service lookup.
    - Add `makeCopilotAdapterLive`.
    - Provide Copilot adapter layer in `ProviderLayerLive`.

## Phase 6: Copilot Live Update Parsing

18. Add Copilot-specific parsing hooks.

    File options:
    - extend `apps/server/src/provider/acp/AcpRuntimeModel.ts`
    - or add `apps/server/src/provider/acp/CopilotAcpRuntimeModel.ts`

    Recommendation:
    - Keep generic ACP parser intact.
    - Add provider-specific adapter functions for tool normalization.

19. Normalize Copilot tool identity.

    Rules:
    - `_meta.claudeCode.toolName` wins if present.
    - Otherwise infer from:
      - `toolCallId`
      - `title`
      - ACP `kind`
      - `rawInput`
    - Map to t3code canonical item types:
      - shell/execute -> `command_execution`
      - write/edit/delete/move -> `file_change`
      - fetch/search -> `web_search`
      - task/subagent -> `collab_agent_tool_call` or `dynamic_tool_call`
      - unknown -> `dynamic_tool_call`

20. Normalize Copilot todos and plans.

    Behavior:
    - Parse TodoWrite-like payloads into `turn.plan.updated`.
    - Detect plan writes/edits to plan files only if t3code has an equivalent
      plan surface.
    - Avoid showing assistant thought chunks as normal assistant text.

21. Add parser tests and fixtures.

    Files:
    - New fixtures under `apps/server/src/provider/acp/__fixtures__` or local
      test fixture directory.
    - Tests near `apps/server/src/provider/acp/AcpRuntimeModel.test.ts`.

    Cover:
    - assistant text streaming
    - command tool start/complete
    - edit tool with weak identity
    - search/fetch
    - todo update
    - permission request without prior tool notification
    - malformed/unknown tool does not crash

## Phase 7: Web Integration

22. Update provider model/config UI.

    Files:
    - `apps/web/src/modelSelection.ts`
    - `apps/web/src/providerModels.ts`
    - `apps/web/src/composerDraftStore.ts`

    Changes:
    - Add Copilot to provider config maps.
    - Update all fixed provider loops to include `copilot`.
    - Ensure persisted drafts with unknown provider values still decode safely.
    - Ensure Copilot model options normalize to `undefined` unless future
      options are added.

23. Update provider selection UI.

    Likely files:
    - `apps/web/src/components/ChatView.tsx`
    - composer provider registry files under `apps/web/src/components/chat`

    Changes:
    - Ensure Copilot appears when provider status is present and enabled.
    - Use `ServerProvider` data for installed/status/auth warning display.
    - Do not special-case Copilot behavior in the composer beyond display
      metadata.

24. Add provider icon/display mapping.

    Files to locate during implementation:
    - any provider badge/icon/label helpers
    - sidebar thread rendering
    - model picker provider rows

    Changes:
    - Add GitHub Copilot label.
    - Add icon asset or text fallback.
    - Prefer a central provider metadata helper if the current mappings are
      scattered.

25. Settings page.

    Files:
    - settings components under `apps/web/src/components/settings`

    Changes:
    - Add Copilot provider settings row:
      - enabled switch
      - binary path
      - custom models if the existing UI expects them
    - Show provider status:
      - installed / missing
      - auth unknown / unauthenticated message from server
    - Do not build a Copilot login UI in first pass. The action is
      `copilot login`.

## Phase 8: Optional Project-Scoped Slash Commands - Complete

26. Decide whether this is required for first release.

    Recommendation:
    - Do not block initial Copilot chat integration on preconnection slash
      commands.

27. Implemented project-scoped command lookup.

    Server:
    - Add RPC method: list provider commands for `{ provider, cwd }`.
    - Implement Copilot `.agents` discovery:
      - `<project>/.agents`
      - `~/.agents`
      - nested skills
      - nested agents
      - flat Markdown files
    - Deduplicate commands server-side.

    Web:
    - Composer asks server for project-scoped commands when selected provider is
      Copilot and project path is known.
    - Cache by `{ environmentId, provider, cwd }`.

## Phase 9: Optional Managed Installer - Complete

28. Implemented as an explicit server-side utility.

    Added server-side installer support that:
    - fetches latest `github/copilot-cli` release
    - selects OS/arch asset
    - downloads `SHA256SUMS.txt`
    - verifies checksum
    - extracts to a managed provider cache
    - returns the managed binary path for settings/provider-status refresh

    This remains behind an explicit server utility and is not invoked silently.

## Phase 10: Optional Copilot History Import - Complete

29. Implemented as a server-side history indexer.

    t3code's current model is orchestration/projection plus provider resume
    cursor. The import path now indexes external Copilot sessions without
    materializing them into t3code threads automatically.

    Added server history indexer for:
    - `~/.copilot/session-state/<session-id>/workspace.yaml`
    - `events.jsonl`
    - missing transcript markers
    - root containment checks before reading transcript paths

    Materialization into canonical t3code thread/project records remains a
    product decision because imported external sessions need a defined UX.

## Testing Plan

Add focused tests at each layer:

- contracts decode/encode accepts `copilot`
- settings defaults include `providers.copilot`
- server settings patch preserves Copilot provider data
- provider status cache orders/hydrates Copilot
- Copilot provider snapshot handles disabled, missing binary, installed binary
- ACP runtime auth validates required auth method
- ACP runtime restricted env does not leak unrelated env vars
- ACP runtime supports real `session/set_mode`
- Copilot spawn args are exactly `["--acp", "--stdio"]`
- Copilot adapter start/send/stop works against an ACP mock agent
- permission auto-accept and manual approval mapping work
- parser fixtures normalize weak Copilot tool events
- web draft persistence accepts Copilot and preserves other providers

Use the repo-required commands before completion:

```sh
bun fmt
bun lint
bun typecheck
bun run test
```

Do not run `bun test`.

## Recommended Delivery Order

1. Contracts/settings/web union plumbing.
2. Copilot provider status with binary probe.
3. ACP runtime auth/env/mode generalization.
4. Copilot ACP support module.
5. Copilot adapter with start/send/cancel/stop.
6. Permission handling.
7. Parser normalization.
8. Web polish and settings.
9. Optional slash commands.
10. Optional managed installer/history import.

The integration should be considered minimally complete when a user can enable
Copilot, configure or rely on `copilot` in `PATH`, run `copilot login`
externally, start a Copilot thread, send prompts, see assistant/tool output,
approve or reject permissions, interrupt turns, stop sessions, and resume using
persisted session state.
