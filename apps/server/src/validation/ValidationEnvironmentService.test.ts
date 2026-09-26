import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import {
  ValidationEnvironmentService,
  ValidationEnvironmentServiceLive,
  validationEnvironmentStateDirectory,
} from "./ValidationEnvironmentService.ts";

const environmentId = "environment-1";

const html = `<!doctype html><html><head><title>T3 Code (Alpha)</title></head><body>
  <div id="root"><div aria-label="T3 Code splash screen"></div></div>
</body></html>`;

async function startReadinessServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/t3/environment") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          environmentId,
          label: "Validation",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.23",
          capabilities: {},
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Readiness server did not bind a port.");
  }
  return { server, port: address.port };
}

describe("ValidationEnvironmentService", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    server = undefined;
  });

  it("isolates persisted environment state by the full captured target", () => {
    const baseDir = "/tmp/t3-validation-service";
    const target = {
      workspaceRoot: baseDir,
      worktreePath: "/workspace/.worktree",
      branch: "main",
      revision: "revision-1",
      dirtyStateFingerprint: "dirty-1",
      environmentIdentity: environmentId,
    };
    const sameTarget = validationEnvironmentStateDirectory(baseDir, target);
    const differentRevision = validationEnvironmentStateDirectory(baseDir, {
      ...target,
      revision: "revision-2",
    });
    const differentWorktree = validationEnvironmentStateDirectory(baseDir, {
      ...target,
      worktreePath: "/workspace/.other-worktree",
    });

    expect(differentRevision).not.toBe(sameTarget);
    expect(differentWorktree).not.toBe(sameTarget);
  });

  it("blocks when the server cannot launch the captured validation target", async () => {
    const started = await startReadinessServer();
    server = started.server;
    const baseDir = await mkdtemp(join(tmpdir(), "t3-validation-service-"));
    const layers = Layer.mergeAll(
      Layer.succeed(ServerConfig, {
        baseDir,
        port: started.port,
        cwd: baseDir,
      } as ServerConfigShape),
      Layer.succeed(ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(environmentId)),
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make(environmentId),
          label: "Validation",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.23",
          capabilities: { repositoryIdentity: true },
        } satisfies ExecutionEnvironmentDescriptor),
      }),
    );
    const target = {
      workspaceRoot: baseDir,
      worktreePath: null,
      branch: "main",
      revision: "revision-1",
      dirtyStateFingerprint: "dirty-1",
      environmentIdentity: environmentId,
    };

    const acquireWithFreshManager = () =>
      Effect.runPromise(
        Effect.flatMap(ValidationEnvironmentService, (service) => service.acquire(target)).pipe(
          Effect.provide(Layer.provide(ValidationEnvironmentServiceLive, layers)),
        ),
      );

    await expect(acquireWithFreshManager()).rejects.toMatchObject({
      code: "launch-failed",
    });
  });
});
