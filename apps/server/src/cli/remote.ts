import { RemoteAccessStatus } from "@t3tools/contracts";
import { Console, Effect, Option, Redacted, Schema } from "effect";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { resolveBaseDir } from "../os-jank.ts";
import { withBorrowedBearerToken, printJson } from "./client.ts";
import { inspectRuntimeOwnership } from "./installation.ts";
import { ensureBackgroundServiceForBaseDir } from "./service.ts";

const baseDir = Flag.string("base-dir").pipe(Flag.optional);

const ensureRemoteSetupHost = (resolvedBaseDir: string) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.tryPromise(() => inspectRuntimeOwnership(resolvedBaseDir));
    if (runtime.state === "running" && runtime.owner !== "background") return;
    const outcome = yield* ensureBackgroundServiceForBaseDir(resolvedBaseDir, {
      restartRequired: runtime.state === "stopped",
    });
    if (outcome !== "ready") {
      yield* Console.log(
        outcome === "installed"
          ? "No T3 host was running, so the background service was installed and started."
          : outcome === "repaired"
            ? "The background service was repaired and started."
            : "The background service was restarted.",
      );
    }
  });

export const remoteRequest = (baseDir: Option.Option<string>, body?: object) =>
  withBorrowedBearerToken(
    { baseDir, url: Option.none(), token: Option.none(), environment: Option.none() },
    ({ origin, bearerToken }) =>
      Effect.gen(function* () {
        const request = body
          ? HttpClientRequest.post(`${origin}/api/remote-access`).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
            )
          : HttpClientRequest.get(`${origin}/api/remote-access`);
        const response = yield* HttpClient.execute(
          request.pipe(HttpClientRequest.bearerToken(bearerToken)),
        ).pipe(
          Effect.mapError(
            () => new Error("Could not contact the local T3 server. Check `t3 service status`."),
          ),
        );
        if (response.status !== 200) {
          const error = yield* HttpClientResponse.schemaBodyJson(
            Schema.Struct({ error: Schema.String }),
          )(response);
          return yield* Effect.fail(new Error(error.error));
        }
        return yield* HttpClientResponse.schemaBodyJson(RemoteAccessStatus)(response);
      }).pipe(Effect.timeout("30 seconds")),
  ).pipe(Effect.provide(FetchHttpClient.layer));

const setup = Command.make("setup", { baseDir }).pipe(
  Command.withDescription(
    "Start this host if needed and configure its permanent Cloudflare Tunnel.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resolvedBaseDir = yield* resolveBaseDir(
        Option.getOrUndefined(flags.baseDir) ?? process.env.T3CODE_HOME,
      );
      yield* ensureRemoteSetupHost(resolvedBaseDir);
      const targetBaseDir = Option.some(resolvedBaseDir);
      yield* remoteRequest(targetBaseDir);
      yield* Console.log(
        [
          "Create a named Cloudflare Tunnel and public HTTPS hostname in your own account.",
          "Route it to this T3 server's fixed loopback HTTP port. Do not run a second connector.",
          "T3 will store the token host-side and supervise the connector. Cloudflare carries your app traffic.",
          "Only paired devices can access T3. Keep this host awake; setup starts the background service when no other T3 process owns it.",
        ].join("\n"),
      );
      const publicUrl = yield* Prompt.run(Prompt.text({ message: "Permanent HTTPS URL" }));
      const token = yield* Prompt.run(Prompt.password({ message: "Tunnel token (hidden)" }));
      const result = yield* remoteRequest(targetBaseDir, {
        action: "setup",
        publicUrl,
        connectorToken: Redacted.value(token),
      });
      yield* printJson(result);
      yield* Console.log(
        "Run `t3 remote status` until ready, then `t3 pair --remote` for each device.",
      );
    }),
  ),
);

const status = Command.make("status", { baseDir }).pipe(
  Command.withDescription("Show remote endpoint health without exposing credentials."),
  Command.withHandler((flags) => remoteRequest(flags.baseDir).pipe(Effect.flatMap(printJson))),
);

const action = (action: "enable" | "disable") =>
  Command.make(action, { baseDir }).pipe(
    Command.withDescription(
      `${action === "enable" ? "Enable" : "Disable"} this host's owned tunnel.`,
    ),
    Command.withHandler((flags) =>
      remoteRequest(flags.baseDir, { action }).pipe(Effect.flatMap(printJson)),
    ),
  );

export const remoteCommand = Command.make("remote").pipe(
  Command.withDescription("Manage owned remote access without a phone VPN or cloud sign-in."),
  Command.withSubcommands([setup, status, action("enable"), action("disable")]),
);
