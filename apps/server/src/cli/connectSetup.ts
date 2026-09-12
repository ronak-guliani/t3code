import { Console, Effect } from "effect";

export type SetupStage = "preflight" | "account" | "relay-client" | "server" | "provisioning";

export function setupStage<A, E, R>(stage: SetupStage, effect: Effect.Effect<A, E, R>) {
  return Console.log(`Setup: ${stage}`).pipe(
    Effect.andThen(effect),
    Effect.mapError(
      (cause) =>
        new Error(
          `Setup stopped at '${stage}'. Completed stages are retained. Rerun the same executable with connect --role host and the same --base-dir to resume.`,
          { cause },
        ),
    ),
  );
}

export const runConnectSetup = <E, R>(input: {
  readonly role: "host" | "client";
  readonly client: Effect.Effect<void, E, R>;
  readonly host: Effect.Effect<void, E, R>;
}) => (input.role === "client" ? input.client : input.host);
