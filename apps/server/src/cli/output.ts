import { Cause, Console, Effect, Option } from "effect";
import { CliError } from "effect/unstable/cli";

export const reportCliFailure = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void;
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (CliError.isCliError(error) && error._tag === "ShowHelp") {
    if (error.errors.length === 0) return Effect.void;
    return Console.error(
      JSON.stringify({
        error: {
          code: "CLI_INVALID_ARGUMENT",
          message: error.errors.map((failure) => failure.message).join(" "),
        },
      }),
    );
  }
  const code =
    typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : "CLI_EXECUTION_FAILED";
  const message = error instanceof Error ? error.message : "CLI execution failed.";
  return Console.error(JSON.stringify({ error: { code, message } }));
};
