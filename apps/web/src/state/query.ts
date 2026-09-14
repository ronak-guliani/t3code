import * as Cause from "effect/Cause";

export function formatEnvironmentQueryError(cause: Cause.Cause<unknown>): string {
  return Cause.pretty(cause);
}
