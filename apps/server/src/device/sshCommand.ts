import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

interface SshTarget {
  readonly alias: string;
  readonly port: number | null;
}

export class SshCommandError extends Data.TaggedError("SshCommandError")<{
  readonly message: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout?: string;
  readonly cause?: unknown;
}> {}

export const resolveSshCommand = Effect.map(HostProcessPlatform, (platform) =>
  platform === "win32" ? "ssh.exe" : "ssh",
);

export const baseSshArgs = (
  target: SshTarget,
  input: { readonly batchMode?: "yes" | "no" } = {},
): string[] => [
  "-o",
  `BatchMode=${input.batchMode ?? "yes"}`,
  "-o",
  "ConnectTimeout=10",
  ...(target.port === null ? [] : ["-p", String(target.port)]),
];

const diagnostic = (value: string) =>
  value
    .replace(/("(?:token|credential|bearerToken)"\s*:\s*")[^"]*"/giu, '$1[redacted]"')
    .slice(-4000);

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (output, chunk) => (output + chunk).slice(-1024 * 1024),
    ),
  );

export const runSshCommand = Effect.fn("device.runSshCommand")(function* (
  target: SshTarget,
  input: {
    readonly preHostArgs?: ReadonlyArray<string>;
    readonly remoteCommandArgs?: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly timeoutMs?: number;
  } = {},
) {
  const ssh = yield* resolveSshCommand;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(
        ssh,
        [
          ...baseSshArgs(target),
          ...(input.preHostArgs ?? []),
          target.alias,
          ...(input.remoteCommandArgs ?? []),
        ],
        {
          stdin: {
            stream:
              input.stdin === undefined
                ? Stream.empty
                : Stream.make(new TextEncoder().encode(input.stdin)),
            endOnDone: true,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collect(child.stdout), collect(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new SshCommandError({
        message: diagnostic(stderr.trim()) || `SSH exited with code ${exitCode}.`,
        stdout: diagnostic(stdout),
        stderr: diagnostic(stderr),
        exitCode: Number(exitCode),
      });
    }
    return { stdout, stderr };
  }).pipe(
    Effect.timeout(input.timeoutMs ?? 60_000),
    Effect.scoped,
    Effect.mapError((cause) =>
      cause instanceof SshCommandError
        ? cause
        : new SshCommandError({
            message: "SSH command failed or timed out. Check SSH access from this environment.",
            stderr: "",
            exitCode: null,
            cause,
          }),
    ),
  );
});
