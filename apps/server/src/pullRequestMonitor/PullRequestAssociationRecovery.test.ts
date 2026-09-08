import {
  CommandId,
  EventId,
  GitManagerError,
  MessageId,
  OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GitStatusResult,
  type OrchestrationCommand,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { GitManager } from "../git/Services/GitManager.ts";
import { decideOrchestrationCommand } from "../orchestration/decider.ts";
import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  makePullRequestAssociationRecovery,
  reportedPullRequestUrl,
} from "./PullRequestAssociationRecovery.ts";

const now = "2026-09-08T00:00:00.000Z";
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const threadId = ThreadId.make("thread");
const url = "https://github.com/acme/app/pull/42";
const message = (text = `Draft PR: [#42](${url})`): OrchestrationMessage => ({
  id: MessageId.make("message"),
  role: "assistant",
  text,
  streaming: false,
  turnId: null,
  createdAt: now,
  updatedAt: now,
});
const status: GitStatusResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "feature",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: {
    number: 42,
    title: "Feature",
    url,
    baseBranch: "main",
    headBranch: "feature",
    state: "open",
  },
};

async function harness() {
  const commandId = CommandId.make("create");
  let model = await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: EventId.make("created"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: now,
      commandId,
      causationEventId: null,
      correlationId: commandId,
      metadata: {},
      payload: {
        threadId,
        projectId: ProjectId.make("project"),
        title: "Feature",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature",
        worktreePath: "/isolated/worktree",
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  model = {
    ...model,
    threads: model.threads.map((thread) => ({ ...thread, messages: [message()] })),
  };
  const commands: OrchestrationCommand[] = [];
  let lookups = 0;
  let invalidations = 0;
  let gitStatus = status;
  let failLookup = false;
  let onLookup = () => {};
  const unexpected = () => Effect.die("Unexpected service call");
  const recovery = await Effect.runPromise(
    makePullRequestAssociationRecovery.pipe(
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () => Effect.succeed(model),
        dispatch: (command) =>
          Effect.gen(function* () {
            commands.push(command);
            const planned = yield* decideOrchestrationCommand({ readModel: model, command });
            for (const event of "type" in planned ? [planned] : planned) {
              model = yield* projectEvent(
                model,
                decodeEvent({
                  ...event,
                  sequence: model.snapshotSequence + 1,
                  eventId: EventId.make(crypto.randomUUID()),
                }),
              );
            }
            return { sequence: model.snapshotSequence };
          }),
        withWorktreeLock: (effect) => effect,
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        acquireDomainEventSubscription: Effect.die("Unexpected subscription"),
      }),
      Effect.provideService(GitManager, {
        status: ({ cwd }) =>
          Effect.gen(function* () {
            expect(cwd).toBe("/isolated/worktree");
            expect(invalidations).toBeGreaterThan(lookups);
            lookups++;
            onLookup();
            if (failLookup) {
              return yield* new GitManagerError({
                operation: "status",
                detail: "Temporary failure",
              });
            }
            return gitStatus;
          }),
        invalidateStatus: () =>
          Effect.sync(() => {
            invalidations++;
          }),
        localStatus: unexpected,
        remoteStatus: unexpected,
        invalidateLocalStatus: unexpected,
        invalidateRemoteStatus: unexpected,
        resolvePullRequest: unexpected,
        preparePullRequestThread: unexpected,
        runStackedAction: unexpected,
      }),
    ),
  );
  return {
    recovery,
    commands,
    lookups: () => lookups,
    setFailure: (value: boolean) => {
      failLookup = value;
    },
    onLookup: (callback: () => void) => {
      onLookup = callback;
    },
    thread: () => model.threads[0],
    setStatus: (value: GitStatusResult) => {
      gitStatus = value;
    },
    updateThread: (update: Partial<(typeof model.threads)[number]>) => {
      model = { ...model, threads: model.threads.map((thread) => ({ ...thread, ...update })) };
    },
  };
}

describe("reportedPullRequestUrl", () => {
  it("reads plain and Markdown URLs, deduplicating repeated links", () => {
    expect(reportedPullRequestUrl({ messages: [message(`${url}\n[PR](${url})`)] })).toBe(url);
    for (const text of [`<${url}>`, `"${url}"`, `\`${url}\``]) {
      expect(reportedPullRequestUrl({ messages: [message(text)] })).toBe(url);
    }
  });

  it("does not infer from user input, partial streams, or ambiguous references", () => {
    for (const messages of [
      [{ ...message(), role: "user" as const }],
      [{ ...message(), streaming: true }],
      [message(`${url} https://github.com/acme/app/pull/43`)],
      [message(), message("No PR was created.")],
      [message("https://github.com.evil.example/acme/app/pull/42")],
      [message(`https://example.test/${url}`)],
      [message(`https://example.test/?redirect=${url}`)],
      [message(`prefix${url}`)],
    ]) {
      expect(reportedPullRequestUrl({ messages })).toBeNull();
    }
  });
});

describe("pull request association recovery", () => {
  it("recovers persisted assistant output without a separate agent tool call", async () => {
    const h = await harness();
    await Effect.runPromise(h.recovery.sweep);
    expect(h.commands).toEqual([
      expect.objectContaining({
        type: "thread.meta.update",
        threadId,
        expectedUpdatedAt: now,
        pullRequest: status.pr,
      }),
    ]);
    expect(h.commands[0]).not.toHaveProperty("pullRequestOwnership");
    expect(h.thread()?.pullRequest).toEqual(status.pr);
    await Effect.runPromise(h.recovery.sweep);
    expect(h.lookups()).toBe(1);
  });

  it("retries a not-yet-visible PR using fresh status", async () => {
    const h = await harness();
    h.setStatus({ ...status, pr: null });
    await Effect.runPromise(h.recovery.sweep);
    expect(h.commands).toEqual([]);
    h.setStatus(status);
    await Effect.runPromise(h.recovery.sweep);
    expect(h.commands).toHaveLength(1);
    expect(h.lookups()).toBe(2);
  });

  it("never substitutes a branch PR for a different reported URL", async () => {
    const h = await harness();
    h.updateThread({ messages: [message("PR: https://github.com/other/repo/pull/42")] });
    await Effect.runPromise(h.recovery.sweep);
    expect(h.commands).toEqual([]);
  });

  it("retries failures rather than permanently marking the message handled", async () => {
    const h = await harness();
    h.setFailure(true);
    await Effect.runPromise(h.recovery.sweep);
    expect(h.thread()?.pullRequest).toBeFalsy();
    h.setFailure(false);
    await Effect.runPromise(h.recovery.sweep);
    expect(h.thread()?.pullRequest).toEqual(status.pr);
  });

  it("preserves an explicit association made while Git status is in flight", async () => {
    const h = await harness();
    const explicit = { ...status.pr!, number: 43, url: "https://github.com/acme/app/pull/43" };
    h.onLookup(() =>
      h.updateThread({
        pullRequest: explicit,
        updatedAt: "2026-09-08T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(h.recovery.sweep);
    expect(h.thread()?.pullRequest).toEqual(explicit);
  });

  it("skips existing associations, archived threads, and missing intent without Git calls", async () => {
    const h = await harness();
    for (const update of [
      { pullRequest: status.pr },
      { pullRequest: null, archivedAt: now },
      { archivedAt: null, messages: [message("Done")] },
    ]) {
      h.updateThread(update);
      await Effect.runPromise(h.recovery.sweep);
    }
    expect(h.lookups()).toBe(0);
    expect(h.commands).toEqual([]);
  });

  it("rejects default branches and changed checkouts", async () => {
    const h = await harness();
    for (const update of [{ isDefaultBranch: true }, { branch: "other" }]) {
      h.setStatus({ ...status, ...update });
      await Effect.runPromise(h.recovery.sweep);
    }
    expect(h.commands).toEqual([]);
  });
});
