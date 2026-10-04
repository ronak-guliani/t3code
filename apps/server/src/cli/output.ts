import { Cause, Console, Effect, Option } from "effect";
import { CliError } from "effect/unstable/cli";

let pendingHelpDocument: string | undefined;
let originalStdoutWrite: typeof process.stdout.write | undefined;
const ANSI_FORMATTING = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const takePendingHelpDocument = (): string | undefined => {
  const text = pendingHelpDocument;
  pendingHelpDocument = undefined;
  return text;
};

const writeHelpDocument = (text: string, errorsPresent: boolean): void => {
  const formatted = text.endsWith("\n") ? text : `${text}\n`;
  if (errorsPresent) {
    process.stderr.write(formatted);
  } else if (originalStdoutWrite) {
    originalStdoutWrite(formatted);
  } else {
    process.stdout.write(formatted);
  }
};

/** Hold parser-generated help until we know whether it describes an error. */
export const installCliOutputRouting = (): void => {
  if (originalStdoutWrite !== undefined) return;
  const stdout = process.stdout;
  originalStdoutWrite = stdout.write.bind(stdout);
  stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const helpText = text.replace(ANSI_FORMATTING, "");
    if (helpText.includes("DESCRIPTION") && helpText.includes("USAGE")) {
      pendingHelpDocument = text;
      if (typeof encodingOrCallback === "function") encodingOrCallback();
      else callback?.();
      return true;
    }
    return typeof encodingOrCallback === "function"
      ? originalStdoutWrite!(chunk, encodingOrCallback)
      : originalStdoutWrite!(chunk, encodingOrCallback, callback);
  }) as typeof stdout.write;
};

export const flushPendingCliHelp = (): void => {
  const helpDocument = takePendingHelpDocument();
  if (helpDocument !== undefined) writeHelpDocument(helpDocument, false);
};

export const reportCliFailure = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void;
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (CliError.isCliError(error) && error._tag === "ShowHelp") {
    const helpDocument = takePendingHelpDocument();
    if (helpDocument !== undefined) writeHelpDocument(helpDocument, error.errors.length > 0);
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
