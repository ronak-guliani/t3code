import {
  type ChatAttachment,
  CommandId,
  type OrchestrationEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Cause, Effect, Layer, Option, PubSub, Semaphore, Stream, SynchronizedRef } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadTitleReactor,
  type ThreadTitleReactorShape,
} from "../Services/ThreadTitleReactor.ts";

type ThreadTitleEvent = Extract<
  OrchestrationEvent,
  { type: "thread.meta-updated" | "thread.turn-start-requested" }
>;
type ThreadTitleRegenerationEvent = Extract<ThreadTitleEvent, { type: "thread.meta-updated" }>;
type FirstTurnTitleEvent = Extract<ThreadTitleEvent, { type: "thread.turn-start-requested" }>;

const DEFAULT_THREAD_TITLE = "New thread";
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";
const MAX_CONCURRENT_FIRST_TURN_TITLES = 4;
const MAX_QUEUED_FIRST_TURN_TITLES = 64;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

function formatThreadTitleContext(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }>,
): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    if (message.role === "system") {
      continue;
    }
    const text = message.text.trim();
    const attachmentSummary = (message.attachments ?? [])
      .map((attachment) => attachment.name)
      .join(", ");
    const contents = [
      ...(text.length > 0 ? [text] : []),
      ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
    ].join("\n");
    if (contents.length === 0) {
      continue;
    }

    const section = `${message.role.toUpperCase()}:\n${contents}`;
    const separator = context.length > 0 ? "\n\n" : "";
    const available = MAX_THREAD_TITLE_CONTEXT_CHARS - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return {
    message: truncated ? `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${context}` : context,
    attachments: retainedAttachments.slice(-MAX_REGENERATION_ATTACHMENTS),
  };
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

export const makeThreadTitleReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const threadLocks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());

  const getThreadLock = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(threadLocks, (current) => {
      const existing = Option.fromNullishOr(current.get(threadId));
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(threadId, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });

  const resolveThread = (threadId: ThreadId) =>
    orchestrationEngine
      .getReadModel()
      .pipe(Effect.map((readModel) => readModel.threads.find((thread) => thread.id === threadId)));

  const dispatchCompletion = Effect.fn("dispatchThreadTitleRegenerationCompletion")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly title?: string;
    }) {
      yield* orchestrationEngine.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: serverCommandId("thread-title-regeneration-complete"),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.title !== undefined ? { title: input.title } : {}),
      });
    },
  );

  const regenerate = Effect.fn("regenerateThreadTitle")(function* (
    event: ThreadTitleRegenerationEvent,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: (yield* orchestrationEngine.getReadModel()).projects,
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (
      !generated ||
      generated.title === DEFAULT_THREAD_TITLE ||
      generated.title === previousTitle
    ) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThread(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });

  const generateFirstTurnTitle = Effect.fn("generateFirstTurnTitle")(function* (
    event: FirstTurnTitleEvent,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || !canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
      return;
    }
    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (
      !message ||
      message.role !== "user" ||
      thread.messages.filter((entry) => entry.role === "user").length !== 1
    ) {
      return;
    }

    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: (yield* orchestrationEngine.getReadModel()).projects,
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const attachments = message.attachments ?? [];
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message: message.text,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (!generated) {
      return;
    }

    const latestThread = yield* resolveThread(event.payload.threadId);
    if (!latestThread || !canReplaceThreadTitle(latestThread.title, event.payload.titleSeed)) {
      return;
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: serverCommandId("thread-title-rename"),
      threadId: event.payload.threadId,
      title: generated.title,
    });
  });

  const processEvent = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: ThreadTitleEvent) {
      if (event.type === "thread.turn-start-requested") {
        yield* generateFirstTurnTitle(event);
        return;
      }
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerate(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("thread title reactor failed to regenerate title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("thread title reactor retrying regeneration completion", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.andThen(dispatchCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("thread title reactor failed to process title event", {
            threadId: event.payload.threadId,
            eventType: event.type,
            cause: Cause.pretty(cause),
          });
        }),
      ),
  );
  const regenerationWorker = yield* makeDrainableWorker(processEvent);
  const firstTurnWorker = yield* makeDrainableWorker(
    (event: FirstTurnTitleEvent) =>
      Effect.flatMap(getThreadLock(event.payload.threadId), (threadLock) =>
        threadLock.withPermit(
          processEvent(event).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("thread title reactor first-turn task failed", {
                    threadId: event.payload.threadId,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        ),
      ),
    {
      capacity: MAX_QUEUED_FIRST_TURN_TITLES,
      concurrency: MAX_CONCURRENT_FIRST_TURN_TITLES,
    },
  );

  const clearInterruptedRegenerations = Effect.fn("clearInterruptedThreadTitleRegenerations")(
    function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const interrupted = readModel.threads.flatMap((thread) => {
        const requestId = thread.titleRegeneration?.requestId;
        return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
      });
      yield* Effect.forEach(
        interrupted,
        ({ threadId, requestId }) =>
          dispatchCompletion({ threadId, requestId }).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.interrupt;
              }
              return Effect.logWarning(
                "thread title reactor failed to clear interrupted regeneration",
                {
                  threadId,
                  cause: Cause.pretty(cause),
                },
              );
            }),
          ),
        { discard: true },
      );
    },
  );

  const start: ThreadTitleReactorShape["start"] = Effect.fn("start")(function* () {
    const subscription = yield* orchestrationEngine.acquireDomainEventSubscription;
    yield* Effect.forkScoped(
      Stream.forever(Stream.fromEffect(PubSub.take(subscription))).pipe(
        Stream.runForEach((event) =>
          event.type === "thread.turn-start-requested"
            ? firstTurnWorker.enqueue(event)
            : event.type === "thread.meta-updated" && event.payload.regenerateTitle === true
              ? regenerationWorker.enqueue(event)
              : Effect.void,
        ),
      ),
    );
    // Requests committed before startup cannot be resumed. Each completion is
    // correlated to its captured request and cannot clear a newer one.
    yield* clearInterruptedRegenerations();
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* regenerationWorker.drain;
      yield* firstTurnWorker.drain;
    }),
  } satisfies ThreadTitleReactorShape;
});

export const ThreadTitleReactorLive = Layer.effect(ThreadTitleReactor, makeThreadTitleReactor);
