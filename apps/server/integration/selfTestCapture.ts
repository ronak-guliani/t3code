import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Effect } from "effect";
import type { Browser, BrowserContext, Page, Request } from "playwright";
import {
  type SelfTestIssue,
  type SelfTestStage,
  type SelfTestDiagnostics,
  type SelfTestMedia,
} from "../../../scripts/lib/selfTestEvidence.ts";
import { inspectMediaIntegrity } from "../../../scripts/lib/mediaIntegrity.ts";
import { writeDurableFile } from "../../../scripts/lib/durableFile.ts";

export class SelfTestPreflightError extends Error {
  readonly issue: SelfTestIssue;

  constructor(issue: SelfTestIssue) {
    super(issue.message);
    this.name = "SelfTestPreflightError";
    this.issue = issue;
  }
}

export async function recordSelfTestStage(
  output: string | undefined,
  stage: SelfTestStage,
  details: { readonly scenarios?: ReadonlyArray<string>; readonly issue?: SelfTestIssue } = {},
): Promise<void> {
  if (!output) return;
  await mkdir(output, { recursive: true });
  const path = join(output, "lifecycle.json");
  await writeDurableFile(
    path,
    `${JSON.stringify({
      stage,
      ...(details.scenarios ? { scenarios: details.scenarios } : {}),
      ...(details.issue
        ? stage === "blocked"
          ? { blocker: details.issue }
          : { failure: details.issue }
        : {}),
    })}\n`,
  );
}

export async function preflightSelfTestEnvironment(input: {
  readonly baseDirectory: string;
  readonly configuredBaseDirectory: string;
  readonly runtimeStatePath: string;
  readonly staticDirectory: string | undefined;
  readonly origin: string;
}): Promise<void> {
  const baseDirectory = resolve(input.baseDirectory);
  if (baseDirectory !== resolve(input.configuredBaseDirectory)) {
    throw new SelfTestPreflightError({
      type: "environment-mismatch",
      message: "The self-test server base directory does not match its configured environment.",
      action: "Use one isolated base directory for server startup and the self-test.",
    });
  }
  const runtimeStatePath = resolve(input.runtimeStatePath);
  const relativeRuntimeState = relative(baseDirectory, runtimeStatePath);
  if (
    relativeRuntimeState.startsWith("..") ||
    relativeRuntimeState === ".." ||
    relativeRuntimeState.startsWith("/")
  ) {
    throw new SelfTestPreflightError({
      type: "environment-mismatch",
      message: "The server runtime state is outside the self-test base directory.",
      action: "Start the server with the same isolated base directory used by the smoke test.",
    });
  }
  if (!input.staticDirectory) {
    throw new SelfTestPreflightError({
      type: "web-target-invalid",
      message: "No web static target is configured for the self-test server.",
      action: "Build the web app or configure T3_SELF_TEST_WEB_TARGET before rerunning.",
    });
  }
  const staticDirectory = resolve(input.staticDirectory);
  try {
    await access(join(staticDirectory, "index.html"));
  } catch {
    throw new SelfTestPreflightError({
      type: "web-target-missing",
      message: `The configured web target is missing index.html: ${staticDirectory}.`,
      action: "Build the web app and verify the configured static target before rerunning.",
    });
  }

  let backendResponse: Response;
  try {
    backendResponse = await fetch(`${input.origin}/api/auth/session`);
  } catch {
    throw new SelfTestPreflightError({
      type: "backend-unhealthy",
      message: `The self-test backend is not reachable at ${input.origin}.`,
      action: "Verify the isolated server is healthy before creating pairing credentials.",
    });
  }
  if (backendResponse.status !== 200 && backendResponse.status !== 401) {
    throw new SelfTestPreflightError({
      type: "backend-unhealthy",
      message: `The self-test backend returned HTTP ${backendResponse.status}.`,
      action: "Inspect server diagnostics and fix backend readiness before rerunning.",
    });
  }

  let appResponse: Response;
  try {
    appResponse = await fetch(input.origin);
  } catch {
    throw new SelfTestPreflightError({
      type: "app-not-served",
      message: `The expected web app is not served at ${input.origin}.`,
      action: "Verify the static target and server web configuration before rerunning.",
    });
  }
  const contentType = appResponse.headers.get("content-type") ?? "";
  const body = await appResponse.text();
  if (
    appResponse.status !== 200 ||
    !contentType.includes("text/html") ||
    !body.includes('id="root"')
  ) {
    throw new SelfTestPreflightError({
      type: "app-not-served",
      message: `The expected T3 Code app was not served at ${input.origin}.`,
      action: "Verify the web target contains the built T3 Code app before rerunning.",
    });
  }
}

export function createSelfTestContext(
  browser: Browser,
  output: string | undefined,
  diagnostics: SelfTestDiagnostics,
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      if (output) await mkdir(output, { recursive: true });
      return browser.newContext({
        viewport: { width: 1280, height: 800 },
        ...(output
          ? { recordVideo: { dir: join(output, "raw"), size: { width: 1280, height: 800 } } }
          : {}),
      });
    }),
    (context) => Effect.promise(() => closeSelfTestContext(context, output, diagnostics)),
  );
}

export async function closeSelfTestContext(
  context: Pick<BrowserContext, "close">,
  output: string | undefined,
  diagnostics: SelfTestDiagnostics,
) {
  const failures: unknown[] = [];
  try {
    await context.close();
  } catch (error) {
    failures.push(error);
  }
  if (output) {
    try {
      await writeFile(join(output, "diagnostics.json"), JSON.stringify(diagnostics), {
        mode: 0o600,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Browser shutdown and diagnostics persistence failed.");
  }
}

export function trackSelfTestRequests(
  page: Page,
  origin: string,
  diagnostics: { failedRequests: number },
  expectingRejectedToken: () => boolean,
) {
  const failures: string[] = [];
  const inFlight = new Set<Request>();
  const navigationAborts = new WeakSet<Request>();
  const acknowledgedTraceExports = new WeakSet<Request>();
  let navigationPending = false;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      for (const pending of inFlight) navigationAborts.add(pending);
    }
    inFlight.add(request);
    if (navigationPending) navigationAborts.add(request);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigationPending = false;
  });
  page.on("requestfinished", (request) => inFlight.delete(request));
  page.on("requestfailed", (request) => {
    inFlight.delete(request);
    if (
      (navigationAborts.has(request) || acknowledgedTraceExports.has(request)) &&
      request.failure()?.errorText === "net::ERR_ABORTED"
    )
      return;
    failures.push(
      `${request.failure()?.errorText ?? "request failed"} ${new URL(request.url()).pathname}`,
    );
    diagnostics.failedRequests += 1;
  });
  page.on("response", (response) => {
    // The scoped tracing client cancels its fetch after the server's no-content acknowledgement.
    if (
      response.status() === 204 &&
      response.url() === `${origin}/api/observability/v1/traces` &&
      response.request().method() === "POST"
    )
      acknowledgedTraceExports.add(response.request());
    if (response.status() < 400) return;
    if (
      expectingRejectedToken() &&
      response.status() === 401 &&
      response.url() === `${origin}/api/auth/bootstrap` &&
      response.request().method() === "POST"
    )
      return;
    failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
    diagnostics.failedRequests += 1;
  });
  const navigate = async <T>(action: () => Promise<T>): Promise<T> => {
    for (const request of inFlight) navigationAborts.add(request);
    navigationPending = true;
    try {
      return await action();
    } finally {
      navigationPending = false;
    }
  };
  return { failures, navigate };
}

export function trackSelfTestConsole(
  page: Page,
  origin: string,
  diagnostics: { consoleErrors: number; expectedConsoleErrors: number },
  phase: () => "pairing" | "rejected-token" | "authenticated",
) {
  const websocketUrl = new URL("/ws", origin);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const expected =
      message.args().length === 0 &&
      ((phase() === "rejected-token" &&
        message.location().url === `${origin}/api/auth/bootstrap` &&
        message.text() ===
          "Failed to load resource: the server responded with a status of 401 (Unauthorized)") ||
        (phase() !== "authenticated" &&
          message.text() ===
            `WebSocket connection to '${websocketUrl}' failed: HTTP Authentication failed; no valid credentials available`));
    if (expected) diagnostics.expectedConsoleErrors += 1;
    else diagnostics.consoleErrors += 1;
  });
}

export async function inspectSelfTestMedia(page: Page, bytes: Buffer, recording: boolean) {
  return inspectMediaIntegrity(page, bytes, recording ? "video/webm" : "image/png");
}

export async function captureSelfTestScreenshot(
  page: Page,
  output: string,
  file = "authenticated.png",
): Promise<SelfTestMedia> {
  if (new URL(page.url()).hash || new URL(page.url()).searchParams.has("token")) {
    throw new Error("Refusing to capture a page with pairing credentials in its URL.");
  }
  await mkdir(output, { recursive: true });
  const bytes = await page.screenshot({ path: join(output, file), animations: "disabled" });
  const probe = await inspectSelfTestMedia(page, bytes, false);
  return {
    kind: "screenshot",
    file,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...probe,
  };
}

export async function finishSelfTestCapture(
  browser: Browser,
  output: string,
  videoPath: string,
  screenshots: ReadonlyArray<SelfTestMedia>,
  scenarios: ReadonlyArray<string>,
  diagnostics: SelfTestDiagnostics,
): Promise<void> {
  const file = "pairing-reload.webm";
  await copyFile(videoPath, join(output, file));
  const bytes = await readFile(join(output, file));
  const verifier = await browser.newPage();
  try {
    const probe = await inspectSelfTestMedia(verifier, bytes, true);
    const recording: SelfTestMedia = {
      kind: "recording",
      file,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...probe,
    };
    await writeFile(
      join(output, "capture.json"),
      JSON.stringify(
        {
          scenarios,
          media: [...screenshots, recording],
          diagnostics,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    await verifier.close();
  }
}
