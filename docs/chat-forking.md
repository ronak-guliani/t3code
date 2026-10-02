# Chat forking across providers

This is the design spec for provider-anchored chat forking: carrying the fork anchor
through the whole path, forking the provider session natively where it is safe, and
guaranteeing a fork through history replay when it is not.

## Problem Statement

Forking a chat that runs on Pi fails. T3 offers "Fork chat from this response" for every thread, but the provider fork is unimplemented for Pi, so the forked thread never gets a working provider session: the user is left with an error activity ("Provider fork unavailable") and a thread that cannot take a turn. The same fork works on Copilot, Claude, and OpenCode, so behavior silently differs by provider.

Underneath that, the fork is anchored correctly but the anchor is thrown away before the provider sees it. The orchestrator's provider-fork request already carries `targetMessageId`, `targetTurnId`, and `targetTurnCount`, yet the provider fork input carries none of it, so no provider can fork _at the message the user chose_ — only "the whole source session". And there is no second path: when a provider cannot fork, T3 has nothing to fall back to except failing.

The result is that fork quality is unpredictable across providers, a fork can be lost entirely because of a provider limitation, and Pi — a first-class T3 provider — cannot fork at all despite Pi itself exposing the primitive.

## Solution

Carry the fork anchor through the whole path, let each provider fork natively where it safely can, and make history replay a guaranteed, exactly-once, provider-agnostic path so a fork always succeeds and the user always learns why continuity was not native.

Concretely: fork the Pi session at the anchored entry and hand the resulting session file to the new thread's provider session (Pi already writes a new session file when it forks, and already supports resuming a specific session file); give adapters a declared fork capability so the choice between native fork and replay is deterministic instead of discovered by catching an error; and add a replay path that injects the forked history into the fork's first turn exactly once, confirmed by the provider's own consumption receipt.

## User Stories

1. As a Pi user, I want to fork a chat from any message, so that I can branch off a conversation without losing the original.
2. As a Pi user, I want the forked thread to have a working provider session immediately, so that I can keep typing in it.
3. As a Pi user, I want the forked thread to remember the conversation up to the message I forked from, so that the model does not start from nothing.
4. As a Pi user, I want the forked thread to _not_ remember messages after the fork point, so that my new direction is not polluted by the old one.
5. As a Copilot user, I want my fork to happen at the message I chose rather than cloning the whole session, so that the branched conversation is cheap and accurate.
6. As a Claude or OpenCode user, I want the same anchor behavior, so that forking feels identical across providers.
7. As a user, I want forking to behave the same way regardless of which provider runs my chat, so that I can predict what happens.
8. As a user, I want a fork to never fail just because my provider lacks a fork primitive, so that I never lose a branch I was building.
9. As a user, I want to see why continuity was not native (forked by replay, or continuity unavailable), so that I know whether the model really has my history.
10. As a user, I want to fork a chat whose provider session has no session file yet (no assistant message has been produced), so that early forks work.
11. As a user, I want to be told "the previous context could not be restored" rather than being silently given a fresh session with a reused identity, so that I never mistake a cold session for a real one.
12. As a user, I want to fork while a turn is running and get a clear refusal or a queued fork, so that the fork does not corrupt the live turn.
13. As a user, I want to fork a chat twice from the same message and get two independent branches, so that I can explore alternatives in parallel.
14. As a user, I want to fork a thread created by delegation (a helper child) so that I can continue or redirect that work myself.
15. As a user, I want to fork a chat and then keep using both threads independently, so that neither side's later turns leak into the other.
16. As a user, I want a forked thread to survive a server restart and still resume its provider session, so that continuity is not a one-session trick.
17. As a user, I want a forked thread to open with the same workspace/worktree decision as the source thread, so that the fork does not surprise my git state.
18. As a user, I want the forked thread to keep the source thread's model selection unless I change it, so that quality does not silently drop.
19. As a user, I want forked history to be delivered to the provider exactly once, so that the model does not see my conversation duplicated.
20. As a user, I want a lost/retried delivery of that history to be re-sent at most once more and still accounted for, so that retries never duplicate or drop context.
21. As a user, I want the fork to preserve message provenance (which thread and turn each message came from), so that reports and diffs still resolve correctly.
22. As a user, I want a fork of a fork to work, so that I can branch repeatedly.
23. As a maintainer, I want each adapter to declare its fork capability, so that the reactor chooses a path deterministically instead of inferring it from failures.
24. As a maintainer, I want the anchor in the provider fork contract to be optional and backward compatible, so that existing adapters keep working while they are migrated.
25. As a maintainer, I want the fork decision and its reason recorded on the thread, so that support questions are answerable from the transcript.
26. As a maintainer, I want the fork anchor carried unchanged from the orchestration request to the adapter, so that no layer silently reinterprets "fork from here".

## Implementation Decisions

1. **The anchor is plumbing, not a new concept.** The provider-fork request already carries `targetMessageId`, `targetTurnId`, and `targetTurnCount`. Those exact values become part of the provider fork input; no new orchestration command or event is introduced.

2. **Backward-compatible provider contract.** The anchor is optional in the provider fork input. An adapter that ignores it keeps its current behavior (fork the whole source session). Adapters are migrated opportunistically; no flag day.

3. **Declared fork capability per adapter.** Adapters declare one of: fork natively at an anchor, fork only the whole session, or not support forking. The reactor picks the path from the declaration, never by catching an adapter error, and downgrades explicitly with a recorded reason.

4. **Pi native fork, guarded.** When the source Pi session can be forked safely, the adapter forks at the anchored session-tree entry, reads the resulting session file, and returns it as the target thread's provider session cursor so a separate Pi process can adopt it. Model and thinking state are refreshed after a fork because Pi re-applies its own fork state. The new branch leaf is pinned so later activity cannot drift across branches.

5. **Pi cursor gains per-message entry ids.** Today the resume cursor records one session-tree entry id per turn. Forking at a message requires the entry id of that message, so the cursor records per-message ids and bumps its schema version. Version 1 cursors keep decoding; the adapter treats a missing per-message mapping as "no anchor available" and takes the replay path rather than guessing.

6. **Refuse rather than fabricate.** Pi native fork is declined when a turn is active, when the source session has no session file yet (Pi defers file creation until the first assistant message), when the provider reports the fork as cancelled, or when it does not report a forked session file. In every one of those cases the fork falls back to replay. A session id is never reused without its history; an unrestorable session starts a new one and says so.

7. **Replay is a first-class path, not an error path.** The guaranteed path: the fork's first turn carries the forked history when the live provider session for that thread has not already received it. This is the same shape other control planes use, and it makes fork support uniform across providers.

8. **Exactly-once with a confirmed receipt.** History delivery is tracked as durable state, not in-memory flags. It is recorded only when the provider confirms consumption of that specific delivery; an orphan (accepted but unconfirmed) is re-dispatched as the bare prompt while still owing the history, so a retry neither duplicates nor drops context.

9. **A fork is never lost.** The projection fork happens first and is retained regardless of provider outcome. Every provider-fork outcome — native, replayed, or continuity unavailable — is recorded as a distinct, visible activity with its reason.

10. **Ordering and locking are preserved.** Source-provider work completes before the target thread is bound; per-thread session locks are held one at a time; MCP session credentials are cleared when a fork attempt fails, as today.

11. **Anchor passthrough for the other providers.** Copilot (ACP), Claude, and OpenCode receive the anchor. Where the underlying protocol can fork at a conversation point, use it; otherwise they take the replay path with the anchor applied, so a Copilot fork at message N no longer clones a longer session than the user asked for.

12. **Workspace and model semantics stay as-is.** The fork keeps the source thread's workspace/worktree decision and model selection unless the user changes them; nothing about git ownership changes because of a fork.

## Testing Decisions

- **Good tests assert external behavior only.** Assert what a user or an operator can observe: whether the forked thread has a provider session, whether the model demonstrably has (or lacks) prior context, what the thread records about the fork, and what happens on retry. Do not assert internal call order, private adapter state, or the exact Pi CLI flag spelling.
- **Preferred seam: one end-to-end acceptance pass through the real provider.** Fork a real Pi chat at a message, assert the forked thread starts a turn, the child turn's continuation reflects the copied history and not the messages after the anchor, and the fork activity explains the path taken. Prior art: the live delegation acceptance run used for the provider MCP delegation work, and the existing live Pi adapter suite.
- **Adapter seam for the Pi specifics.** Against the fake Pi transport: fork at an anchor, declined mid-turn, declined with no session file, cursor version upgrade round-trip, and declined when the provider reports no forked file. Prior art: the Pi adapter unit suite.
- **Exactly-once seam.** Drive an accepted-but-unconfirmed history delivery and assert the retry sends the bare prompt while still owing the history, then assert the confirmed delivery is not repeated. This is the behavior most likely to regress silently, so it gets a dedicated test at the durable-state seam rather than only through the end-to-end pass.
- **Routing seam.** Provider service tests assert the anchor reaches the adapter, the capability declaration selects native vs replay, credentials are cleared on failure, and the downgrade is recorded. Prior art: provider service and per-adapter fork tests.
- **Orchestration seam.** Reactor tests assert the fork request's anchor is passed through unchanged and that a fork failure degrades to replay instead of failing the fork.
- **Contract seam.** Schema decode tests for the extended provider fork input, including that the anchor is optional and that unknown/blank values are rejected at the contract.
- **Not tested at this layer:** provider-side token accounting, Pi's internal session-file layout, and third-party protocol changes.

## Out of Scope

- Cross-provider migration of an existing thread (moving a Copilot thread onto Pi, or vice versa).
- Nested native branch trees inside a single Pi session; T3 models forks as threads, not as provider-side branch graphs.
- Retroactively upgrading existing Pi session cursors; old cursors decode and take the replay path when no anchor is available.
- Editing or diffing fork history after the fact.
- Multi-device sync of forks (out of scope until T3 has multi-device sync).
- Changing fork semantics for rollback/undo; this spec covers forking only.
- Pi version upgrades; fork semantics must be verified against the installed version rather than assumed.

## Further Notes

- **Parity reference.** Zeron (a native control plane that also drives Pi) forks at the host level only: it never forks provider state, and instead injects the copied history into the fork's first turn when the live session has not received it, tracked per runtime and recorded only on the provider's consumption receipt. Their Pi notes also state that a missing or unrestorable session must never be recreated under the same id — it starts a new session with a visible notice. This spec adopts that discipline wholesale and keeps native forks only where a provider already has them (Copilot, Claude, OpenCode), which is the one deliberate divergence.
- **Pi version caveat.** The reference implementation's Pi driver targets Pi ≥ 0.85.1 and reads Pi internals; the Pi version installed for T3 development is 1.0.0. Fork and session-adoption semantics must be re-verified against the installed version rather than assumed from either source.
- **Open questions to verify during implementation:** whether Pi's fork accepts an entry on a non-active branch; whether a forked session file can be adopted by a different Pi process; and whether the ACP fork can be anchored at a conversation point or must remain whole-session.
- **Related work.** Provider-side delegation tools were recently ported to the Pi path; the projection rules for authenticated active messages and CLI live-target discovery were hardened in the same area. This spec composes with that work and should not regress it.
