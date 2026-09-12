import { Console, Effect } from "effect";
import { discoverLocalEnvironments } from "@t3tools/shared/localEnvironment";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBaseDir } from "../os-jank.ts";

export const hostSetupLocation = (explicitBaseDir: string | undefined, home = homedir()) =>
  Effect.gen(function* () {
    if (explicitBaseDir?.trim())
      return {
        kind: "explicit" as const,
        baseDir: yield* resolveBaseDir(explicitBaseDir),
      };
    const proposedBaseDir = join(home, ".t3");
    const discovered = yield* Effect.tryPromise(() =>
      discoverLocalEnvironments([proposedBaseDir], home),
    );
    return {
      kind: "choose" as const,
      selectionError: discovered.selectionError,
      choices: [
        ...discovered.environments.map((environment) => ({
          title: `${environment.label} - ${environment.baseDir} (${environment.status})`,
          value: environment.baseDir,
        })),
        ...(discovered.environments.some((environment) => environment.baseDir === proposedBaseDir)
          ? []
          : [{ title: `New host - ${proposedBaseDir}`, value: proposedBaseDir }]),
      ],
    };
  });

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
