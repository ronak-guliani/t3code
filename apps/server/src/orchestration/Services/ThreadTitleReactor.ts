import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface ThreadTitleReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class ThreadTitleReactor extends Context.Service<
  ThreadTitleReactor,
  ThreadTitleReactorShape
>()("t3/orchestration/Services/ThreadTitleReactor") {}
