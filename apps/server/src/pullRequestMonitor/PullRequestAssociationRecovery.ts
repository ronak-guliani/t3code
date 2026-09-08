import { CommandId, type OrchestrationThread, type ThreadId } from "@t3tools/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { GitManager } from "../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

// A branch match alone is not association intent. Require an unambiguous PR URL
// reported by the assistant, then independently verify it against the checkout.
export function reportedPullRequestUrl(
  thread: Pick<OrchestrationThread, "messages">,
): string | null {
  const message = thread.messages.findLast(
    (entry) => entry.role === "assistant" && !entry.streaming,
  );
  if (!message) return null;
  const urls = new Set(
    Array.from(
      message.text.matchAll(
        /(?<=^|[\s(<"'`])https:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*(?=$|[\s)>"'`\]?#.,])/g,
      ),
      (match) => match[0],
    ),
  );
  return urls.size === 1 ? (urls.values().next().value ?? null) : null;
}

export const makePullRequestAssociationRecovery = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const git = yield* GitManager;

  const recover = Effect.fn("recoverPullRequestAssociation")(function* (threadId: ThreadId) {
    const snapshot = yield* engine.getReadModel();
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (!thread || thread.deletedAt || thread.archivedAt || thread.pullRequest) return;
    const reference = reportedPullRequestUrl(thread);
    if (!reference) return;
    const cwd = resolveThreadWorkspaceCwd({ thread, projects: snapshot.projects });
    if (!cwd) return;

    yield* git.invalidateStatus(cwd);
    const status = yield* git.status({ cwd });
    if (
      !status.pr ||
      status.pr.url !== reference ||
      status.isDefaultBranch ||
      status.branch !== thread.branch ||
      status.pr.headBranch !== thread.branch
    ) {
      return;
    }
    // Serialized dispatch checks the snapshot version: explicit associations,
    // workspace handoffs, and archival that race the lookup always win.
    yield* engine.dispatch({
      type: "thread.meta.update",
      commandId: CommandId.make(`server:recover-pr:${crypto.randomUUID()}`),
      threadId,
      expectedUpdatedAt: thread.updatedAt,
      expectedWorkspaceCwd: cwd,
      pullRequest: status.pr,
    });
  });

  const sweep = Effect.gen(function* () {
    const snapshot = yield* engine.getReadModel();
    const candidates = snapshot.threads.filter(
      (thread) =>
        !thread.deletedAt &&
        !thread.archivedAt &&
        !thread.pullRequest &&
        reportedPullRequestUrl(thread) !== null,
    );
    yield* Effect.forEach(candidates, (thread) => recoverSafely(thread.id), {
      concurrency: 4,
      discard: true,
    });
  });
  const recoverSafely = (threadId: ThreadId) =>
    recover(threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("PR association recovery failed; retrying on the next sweep", {
          threadId,
          error: error._tag,
        }),
      ),
    );

  return { recover, recoverSafely, sweep };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const recovery = yield* makePullRequestAssociationRecovery;
    const subscription = yield* engine.acquireDomainEventSubscription;
    yield* Effect.forkScoped(
      Stream.forever(Stream.fromEffect(PubSub.take(subscription))).pipe(
        Stream.runForEach((event) =>
          event.type === "thread.message-sent" &&
          event.payload.role === "assistant" &&
          !event.payload.streaming
            ? recovery.recoverSafely(event.payload.threadId)
            : Effect.void,
        ),
      ),
    );
    // Persisted messages are the retry source, including after a server restart.
    yield* Effect.forkScoped(
      Effect.forever(recovery.sweep.pipe(Effect.andThen(Effect.sleep("60 seconds")))),
    );
  }),
);
