import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface IdleTerminalReaperShape {
  /** Stop process groups persisted by previous server instances when safe. */
  readonly reconcileStartup: Effect.Effect<void>;
  /** Start the bounded five-minute idle-terminal sweep. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class IdleTerminalReaper extends Context.Service<
  IdleTerminalReaper,
  IdleTerminalReaperShape
>()("t3/terminal/Services/IdleTerminalReaper") {}
