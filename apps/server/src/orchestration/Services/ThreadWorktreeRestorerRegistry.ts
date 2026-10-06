import { Context, Effect, Layer, Ref } from "effect";
import type { RestoreThreadWorktreeInput } from "../restoreThreadWorktree.ts";

export type ThreadWorktreeRestorer = (
  input: RestoreThreadWorktreeInput,
) => Effect.Effect<void, Error>;

/** Breaks the engine/setup-runner dependency cycle while sharing one restore path. */
export class ThreadWorktreeRestorerRegistry extends Context.Service<
  ThreadWorktreeRestorerRegistry,
  {
    readonly register: (restore: ThreadWorktreeRestorer) => Effect.Effect<void>;
    readonly restore: ThreadWorktreeRestorer;
  }
>()("t3/orchestration/Services/ThreadWorktreeRestorerRegistry") {}

export const layer = Layer.effect(
  ThreadWorktreeRestorerRegistry,
  Effect.gen(function* () {
    const registered = yield* Ref.make<ThreadWorktreeRestorer | null>(null);
    return ThreadWorktreeRestorerRegistry.of({
      register: (restore) => Ref.set(registered, restore),
      restore: (input) =>
        Effect.flatMap(Ref.get(registered), (restore) =>
          restore === null
            ? Effect.fail(
                new Error(
                  "Worktree restoration is not available yet; retry after the server has finished starting.",
                ),
              )
            : restore(input),
        ),
    });
  }),
);
