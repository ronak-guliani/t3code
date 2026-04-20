---
title: GitHub Copilot provider integration
date: 2026-04-19
category: architectural
module: desktop ACP runtime
problem_type: reference
component: copilot-provider
severity: medium
tags:
  - copilot
  - acp
  - provider-runtime
  - history
  - permissions
  - preconnection-slash
---

# GitHub Copilot provider integration

## Purpose

GitHub Copilot is integrated as a first-class Acepe agent with canonical ID `copilot`.
Acepe talks to it through the Agent Client Protocol over stdio, using the managed GitHub
Copilot CLI binary when installed by Acepe.

The integration follows Acepe's provider-agnostic model:

- Provider-specific decisions live in `packages/desktop/src-tauri/src/acp/providers/copilot.rs`,
  `packages/desktop/src-tauri/src/acp/parsers/copilot_parser.rs`, Copilot history parsing, and
  provider capability metadata.
- Shared ACP client code owns subprocess lifecycle, JSON-RPC, session commands, event dispatch,
  prompt sending, permissions, projections, and frontend state.
- The frontend generally sees provider-neutral agent/session/capability models, with `copilot`
  appearing as provider metadata, icon identity, and a project-scoped slash-command provider.

## High-level flow

```text
Agent selector / session action
  -> Tauri command (`acp_new_session`, `acp_resume_session`, `acp_install_agent`, ...)
  -> `AgentRegistry` resolves `CanonicalAgentId::Copilot`
  -> `CopilotProvider`
  -> `AcpClient` subprocess: managed `copilot --acp --stdio`
  -> ACP initialize + Copilot login authentication
  -> ACP session/new, session/load, session/resume, prompt, set_mode, set_model
  -> stdout reader parses `session/update` with `CopilotParser`
  -> task/tool reconciliation, permission routing, projection, transcript delta
  -> frontend stores render provider-neutral session state
```

## Identity and registration

The canonical backend identity is `CanonicalAgentId::Copilot` in
`packages/desktop/src-tauri/src/acp/types.rs`. It serializes as `copilot`, parses the same string,
and is used for IPC, database metadata, install cache identity, and session descriptors.

`AgentRegistry` registers `CopilotProvider` as a built-in provider in
`packages/desktop/src-tauri/src/acp/registry.rs`. Built-in UI ordering places agents as:

1. `claude-code`
2. `cursor`
3. `copilot`
4. `opencode`
5. `codex`

`acp_list_agents` returns `AgentInfo` from that registry through
`packages/desktop/src-tauri/src/acp/commands/registry_commands.rs`. For Copilot, the frontend receives:

- `id`: `copilot`
- `name`: `GitHub Copilot`
- `icon`: `copilot`
- `availability_kind`: installable, with installed state derived from the managed binary cache
- `autonomous_supported_mode_ids`: `["build"]`
- provider metadata from the backend capability registry

The frontend mirrors this fallback metadata in
`packages/desktop/src/lib/services/acp-provider-metadata.ts` so cached or partially loaded states still
resolve `copilot` consistently.

## Provider capabilities

The authoritative Copilot capability row is in
`packages/desktop/src-tauri/src/acp/parsers/provider_capabilities.rs`.

Copilot's capability profile is:

| Capability                 | Value                                       |
| -------------------------- | ------------------------------------------- |
| provider id                | `copilot`                                   |
| parser                     | `CopilotParser`                             |
| backend identity policy    | generic, no required provider-session alias |
| history replay policy      | provider-owned                              |
| frontend display name      | `GitHub Copilot`                            |
| display order              | `30`                                        |
| model defaults             | not supported in Settings UI                |
| variant group              | plain                                       |
| preconnection slash mode   | project-scoped                              |
| transport family           | shared chat                                 |
| tool vocabulary            | Copilot/shared-chat                         |
| edit normalization         | Copilot/shared-chat                         |
| usage telemetry            | shared chat                                 |
| default plan source        | deterministic                               |
| model display family       | Claude-like                                 |
| usage metrics presentation | spend and context                           |

This row is important because shared code consults capabilities instead of special-casing Copilot
in the UI. For example, model display metadata, preconnection slash behavior, provider-owned replay,
and parser selection all flow from this registry.

## Installation and binary resolution

Copilot is auto-installable through the Rust agent installer in
`packages/desktop/src-tauri/src/acp/agent_installer.rs`.

The installer maps `CanonicalAgentId::Copilot` to `AgentSource::CopilotGitHubRelease`. It fetches the
latest GitHub release from `github/copilot-cli`, chooses an asset by OS and architecture, downloads
`SHA256SUMS.txt`, extracts the checksum for the chosen asset, verifies the archive, extracts it into
Acepe's managed agent cache, and writes `meta.json`.

Supported release assets are:

| Platform      | Asset                         |
| ------------- | ----------------------------- |
| macOS arm64   | `copilot-darwin-arm64.tar.gz` |
| macOS x64     | `copilot-darwin-x64.tar.gz`   |
| Linux arm64   | `copilot-linux-arm64.tar.gz`  |
| Linux x64     | `copilot-linux-x64.tar.gz`    |
| Windows arm64 | `copilot-win32-arm64.zip`     |
| Windows x64   | `copilot-win32-x64.zip`       |

The cached executable is `./copilot` on Unix and `./copilot.exe` on Windows. `get_cached_binary`
loads `meta.json`, resolves the executable relative to the Copilot cache directory, and returns it
only when the file exists.

`CopilotProvider::spawn_configs` prefers the managed cached binary. It also supports a local debug
override through `ACEPE_COPILOT_BIN` if the override points at an existing file. Both launchers use:

```text
copilot --acp --stdio
```

If neither managed cache nor debug override exists, Copilot has no launchers. `create_client` will
auto-install installable agents before starting a client, so normal session creation can provision
Copilot on demand.

## Subprocess environment

`CopilotProvider` builds a restricted subprocess environment through an allowlist:

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

`AcpClient::start` clears inherited environment variables and then applies only the provider-supplied
environment plus saved per-agent overrides, excluding protected keys such as `PATH`. This keeps the
Copilot process predictable while still allowing GitHub authentication tokens and shell basics.

## Client lifecycle

`packages/desktop/src-tauri/src/acp/client_factory.rs` creates clients for all agents. For Copilot,
the provider's communication mode is the default `Subprocess`, so Acepe creates an `AcpClient`,
starts it, and then initializes it.

`AcpClient::start` in `packages/desktop/src-tauri/src/acp/client/lifecycle.rs`:

1. Resolves the provider's ordered spawn configs.
2. Spawns the Copilot process in the session working directory.
3. Starts stderr and stdout reader tasks.
4. Stores stdin for JSON-RPC requests and inbound responses.
5. Starts a death monitor that drains pending prompt and permission state on process exit.

The stdout loop in `packages/desktop/src-tauri/src/acp/client_loop.rs` handles both JSON-RPC responses
and Copilot-initiated requests/notifications. Notifications with method `session/update` go through
the session update parser using `AgentType::Copilot`.

## ACP initialization and authentication

`AgentProvider::initialize_params` supplies Acepe's shared ACP client capabilities:

- protocol version `1`
- text file read/write support
- terminal support
- `_meta.askUserQuestion`

After `initialize`, `AcpClient::authenticate_if_required` asks the provider whether authentication is
needed. `CopilotProvider::authenticate_request_params` requires the initialized Copilot server to
advertise a `copilot-login` authentication method. If present, Acepe sends:

```json
{ "methodId": "copilot-login" }
```

If `copilot-login` is missing, Acepe fails initialization with a user-actionable message telling the
user to run `copilot login` in a terminal. Acepe does not own a full Copilot login UI.

## Sessions

### New session

Frontend session creation goes through `SessionConnectionManager.createSession` in
`packages/desktop/src/lib/acp/store/services/session-connection-manager.ts`, then `api.newSession`,
then Tauri command `acp_new_session`.

`acp_new_session`:

1. Validates the requested working directory.
2. Resolves the requested or active agent ID.
3. Creates and initializes a dedicated Copilot ACP client.
4. Calls `session/new` with `{ cwd, mcpServers: [] }`.
5. Persists session metadata with agent ID `copilot`.
6. Stores the client in `SessionRegistry` keyed by returned session ID.
7. Registers projection state for the session.

The frontend then caches returned models, modes, commands, config options, provider metadata, and
display metadata into hot session state and capabilities stores.

### Resume and reconnect

Frontend reconnect goes through `SessionConnectionManager.connectSession`, then `api.resumeSession`,
then Tauri command `acp_resume_session`.

Copilot has one frontend-specific reconnect behavior: `SessionConnectionManager.resolveResumeLaunchModeId`
passes the current UI mode only for `copilot`. Rust maps that UI mode through the provider before launch:

- `build` -> `https://agentclientprotocol.com/protocol/session-modes#agent`
- `plan` -> `https://agentclientprotocol.com/protocol/session-modes#plan`

`acp_resume_session` is intentionally fire-and-forget. It validates synchronously, spawns async resume
work, and reports completion via `ConnectionComplete` or `ConnectionFailed` through the event hub.

The heavy resume work:

1. Resolves session descriptor facts from metadata.
2. Creates or reuses a client for the session.
3. Applies launch mode when requested.
4. Reconnects the client. Copilot deliberately uses ACP `session/load` here, not `session/resume`,
   so the provider can replay historical updates during reconnect.
5. Materializes canonical session state if needed.
6. Restores transcript/projection snapshots.
7. Emits lifecycle completion with models, modes, commands, config options, and autonomous state.

### ACP load versus resume

`AcpClient` has both `resume_session` and `load_session`.

- `session/resume` reconnects to a provider session.
- `session/load` is replay-oriented and activates a replay guard while historical updates stream.

During replay, the stdout loop auto-cancels inbound requests so historical permission/question prompts
do not block the restored session.

### Fork

`acp_fork_session` resolves the original session descriptor, creates a new dedicated Copilot client,
calls ACP `session/fork`, stores the returned new session ID, and persists metadata under the new ID.

## Modes and autonomous policy

Copilot exposes provider-native ACP mode URIs. Acepe normalizes them to UI mode IDs:

| Provider mode URI                                                  | UI mode |
| ------------------------------------------------------------------ | ------- |
| `https://agentclientprotocol.com/protocol/session-modes#agent`     | `build` |
| `https://agentclientprotocol.com/protocol/session-modes#autopilot` | `build` |
| `https://agentclientprotocol.com/protocol/session-modes#plan`      | `plan`  |
| legacy `https://github.com/github/copilot-cli/mode#agent`          | `build` |
| legacy `https://github.com/github/copilot-cli/mode#autopilot`      | `build` |
| legacy `https://github.com/github/copilot-cli/mode#plan`           | `plan`  |

Outbound mode changes map UI IDs back to current ACP standard URIs:

- `build` -> `...#agent`
- `plan` -> `...#plan`

`AcpClient::set_session_mode` sends `session/set_mode` and ignores method-not-found or other set-mode
failures so the UI does not break when a provider lacks native mode switching.

Autonomous mode is Acepe-side policy, not a Copilot launch flag. `acp_set_session_autonomous` stores
per-session policy in `SessionPolicyRegistry`. Permission handling checks this policy and auto-responds
to non-question, non-exit-plan permission requests when autonomous is enabled. Copilot marks `build` as
the supported autonomous mode.

## Model defaults and Copilot config

Copilot does not support Acepe Settings model defaults (`supports_model_defaults: false`). Instead,
the provider reads Copilot's own config file through
`packages/desktop/src-tauri/src/acp/providers/copilot_settings.rs`.

Acepe reads:

- `~/.copilot/config.json`
- `<project>/.copilot/config.json`

Project config is merged after user config and wins for the `model` field. If Copilot's ACP response
has an empty or `auto` current model, Acepe sets `models.current_model_id` to the configured model. If
that model is not in the returned catalog, Acepe inserts it at the front with description
`Configured in Copilot config.json`.

## Slash commands before connection

Copilot's provider metadata sets `preconnection_slash_mode` to `ProjectScoped`.

The frontend uses two preconnection command paths:

- Startup-global agents are warmed by `PreconnectionAgentSkillsStore`.
- Project-scoped agents such as Copilot are loaded on demand by
  `PreconnectionRemoteCommandsState` once the composer has a project path.

The command route is:

```text
agent-input-ui.svelte
  -> PreconnectionRemoteCommandsState.ensureLoaded(projectPath, "copilot")
  -> tauriClient.acp.listPreconnectionCommands
  -> acp_list_preconnection_commands
  -> CopilotProvider::list_preconnection_commands
```

`CopilotProvider` loads slash commands from `.agents` roots in this order:

1. `<project>/.agents`
2. `~/.agents`

For each root it loads:

- nested skill commands from `<root>/skills`
- nested agent commands from `<root>`
- flat Markdown agent files directly under `<root>`

Commands are deduplicated before returning. This means Copilot owns `.agents` project and user command
discovery through the provider seam; the frontend only knows that Copilot is project-scoped.

## Live update parsing

Copilot live updates enter through the shared stdout loop as `session/update` notifications.
`session_update_parser.rs` normalizes nested and flat ACP notification shapes, then calls
`parse_session_update_with_agent(..., AgentType::Copilot)`.

`CopilotParser` owns Copilot-specific parsing:

- uses shared-chat update type detection and usage telemetry parsing
- parses tool calls from `toolCallId`, `title`, `rawInput`, `status`, `kind`, and `_meta.claudeCode`
- normalizes tool names through `CopilotAdapter`
- infers tool kind from payload/title/kind hints when Copilot emits weak identity such as `unknown`
- parses `AskUserQuestion` into canonical question requests
- parses `TodoWrite`/todo shapes into canonical todo data
- parses edit arguments through Copilot/shared-chat edit normalization
- extracts plan updates from Write/Edit tool calls targeting `.claude/plans/*.md`

Copilot uses `TaskReconciliationPolicy::ImplicitSingleActiveParent`. In
`client_updates/mod.rs`, updates for providers with a task reconciler go through
`process_through_reconciler`. This lets Acepe assemble Copilot subagent/tool graphs when Copilot omits
explicit parent IDs but there is a single active task parent.

## Tool semantics

The Copilot adapter in `packages/desktop/src-tauri/src/acp/reconciler/providers/copilot.rs` currently
delegates name normalization to the shared-chat adapter. The important Copilot-specific behavior is not
a large name table; it is robust recovery from weak Copilot event identity:

- If `_meta.claudeCode.toolName` is present, it wins.
- Otherwise, parser/reconciler code infers from tool call ID, title, ACP kind hint, and raw argument
  shape.
- Edit arguments are normalized by `edit_normalizers/copilot.rs`, which currently reuses shared-chat
  edit parsing.
- SQL/todo/search/task/edit regressions are covered by fixtures under
  `packages/desktop/src-tauri/src/acp/parsers/tests/fixtures/` and parser/reconciler tests.

The frontend should render projected `ToolArguments` and `ToolKind`, not raw Copilot payloads.

## Permissions and questions

Copilot permission requests arrive as inbound JSON-RPC requests with method
`session/request_permission`. They are routed by
`packages/desktop/src-tauri/src/acp/inbound_request_router`.

The router:

1. Parses the request using provider parser semantics.
2. Synthesizes a pending tool call if there was no prior tool-call notification to anchor the prompt.
3. Builds canonical `PermissionRequest` or `QuestionRequest` session updates.
4. Emits those updates through the event dispatcher.
5. Stores an inbound responder in `SessionRegistry` so frontend replies can be routed back to stdin.

If the session is autonomous, or if the permission belongs to a child tool call under an already active
task, the Rust router can auto-respond with the `allow_once` option and mark the canonical permission
as auto-accepted. Questions and exit-plan permissions are never auto-accepted.

Frontend fallback normalization still exists in
`packages/desktop/src/lib/acp/logic/inbound-request-normalization.ts` for legacy inbound request paths.
The preferred path is the backend canonical interaction update.

`PermissionStore` resolves Copilot option IDs from the original request options:

- `once` uses option kind `allow_once`
- `always` uses `allow_always`
- `reject` uses `reject_once`

It then replies through the shared interaction reply layer, which chooses the correct transport from
the stored reply handler.

## History indexing

Copilot history is provider-owned because Acepe cannot rely solely on a shared JSONL format.

The history source is `CopilotSource` in `packages/desktop/src-tauri/src/history/indexer.rs`.
It scans Copilot's session state through `packages/desktop/src-tauri/src/copilot_history`.

Session state root:

```text
~/.copilot/session-state
```

For each session directory, Acepe reads:

- `workspace.yaml` for `cwd`, `summary`, and `updated_at`
- `events.jsonl` when available for replay/materialization

The workspace `cwd` is normalized through `session_metadata_context_from_cwd`, so Acepe records main
project path plus optional worktree path. Sessions are filtered to known Acepe project paths and limited
per project.

If `events.jsonl` is missing, the indexer stores a synthetic source path marker:

```text
__session_registry__/copilot_missing/<session-id>
```

This keeps the history record visible even when a transcript file is unavailable.

## History replay and materialization

`CopilotProvider::load_provider_owned_session` delegates to `copilot_history::load_session`.

`copilot_history::load_session` resolves the transcript path from the session replay context:

- Use `replay_context.source_path` when present and not a missing-transcript marker.
- Otherwise use `~/.copilot/session-state/<history-session-id>/events.jsonl`.

`parse_copilot_session_at_root` canonicalizes both the session-state root and target transcript path,
then rejects any transcript path outside the root. This prevents arbitrary file reads through stored
metadata.

Copilot replay converts Copilot event JSONL into canonical `SessionUpdate`s, then into a
`ConvertedSession`. Supported event shapes include:

- `session.start`
- `user.message`
- `assistant.message`
- `assistant.reasoning`
- `tool.execution_start`
- `tool.execution_complete`
- `subagent.started`
- `subagent.completed`

Assistant thought chunks are filtered from restored history when building the converted session. Tool
start/complete events are parsed through the same Copilot parser/builders used for live tool data so
replay semantics match live sessions as closely as possible.

History load audit currently does not support Copilot; both CLI and in-app audit paths return
`Copilot audit is not implemented yet`.

## Frontend consumption

The frontend primarily treats Copilot as data:

- `AgentStore` loads it from `acp_list_agents`, stores installation state, and listens to
  `agent-install:progress`.
- `SessionConnectionManager` creates/resumes sessions and caches provider metadata, models, modes,
  commands, config options, and model display data.
- `SessionCapabilitiesStore` and hot state expose provider-neutral session capabilities to toolbar and
  composer components.
- `agent-input-ui.svelte` uses provider metadata to decide whether slash commands come from live session
  commands, startup-global preconnection commands, or project-scoped preconnection commands.
- Tool rendering routes on canonical tool kind and typed arguments.
- Copilot icons come from the shared icon identity `copilot`, including thread-list assets in
  `packages/desktop/src/lib/acp/constants/thread-list-constants.ts`.

The key rule: frontend code should not infer Copilot behavior from display labels or raw Copilot
payloads. It should consume backend-projected provider metadata, session capabilities, canonical
interactions, and canonical tool arguments.

## Failure behavior

Important Copilot failure paths:

- Missing managed binary: Copilot has no spawn configs; `create_client` auto-installs if possible.
- Install failure: frontend shows the install error from `AgentStore.installAgent`.
- Missing login method after initialize: backend returns an error telling the user to run
  `copilot login`.
- Subprocess exits or stdout closes: the stdout loop/death monitor drains pending prompt requests,
  fails pending permissions, and emits turn errors where possible.
- Replay parse failure: provider-owned replay returns `None`; Acepe keeps metadata/projection fallback
  behavior instead of deleting history.
- Missing transcript file: history indexer stores the missing marker and keeps the history row.
- Unsupported history audit: explicit `Copilot audit is not implemented yet` error.

## Where to look

| Concern                       | Primary files                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Canonical ID                  | `packages/desktop/src-tauri/src/acp/types.rs`                                                                    |
| Built-in registry             | `packages/desktop/src-tauri/src/acp/registry.rs`                                                                 |
| Provider behavior             | `packages/desktop/src-tauri/src/acp/providers/copilot.rs`                                                        |
| Provider settings             | `packages/desktop/src-tauri/src/acp/providers/copilot_settings.rs`                                               |
| Capability registry           | `packages/desktop/src-tauri/src/acp/parsers/provider_capabilities.rs`                                            |
| Live parser                   | `packages/desktop/src-tauri/src/acp/parsers/copilot_parser.rs`                                                   |
| Tool adapter                  | `packages/desktop/src-tauri/src/acp/reconciler/providers/copilot.rs`                                             |
| Edit normalization            | `packages/desktop/src-tauri/src/acp/parsers/edit_normalizers/copilot.rs`                                         |
| Installer                     | `packages/desktop/src-tauri/src/acp/agent_installer.rs`                                                          |
| Client lifecycle              | `packages/desktop/src-tauri/src/acp/client_factory.rs`, `packages/desktop/src-tauri/src/acp/client/lifecycle.rs` |
| Session commands              | `packages/desktop/src-tauri/src/acp/commands/session_commands.rs`                                                |
| Preconnection commands        | `packages/desktop/src-tauri/src/acp/commands/preconnection_commands.rs`                                          |
| Inbound permissions           | `packages/desktop/src-tauri/src/acp/inbound_request_router/permission_handlers.rs`                               |
| Copilot history parser        | `packages/desktop/src-tauri/src/copilot_history/parser.rs`                                                       |
| Copilot history facade        | `packages/desktop/src-tauri/src/copilot_history/mod.rs`                                                          |
| History indexing              | `packages/desktop/src-tauri/src/history/indexer.rs`                                                              |
| Frontend provider metadata    | `packages/desktop/src/lib/services/acp-provider-metadata.ts`                                                     |
| Frontend agent store          | `packages/desktop/src/lib/acp/store/agent-store.svelte.ts`                                                       |
| Session connection manager    | `packages/desktop/src/lib/acp/store/services/session-connection-manager.ts`                                      |
| Project-scoped slash commands | `packages/desktop/src/lib/acp/components/agent-input/logic/preconnection-remote-commands-state.svelte.ts`        |
| Permission store              | `packages/desktop/src/lib/acp/store/permission-store.svelte.ts`                                                  |

## Design constraints to preserve

- Keep Copilot-specific policy in the provider, parser, installer, and history seams.
- Keep UI behavior driven by provider metadata and canonical session models.
- Do not scrape undocumented Copilot storage beyond the observed session-state files already handled
  by `copilot_history`.
- Do not add frontend special cases for Copilot when a provider capability or provider method can own
  the behavior.
- Preserve the difference between UI mode IDs (`build`, `plan`) and Copilot ACP mode URIs.
- Preserve backend-owned permission auto-accept policy for autonomous mode and child tool calls.
