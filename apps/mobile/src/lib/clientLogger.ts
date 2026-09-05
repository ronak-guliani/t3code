/**
 * Central sink for client-side error/warning reports.
 *
 * Call sites previously called `console.error`/`console.warn` directly with
 * ad-hoc tags, leaving no seam for sampling, redaction, or telemetry.
 * Route new reports through here: output still lands in the console today,
 * and a future telemetry integration only needs `setClientLogHandler`.
 */
export interface ClientLogEvent {
  readonly level: "error" | "warning";
  readonly args: ReadonlyArray<unknown>;
  readonly at: string;
}

export type ClientLogHandler = (event: ClientLogEvent) => void;

let handler: ClientLogHandler | null = null;

export function setClientLogHandler(next: ClientLogHandler | null): void {
  handler = next;
}

function emit(level: ClientLogEvent["level"], args: Array<unknown>): void {
  if (level === "error") {
    console.error(...args);
  } else {
    console.warn(...args);
  }
  handler?.({ level, args, at: new Date().toISOString() });
}

export function reportClientError(...args: Array<unknown>): void {
  emit("error", args);
}

export function reportClientWarning(...args: Array<unknown>): void {
  emit("warning", args);
}
