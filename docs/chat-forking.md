# Chat forking across providers

This is the design spec for chat forking on the current orchestration path. It is not a new
design: orchestration-v2 already defines the model in
`docs/orchestration-v2/thread-lineage-and-context-transfer.md`, and its Pi adapter already
implements the native fork path. This spec scopes the current path to that model.

## Problem Statement

Forking a chat that runs on Pi fails. The UI offers "Fork chat from this response" for every
thread, but the Pi provider fork is unimplemented, so the forked thread never gets a working
provider session: the user gets an error activity and a thread that cannot take a turn. The same
fork works on Copilot, Claude, and OpenCode, so behavior silently differs by provider.

The current path also has no model for what a fork _is_. It eagerly asks the provider to fork the
whole source session during the fork itself, so the fork cannot be anchored at the message the
user chose, cannot be deferred until the user picks an agent, has no durable record of how
continuity was achieved, and has no defined path when a provider cannot fork — it simply fails
and the user is left holding the error.

## Solution

Adopt the orchestration-v2 model on the current path: a fork is a **thread relationship plus a
pending context transfer**, resolved lazily on the first dispatch, with the resolution strategy
recorded (native provider fork when the source has strong native refs and the adapter supports
it, portable context otherwise). Implement the Pi native fork to the same standard as
orchestration-v2's Pi adapter, declare fork capabilities per adapter, and make a fork never fail
outright — it either resolves or records exactly why it could not.

## User Stories

1. As a Pi user, I want to fork a chat from a message, so that I can branch off a conversation without losing the original.
2. As a Pi user, I want the forked thread to take a turn immediately, so that I can keep typing in it.
3. As a Pi user, I want the forked thread to remember the conversation up to the turn I forked from, so that the model is not starting from nothing.
4. As a Pi user, I want the forked thread to _not_ remember turns after the fork point, so that my new direction is not polluted by the old one.
5. As a user, I want forking to be cheap and instant even on a long chat, so that I do not wait for provider work I may never use.
6. As a user, I want to choose the agent on the forked thread's first turn rather than at fork time, so that a fork is not bound to the source provider.
7. As a user, I want to see how the fork's context was carried — native fork or portable context — so that I know whether the model really has my history.
8. As a user, I want a visible reason when continuity could not be established, so that I never mistake a cold session for a real one.
9. As a user, I want a fork to never fail outright because a provider lacks a fork primitive, so that I never lose a branch.
10. As a user, I want forking refused while a turn is running, with a clear message, so that the live turn is not corrupted.
11. As a user, I want forking refused from a run that is still in progress or was rolled back, so that forks always start from a settled point.
12. As a user, I want to fork a chat whose provider session has no session file yet, so that early forks work (via portable context).
13. As a user, I want forked context to be delivered exactly once, so that the model does not see my conversation duplicated.
14. As a user, I want a retried delivery to still account for the context, so that retries neither duplicate nor drop it.
15. As a user, I want to fork twice from the same point and get two independent branches, so that I can explore alternatives.
16. As a user, I want to fork a delegation-created helper child, so that I can redirect that work myself.
17. As a user, I want a forked thread to survive a server restart and still resolve or resume its context, so that continuity is durable.
18. As a user, I want the fork to record where it came from (source thread and run), so that lineage is visible and merge-back can be built on it later.
19. As a user, I want the fork to keep the source workspace/worktree and model selection unless I change them, so that git state is not surprising.
20. As a user, I want message provenance preserved on the fork, so that reports, diffs, and attribution still resolve.
21. As a user, I want to fork a fork, so that I can branch repeatedly.
22. As a maintainer, I want fork capabilities declared per adapter, so that resolution is chosen deterministically instead of inferred from failures.
23. As a maintainer, I want the fork anchor to reach the adapter unchanged, so that no layer reinterprets "fork from here".
24. As a maintainer, I want one shared record for fork/handoff/merge-back/subagent context movement, so that a fork is an instance of a model rather than a special case.
25. As a maintainer, I want the resolution recorded once and consumed once, so that a retry cannot double-apply context.

## Implementation Decisions

1. **The target model is orchestration-v2's lineage + context transfer.** A fork creates a target
   thread with a fork relationship to its parent and a pending context transfer; the provider
   session, provider thread, and portable context are not created at fork time. The first dispatch
   on the fork resolves the transfer. The current path must express the same records — a fork
   relationship, the source point, transfer status, resolution, consumption, and error — so that a
   fork is an instance of the shared model and not a special case.

2. **Resolution is lazy and typed.** The transfer resolves to one of: a native provider fork (with
   the resulting provider thread ref), portable context (a context handoff materialized from the
   source), or — deferred with merge-back — a delta or checkpoint-based resolution. Same-provider
   forks prefer the native fork when the source's native refs are strong and the adapter declares
   support; otherwise portable context is materialized. This is the deliberate divergence from
   host-only-fork implementations: native forks are kept where they exist, and replay is a first
   class resolution rather than an error path.

3. **Anchor at a provider turn, not a message.** The orchestration payload already carries a target
   message, target turn, and target turn count; the provider-facing anchor is the provider turn.
   Resolution stops at the turn boundary (the entry before that turn's first user message). No
   per-message provider entry mapping is required, and no provider cursor schema change is needed
   for this work. The target message remains available for UI lineage.

4. **Forkability comes from run status.** Only provider-finished runs are forkable — completed,
   waiting, failed, interrupted, cancelled. In-progress and rolled-back runs are refused with a
   clear reason. This is stronger and more consistent than "no active turn".

5. **Strong native refs gate the native path.** A native fork requires a strong native thread ref
   on the source. When it is absent, the transfer records the reason and resolves as portable
   context. A provider session identity is never reused without its history: an unrestorable
   session starts a new one and says so.

6. **Pi native fork, ported to match orchestration-v2.** The adapter refuses while a turn is
   active; requires a source session file; resolves the boundary from the target turn's captured
   session-tree refs; creates the forked session with a short-lived `pi --fork` process launched
   with extensions and tools disabled (the CLI fork sets the destination cwd, which the RPC-level
   clone/switch does not); optionally re-roots with an in-process fork request when a boundary
   exists; requires the resulting session file to be **distinct** from the source file; and
   registers the result under the target thread's provider-thread row. Model and thinking state are
   refreshed after a fork because the provider re-applies its own state.

7. **Per-adapter fork capabilities.** Adapters declare whether they can fork a thread, fork from a
   turn, and fork a subagent thread. Resolution is chosen from the declaration and the source's ref
   strength; it is never chosen by catching an adapter error.

8. **Resolution is recorded once and consumed once.** The transfer carries status, resolution,
   consumption, and error. Portable context delivery is recorded as consumed only once it is
   confirmed delivered, and an accepted-but-unconfirmed delivery is re-dispatched while still
   owing the context.

9. **A fork is never lost.** The thread and its lineage are persisted first; every outcome —
   native fork, portable context, or continuity unavailable — is a distinct, visible record with
   its reason. Behavior change to note: forks on the current path are currently resolved eagerly
   for Copilot, Claude, and OpenCode; making resolution lazy changes when their provider sessions
   are created, and existing forks remain resolved as they are.

10. **Ordering and locking.** Source-provider work completes before the target thread is bound;
    per-thread session locks are held one at a time; provider MCP credentials are cleared when a
    fork attempt fails.

11. **Workspace and model semantics are unchanged.** A fork keeps the source workspace/worktree
    decision and model selection unless changed; git ownership is unaffected by a fork.

12. **Open decision: v1 parity versus delegation to v2.** If orchestration-v2 becomes the default
    path on a schedule close to this work, implementing transfer records twice is waste. The
    recommended sequence is: land the Pi native fork and capability declarations first (they are
    needed either way, and Pi is the visible gap), then decide whether the current orchestrator
    grows a minimal transfer record or delegates fork resolution to the v2 service. This spec
    covers both shapes; the choice is a delivery decision, not a design change.

## Testing Decisions

- **Good tests assert external behavior only.** Assert what a user or operator observes: whether a
  forked thread can take a turn, whether the model demonstrably has the pre-fork context and not
  the post-fork turns, which resolution was recorded, and what happens on retry. Do not assert
  internal call order, private adapter state, or CLI flag spelling.
- **Preferred seam: one end-to-end acceptance pass through the real provider.** Fork a real Pi chat
  at a turn, dispatch the fork's first turn, assert the continuation reflects the copied history
  and not the turns after the anchor, and assert the recorded resolution and reason. Prior art: the
  live provider acceptance runs and the existing live Pi adapter suite.
- **Mirror orchestration-v2's fork tests.** The upstream suites are the model: fork service
  planning tests, fork execution tests, a fork integration testkit, and an adapter fork testkit.
  Port the same cases to the current path rather than inventing a parallel matrix.
- **Pi adapter fork guards.** Against the fake Pi transport: refuse mid-turn, refuse with no source
  session file, refuse when the boundary has no captured session-tree entry, refuse when the
  forked file is not distinct from the source, and succeed by registering the new ref under the
  target row.
- **Resolution routing.** Transfer tests assert: same provider plus strong ref plus declared support
  resolves native; any of those missing resolves portable context; a weak or absent ref records the
  reason; and each resolution is consumed exactly once, including on retry.
- **Forkability gate.** Assert in-progress and rolled-back sources are refused with the run status
  in the reason, and that provider-finished sources are accepted.
- **Contract seam.** Schema decode tests for the extended provider fork input (anchor optional and
  validated) and for the transfer record's shape.
- **Not tested at this layer:** provider-side token accounting, Pi's internal session-file layout,
  and third-party protocol changes.

## Out of Scope

- Merge-back from a fork into its source (the delta/checkpoint resolution strategies), and any
  provider handoff or subagent-thread forking — these ride the same transfer primitive upstream and
  should land with that work, not here.
- Per-message fork anchoring and any provider cursor schema change.
- Cross-provider migration of an existing thread.
- Editing or diffing fork history after the fact.
- Retroactive repair of existing forks; unresolved forks resolve on their next dispatch.
- Multi-device sync of forks.
- Pi version upgrades; fork semantics must be verified against the installed version rather than
  assumed.

## Further Notes

- **Upstream is the reference, not a suggestion.** The lineage/context-transfer doc and the Pi
  adapter's fork implementation already encode the guards, the CLI-fork-in-a-side-process choice
  (with its cwd rationale), and the distinct-file requirement that a fresh design would have to
  rediscover. This spec exists to bring the current path to that model, not to replace it.
- **Why the fork anchor stops at a turn.** Resolving to the entry before the target turn's first
  user message reuses the existing rollback boundary logic and the per-turn session-tree refs the
  adapter already records, which keeps provider cursors unchanged.
- **Discipline borrowed from host-only-fork implementations.** Deliver carried context exactly once
  and record it only on confirmed delivery; never recreate a provider session identity without its
  history; show the user when context could not be restored. These hold regardless of which
  resolution strategy is chosen.
- **Pi version caveat.** The reference Pi driver targets Pi ≥ 0.85.1 while T3 development runs a
  newer Pi; fork and session-adoption semantics must be verified against the installed version
  rather than assumed from either source.
- **Related work.** Provider-side delegation tools were recently ported to the Pi path, and the
  projection rules for authenticated active messages plus CLI live-target discovery were hardened in
  the same area. This work composes with that and must not regress it.
