import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { __testing, startMcpHttpServer } from "./mcpServer.ts";

const run = async (command: string, args: ReadonlyArray<string>, cwd: string) => {
  const result = await new Promise<{ readonly code: number | null; readonly stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr }));
    },
  );
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const nestedCliScript = (actualOutcome: Record<string, unknown>, actualExitCode = 0): string => {
  const dryRunOutcome = {
    status: "dry-run",
    threadId: null,
    threadUrl: null,
    retryable: false,
    workspaceCreated: false,
    cleanupPerformed: false,
    errorCode: null,
    message: "Nested-thread inputs are valid; no thread or workspace was created.",
  };
  return `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    if [ -n "$T3_MCP_TEST_DRY_ARGS" ]; then
      printf "%s\\n" "$@" > "$T3_MCP_TEST_DRY_ARGS"
    fi
    printf '%s\\n' ${shellQuote(JSON.stringify(dryRunOutcome))}
    exit 0
  fi
done
if [ -n "$T3_MCP_TEST_ARGS" ]; then
  printf "%s\\n" "$@" > "$T3_MCP_TEST_ARGS"
fi
printf '%s\\n' ${shellQuote(JSON.stringify(actualOutcome))}
exit ${String(actualExitCode)}
`;
};

const createdOutcome = {
  status: "created",
  threadId: "child-1",
  threadUrl: "https://app.example/env/child-1",
  retryable: false,
  workspaceCreated: false,
  cleanupPerformed: false,
  errorCode: null,
  message: "Nested thread created and its first turn was accepted.",
} as const;

const initGitRepository = async (root: string): Promise<void> => {
  await writeFile(path.join(root, "README.md"), "base\n");
  await run("git", ["init", "--initial-branch=main"], root);
  await run("git", ["config", "user.email", "test@example.com"], root);
  await run("git", ["config", "user.name", "T3 Test"], root);
  await run("git", ["add", "README.md"], root);
  await run("git", ["commit", "-m", "initial"], root);
};

describe("MCP Streamable HTTP server", () => {
  it("serves authenticated workspace tools over loopback HTTP", async () => {
    const server = await startMcpHttpServer({
      cwd: process.cwd(),
      toolsets: new Set([
        "create_isolated_workspace",
        "switch_workspace",
        "create_nested_thread",
        "associate_pull_request",
      ]),
      threadId: "thread-1",
      cliCommand: "t3-test",
    });

    try {
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          authorization: server.authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            { name: "create_isolated_workspace" },
            { name: "switch_workspace" },
            { name: "create_nested_thread" },
            { name: "associate_pull_request" },
          ],
        },
      });

      const unauthenticated = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });
      expect(unauthenticated.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("closes active HTTP connections during shutdown", async () => {
    const server = await startMcpHttpServer({
      cwd: process.cwd(),
      toolsets: new Set(),
      threadId: "thread-1",
      cliCommand: "t3-test",
    });
    const { hostname, port } = new URL(server.url);
    const socket = createConnection(Number(port), hostname);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      const socketClosed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      await Promise.all([server.close(), socketClosed]);
    } finally {
      socket.destroy();
    }
  });
});

describe("associate_pull_request MCP tool", () => {
  it("records an explicit PR association on the authenticated current thread", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-associate-pr-"));
    const binDir = path.join(root, "bin");
    const cliPath = path.join(binDir, "t3-test");
    const argsPath = path.join(root, "cli-args.txt");
    const originalArgsPath = process.env.T3_MCP_TEST_ARGS;

    try {
      await mkdir(binDir);
      await writeFile(cliPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$T3_MCP_TEST_ARGS"\n');
      await chmod(cliPath, 0o755);
      process.env.T3_MCP_TEST_ARGS = argsPath;

      await __testing.associatePullRequestTool(
        {
          cwd: root,
          toolsets: new Set(["associate_pull_request"]),
          threadId: "thread-1",
          cliCommand: cliPath,
          cliArgsPrefix: ["server.mjs"],
          cliBaseDir: "/tmp/t3-dev",
        },
        { reference: "https://github.com/acme/repo/pull/42" },
      );

      const cliArgs = (await readFile(argsPath, "utf8")).trim().split("\n");
      expect(cliArgs).toEqual([
        "server.mjs",
        "chat",
        "associate-pr",
        "thread-1",
        "https://github.com/acme/repo/pull/42",
        "--cwd",
        root,
        "--base-dir",
        "/tmp/t3-dev",
      ]);
    } finally {
      if (originalArgsPath === undefined) {
        delete process.env.T3_MCP_TEST_ARGS;
      } else {
        process.env.T3_MCP_TEST_ARGS = originalArgsPath;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects calls without an authenticated current thread", async () => {
    await expect(
      __testing.associatePullRequestTool(
        {
          cwd: process.cwd(),
          toolsets: new Set(["associate_pull_request"]),
          threadId: undefined,
          cliCommand: "t3-test",
        },
        { reference: "#42" },
      ),
    ).rejects.toThrow("only available from a T3 provider session");
  });
});

describe("send_to_thread MCP tool", () => {
  it("sends through the authenticated source thread", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-send-thread-"));
    const cliPath = path.join(root, "t3-test");
    const argsPath = path.join(root, "cli-args.txt");
    const originalArgsPath = process.env.T3_MCP_TEST_ARGS;

    try {
      await writeFile(
        cliPath,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$T3_MCP_TEST_ARGS"\nprintf \'{"ok":true}\\n\'\n',
      );
      await chmod(cliPath, 0o755);
      process.env.T3_MCP_TEST_ARGS = argsPath;

      await expect(
        __testing.sendToThreadTool(
          {
            cwd: root,
            toolsets: new Set(["send_to_thread"]),
            threadId: "source-1",
            cliCommand: cliPath,
            cliArgsPrefix: ["server.mjs"],
            cliBaseDir: "/tmp/t3-dev",
          },
          { thread: "target-1", prompt: "Investigate this." },
        ),
      ).resolves.toBe('{"ok":true}');

      expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
        "server.mjs",
        "chat",
        "send",
        "target-1",
        "Investigate this.",
        "--cross-thread-source",
        "source-1",
        "--cross-thread-capability",
        expect.any(String),
        "--base-dir",
        "/tmp/t3-dev",
      ]);
    } finally {
      if (originalArgsPath === undefined) delete process.env.T3_MCP_TEST_ARGS;
      else process.env.T3_MCP_TEST_ARGS = originalArgsPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("create_nested_thread MCP tool", () => {
  it("accepts any Copilot model slug and makes reasoning optional", () => {
    expect(__testing.availableTools(new Set(["create_nested_thread"]))).toEqual([
      expect.objectContaining({
        name: "create_nested_thread",
        inputSchema: expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            model: expect.objectContaining({
              type: "string",
              minLength: 1,
            }),
            dryRun: { type: "boolean", description: expect.any(String) },
            workspace: expect.objectContaining({
              type: "object",
              required: ["mode", "branch", "path"],
            }),
          }),
          required: ["project", "title", "prompt", "model"],
        }),
      }),
    ]);

    const [tool] = __testing.availableTools(new Set(["create_nested_thread"]));
    expect(tool?.inputSchema.properties?.model).not.toHaveProperty("enum");
  });

  it("creates a flavor-scoped child on the authenticated parent provider instance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-thread-"));
    const cliPath = path.join(root, "t3-test");
    const argsPath = path.join(root, "cli-args.txt");
    const dryArgsPath = path.join(root, "dry-cli-args.txt");
    const originalArgsPath = process.env.T3_MCP_TEST_ARGS;
    const originalDryArgsPath = process.env.T3_MCP_TEST_DRY_ARGS;

    try {
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);
      process.env.T3_MCP_TEST_ARGS = argsPath;
      process.env.T3_MCP_TEST_DRY_ARGS = dryArgsPath;

      const outcome = JSON.parse(
        await __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            cliArgsPrefix: ["server.mjs"],
            cliBaseDir: "/tmp/t3-dev",
            runtimeMode: "approval-required",
            providerInstanceId: ProviderInstanceId.make("copilot-team"),
          },
          {
            project: "project-1",
            title: "Investigate nesting",
            prompt: "Find the root cause.",
            model: "gpt-5.6-terra",
            reasoning: "high",
          },
        ),
      );
      expect(outcome).toEqual({
        ...createdOutcome,
        workspaceCreated: false,
      });

      const dryArgs = (await readFile(dryArgsPath, "utf8")).trim().split("\n");
      expect(dryArgs).toContain("--dry-run");
      expect(dryArgs).not.toContain("--cross-thread-source");
      expect(dryArgs).not.toContain("--cross-thread-capability");
      expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
        "server.mjs",
        "--log-level",
        "error",
        "chat",
        "new",
        "--project",
        "project-1",
        "--parent",
        "parent-1",
        "--cross-thread-source",
        "parent-1",
        "--cross-thread-capability",
        expect.any(String),
        "--provider",
        "copilot-team",
        "--model",
        "gpt-5.6-terra",
        "--reasoning",
        "high",
        "--runtime-mode",
        "approval-required",
        "--title",
        "Investigate nesting",
        "Find the root cause.",
        "--base-dir",
        "/tmp/t3-dev",
      ]);
    } finally {
      if (originalArgsPath === undefined) delete process.env.T3_MCP_TEST_ARGS;
      else process.env.T3_MCP_TEST_ARGS = originalArgsPath;
      if (originalDryArgsPath === undefined) delete process.env.T3_MCP_TEST_DRY_ARGS;
      else process.env.T3_MCP_TEST_DRY_ARGS = originalDryArgsPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits reasoning for Copilot models without a selectable reasoning level", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-thread-"));
    const cliPath = path.join(root, "t3-test");
    const argsPath = path.join(root, "cli-args.txt");
    const originalArgsPath = process.env.T3_MCP_TEST_ARGS;

    try {
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);
      process.env.T3_MCP_TEST_ARGS = argsPath;

      expect(
        JSON.parse(
          await __testing.createNestedThreadTool(
            {
              cwd: root,
              toolsets: new Set(["create_nested_thread"]),
              threadId: "parent-1",
              cliCommand: cliPath,
              runtimeMode: "full-access",
              providerInstanceId: ProviderInstanceId.make("copilot"),
            },
            {
              project: "project-1",
              title: "Investigate nesting",
              prompt: "Find the root cause.",
              model: "claude-opus-5",
            },
          ),
        ),
      ).toEqual(createdOutcome);

      expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
        "--log-level",
        "error",
        "chat",
        "new",
        "--project",
        "project-1",
        "--parent",
        "parent-1",
        "--cross-thread-source",
        "parent-1",
        "--cross-thread-capability",
        expect.any(String),
        "--provider",
        "copilot",
        "--model",
        "claude-opus-5",
        "--runtime-mode",
        "full-access",
        "--title",
        "Investigate nesting",
        "Find the root cause.",
      ]);
    } finally {
      if (originalArgsPath === undefined) delete process.env.T3_MCP_TEST_ARGS;
      else process.env.T3_MCP_TEST_ARGS = originalArgsPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates and binds an isolated child worktree without handing off the parent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-worktree-"));
    const targetPath = `${root}-child-worktree`;
    const cliPath = path.join(root, "t3-test");
    const argsPath = path.join(root, "cli-args.txt");
    const originalArgsPath = process.env.T3_MCP_TEST_ARGS;

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);
      process.env.T3_MCP_TEST_ARGS = argsPath;

      expect(
        JSON.parse(
          await __testing.createNestedThreadTool(
            {
              cwd: root,
              toolsets: new Set(["create_nested_thread"]),
              threadId: "parent-1",
              cliCommand: cliPath,
              cliBaseDir: "/tmp/t3-dev",
              runtimeMode: "full-access",
              providerInstanceId: ProviderInstanceId.make("copilot"),
            },
            {
              project: "project-1",
              title: "Implement nesting",
              prompt: "Complete the implementation.",
              model: "gpt-5.6-sol",
              workspace: {
                mode: "isolated",
                branch: "feature/isolated-child",
                path: targetPath,
                baseRef: "main",
              },
            },
          ),
        ),
      ).toEqual({
        ...createdOutcome,
        workspaceCreated: true,
      });

      const resolvedTargetPath = await realpath(targetPath);
      expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
        "--log-level",
        "error",
        "chat",
        "new",
        "--project",
        "project-1",
        "--parent",
        "parent-1",
        "--cross-thread-source",
        "parent-1",
        "--cross-thread-capability",
        expect.any(String),
        "--provider",
        "copilot",
        "--model",
        "gpt-5.6-sol",
        "--runtime-mode",
        "full-access",
        "--branch",
        "feature/isolated-child",
        "--worktree",
        resolvedTargetPath,
        "--title",
        "Implement nesting",
        "Complete the implementation.",
        "--base-dir",
        "/tmp/t3-dev",
      ]);
      await expect(readFile(path.join(targetPath, "README.md"), "utf8")).resolves.toBe("base\n");
    } finally {
      if (originalArgsPath === undefined) delete process.env.T3_MCP_TEST_ARGS;
      else process.env.T3_MCP_TEST_ARGS = originalArgsPath;
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("removes an isolated child worktree after a definitive creation rejection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-worktree-"));
    const targetPath = `${root}-rejected-child-worktree`;
    const cliPath = path.join(root, "t3-test");

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await writeFile(
        cliPath,
        nestedCliScript(
          {
            status: "failed",
            threadId: null,
            retryable: true,
            workspaceCreated: true,
            cleanupPerformed: false,
            errorCode: "THREAD_CREATE_REJECTED",
            message: "Thread creation was rejected before it committed: child creation failed",
          },
          1,
        ),
      );
      await chmod(cliPath, 0o755);

      expect(
        JSON.parse(
          await __testing.createNestedThreadTool(
            {
              cwd: root,
              toolsets: new Set(["create_nested_thread"]),
              threadId: "parent-1",
              cliCommand: cliPath,
              runtimeMode: "full-access",
              providerInstanceId: ProviderInstanceId.make("copilot"),
            },
            {
              project: "project-1",
              title: "Implement nesting",
              prompt: "Complete the implementation.",
              model: "gpt-5.6-sol",
              workspace: {
                mode: "isolated",
                branch: "feature/rejected-child",
                path: targetPath,
              },
            },
          ),
        ),
      ).toMatchObject({
        status: "failed",
        threadId: null,
        retryable: true,
        workspaceCreated: true,
        cleanupPerformed: true,
        errorCode: "THREAD_CREATE_REJECTED",
      });

      await expect(readFile(targetPath, "utf8")).rejects.toThrow();
      await expect(
        run("git", ["rev-parse", "--verify", "--quiet", "feature/rejected-child"], root),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("reports an occupied child worktree path before launching the CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-worktree-"));
    const targetPath = `${root}-occupied-child-worktree`;
    const cliPath = path.join(root, "t3-test");

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await mkdir(targetPath);
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);

      expect(
        JSON.parse(
          await __testing.createNestedThreadTool(
            {
              cwd: root,
              toolsets: new Set(["create_nested_thread"]),
              threadId: "parent-1",
              cliCommand: cliPath,
              runtimeMode: "full-access",
              providerInstanceId: ProviderInstanceId.make("copilot"),
            },
            {
              project: root,
              title: "Implement nesting",
              prompt: "Complete the implementation.",
              model: "gpt-5.6-sol",
              workspace: {
                mode: "isolated",
                branch: "feature/occupied-child",
                path: targetPath,
              },
            },
          ),
        ),
      ).toMatchObject({
        status: "failed",
        retryable: true,
        workspaceCreated: false,
        cleanupPerformed: false,
        errorCode: "WORKSPACE_PATH_OCCUPIED",
        message: expect.stringContaining("Workspace path is already occupied"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("reports an existing child branch before launching the CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-worktree-"));
    const targetPath = `${root}-branch-collision-child-worktree`;
    const cliPath = path.join(root, "t3-test");

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await run("git", ["branch", "feature/existing-child"], root);
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);

      expect(
        JSON.parse(
          await __testing.createNestedThreadTool(
            {
              cwd: root,
              toolsets: new Set(["create_nested_thread"]),
              threadId: "parent-1",
              cliCommand: cliPath,
              runtimeMode: "full-access",
              providerInstanceId: ProviderInstanceId.make("copilot"),
            },
            {
              project: root,
              title: "Implement nesting",
              prompt: "Complete the implementation.",
              model: "gpt-5.6-sol",
              workspace: {
                mode: "isolated",
                branch: "feature/existing-child",
                path: targetPath,
              },
            },
          ),
        ),
      ).toMatchObject({
        status: "failed",
        retryable: true,
        errorCode: "WORKSPACE_BRANCH_EXISTS",
        message: expect.stringContaining("Workspace branch already exists"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("reports local worktree setup failures as definitive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-worktree-"));
    const targetPath = `${root}-invalid-base-child-worktree`;
    const cliPath = path.join(root, "t3-test");

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);

      expect(
        JSON.parse(
          await __testing.createNestedThreadTool(
            {
              cwd: root,
              toolsets: new Set(["create_nested_thread"]),
              threadId: "parent-1",
              cliCommand: cliPath,
              runtimeMode: "full-access",
              providerInstanceId: ProviderInstanceId.make("copilot"),
            },
            {
              project: root,
              title: "Implement nesting",
              prompt: "Complete the implementation.",
              model: "gpt-5.6-sol",
              workspace: {
                mode: "isolated",
                branch: "feature/invalid-base-child",
                path: targetPath,
                baseRef: "missing-base-ref",
              },
            },
          ),
        ),
      ).toMatchObject({
        status: "failed",
        workspaceCreated: false,
        errorCode: "WORKSPACE_BASE_REF_MISSING",
        message: expect.stringContaining("missing-base-ref"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("keeps command rejections ambiguous after launching child creation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-rejection-"));
    const cliPath = path.join(root, "t3-test");

    try {
      await writeFile(
        cliPath,
        nestedCliScript(
          {
            status: "ambiguous",
            threadId: "child-1",
            retryable: false,
            workspaceCreated: false,
            cleanupPerformed: false,
            errorCode: "TURN_START_AMBIGUOUS",
            message: "The first turn may have committed.",
          },
          1,
        ),
      );
      await chmod(cliPath, 0o755);

      expect(
        JSON.parse(
          await __testing.createNestedThreadTool(
            {
              cwd: root,
              toolsets: new Set(["create_nested_thread"]),
              threadId: "parent-1",
              cliCommand: cliPath,
              runtimeMode: "full-access",
              providerInstanceId: ProviderInstanceId.make("copilot"),
            },
            {
              project: "project-1",
              title: "Implement nesting",
              prompt: "Complete the implementation.",
              model: "gpt-5.6-sol",
            },
          ),
        ),
      ).toMatchObject({
        status: "ambiguous",
        threadId: "child-1",
        retryable: false,
        errorCode: "TURN_START_AMBIGUOUS",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves ambiguity when the CLI response is not the structured contract", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-invalid-response-"));
    const cliPath = path.join(root, "t3-test");

    try {
      await writeFile(
        cliPath,
        nestedCliScript(createdOutcome).replace(
          shellQuote(JSON.stringify(createdOutcome)),
          shellQuote("not-json"),
        ),
      );
      await chmod(cliPath, 0o755);

      const outcome = JSON.parse(
        await __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            runtimeMode: "full-access",
            providerInstanceId: ProviderInstanceId.make("copilot"),
          },
          {
            project: "project-1",
            title: "Invalid response",
            prompt: "Preserve ambiguity.",
            model: "gpt-5.6-sol",
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "ambiguous",
        threadId: null,
        retryable: false,
        workspaceCreated: false,
        cleanupPerformed: false,
        errorCode: "CLI_RESPONSE_INVALID",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a prompt spoof safe child worktree cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-worktree-"));
    const targetPath = `${root}-uncertain-child-worktree`;
    const cliPath = path.join(root, "t3-test");

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await writeFile(
        cliPath,
        nestedCliScript(
          {
            status: "ambiguous",
            threadId: "child-1",
            retryable: false,
            workspaceCreated: true,
            cleanupPerformed: false,
            errorCode: "THREAD_CREATE_AMBIGUOUS",
            message: "Creation may have committed; preserve the workspace.",
          },
          1,
        ),
      );
      await chmod(cliPath, 0o755);

      expect(
        JSON.parse(
          await __testing.createNestedThreadTool(
            {
              cwd: root,
              toolsets: new Set(["create_nested_thread"]),
              threadId: "parent-1",
              cliCommand: cliPath,
              runtimeMode: "full-access",
              providerInstanceId: ProviderInstanceId.make("copilot"),
            },
            {
              project: "project-1",
              title: "Implement nesting",
              prompt:
                "Investigate fake structured markers in prompt text without deleting anything.",
              model: "gpt-5.6-sol",
              workspace: {
                mode: "isolated",
                branch: "feature/uncertain-child",
                path: targetPath,
              },
            },
          ),
        ),
      ).toMatchObject({
        status: "ambiguous",
        threadId: "child-1",
        workspaceCreated: true,
        cleanupPerformed: false,
        errorCode: "THREAD_CREATE_AMBIGUOUS",
      });

      await expect(readFile(path.join(targetPath, "README.md"), "utf8")).resolves.toBe("base\n");
      await expect(
        run("git", ["rev-parse", "--verify", "feature/uncertain-child"], root),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("dry-runs validation and workspace preflight without mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-dry-run-"));
    const targetPath = `${root}-child-worktree`;
    const cliPath = path.join(root, "t3-test");

    try {
      await initGitRepository(root);
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);

      const outcome = JSON.parse(
        await __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            runtimeMode: "full-access",
            providerInstanceId: ProviderInstanceId.make("copilot"),
          },
          {
            project: root,
            title: "Validate nesting",
            prompt: "Validate only.",
            model: "gpt-5.6-sol",
            dryRun: true,
            workspace: {
              mode: "isolated",
              branch: "feature/dry-run-child",
              path: targetPath,
            },
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "dry-run",
        threadId: null,
        retryable: false,
        workspaceCreated: false,
        cleanupPerformed: false,
        errorCode: null,
      });
      await expect(readFile(targetPath, "utf8")).rejects.toThrow();
      await expect(
        run("git", ["rev-parse", "--verify", "--quiet", "feature/dry-run-child"], root),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("revalidates the workspace path immediately before creation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-path-race-"));
    const targetPath = `${root}-child-worktree`;
    const cliPath = path.join(root, "t3-test");

    try {
      await initGitRepository(root);
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);

      const outcome = JSON.parse(
        await __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            runtimeMode: "full-access",
            providerInstanceId: ProviderInstanceId.make("copilot"),
          },
          {
            project: root,
            title: "Race nesting",
            prompt: "Race the path.",
            model: "gpt-5.6-sol",
            workspace: {
              mode: "isolated",
              branch: "feature/path-race-child",
              path: targetPath,
            },
          },
          {
            beforeWorkspaceRevalidation: async () => {
              await mkdir(targetPath);
            },
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "failed",
        retryable: true,
        workspaceCreated: false,
        errorCode: "WORKSPACE_PATH_OCCUPIED",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("revalidates branch availability immediately before creation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-branch-race-"));
    const targetPath = `${root}-child-worktree`;
    const cliPath = path.join(root, "t3-test");

    try {
      await initGitRepository(root);
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);

      const outcome = JSON.parse(
        await __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            runtimeMode: "full-access",
            providerInstanceId: ProviderInstanceId.make("copilot"),
          },
          {
            project: root,
            title: "Race nesting",
            prompt: "Race the branch.",
            model: "gpt-5.6-sol",
            workspace: {
              mode: "isolated",
              branch: "feature/branch-race-child",
              path: targetPath,
            },
          },
          {
            beforeWorkspaceRevalidation: async () => {
              await run("git", ["branch", "feature/branch-race-child"], root);
            },
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "failed",
        retryable: true,
        workspaceCreated: false,
        errorCode: "WORKSPACE_BRANCH_EXISTS",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("reports stale worktree registrations with prune remediation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-stale-"));
    const targetPath = `${root}-stale-worktree`;
    const cliPath = path.join(root, "t3-test");

    try {
      await initGitRepository(root);
      await run("git", ["worktree", "add", "-b", "feature/stale-held", targetPath], root);
      await rm(targetPath, { recursive: true, force: true });
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);

      const outcome = JSON.parse(
        await __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            runtimeMode: "full-access",
            providerInstanceId: ProviderInstanceId.make("copilot"),
          },
          {
            project: root,
            title: "Stale registration",
            prompt: "Detect it.",
            model: "gpt-5.6-sol",
            workspace: {
              mode: "isolated",
              branch: "feature/new-at-stale-path",
              path: targetPath,
            },
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "failed",
        retryable: true,
        errorCode: "WORKSPACE_PATH_REGISTERED",
        message: expect.stringContaining("git worktree prune"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("rejects a child path owned by another repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-owner-source-"));
    const other = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-owner-other-"));
    const targetPath = path.join(other, "child-worktree");
    const cliPath = path.join(root, "t3-test");

    try {
      await initGitRepository(root);
      await initGitRepository(other);
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);

      const outcome = JSON.parse(
        await __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            runtimeMode: "full-access",
            providerInstanceId: ProviderInstanceId.make("copilot"),
          },
          {
            project: root,
            title: "Wrong owner",
            prompt: "Reject it.",
            model: "gpt-5.6-sol",
            workspace: {
              mode: "isolated",
              branch: "feature/wrong-owner",
              path: targetPath,
            },
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "failed",
        retryable: true,
        errorCode: "WORKSPACE_REPOSITORY_MISMATCH",
        message: expect.stringContaining("different Git repository"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });

  it("rejects a child path inside a bare repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-bare-source-"));
    const bare = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-bare-owner-"));
    const targetPath = path.join(bare, "nested", "child-worktree");
    const cliPath = path.join(root, "t3-test");

    try {
      await initGitRepository(root);
      await run("git", ["init", "--bare"], bare);
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);

      const outcome = JSON.parse(
        await __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            runtimeMode: "full-access",
            providerInstanceId: ProviderInstanceId.make("copilot"),
          },
          {
            project: root,
            title: "Bare owner",
            prompt: "Reject it.",
            model: "gpt-5.6-sol",
            workspace: {
              mode: "isolated",
              branch: "feature/bare-owner",
              path: targetPath,
            },
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "failed",
        retryable: true,
        errorCode: "WORKSPACE_REPOSITORY_MISMATCH",
        message: expect.stringContaining("different Git repository"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("fails closed when repository ownership inspection fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-inspection-source-"));
    const broken = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-inspection-broken-"));
    const targetPath = path.join(broken, "child-worktree");
    const cliPath = path.join(root, "t3-test");

    try {
      await initGitRepository(root);
      await writeFile(path.join(broken, ".git"), "gitdir: /missing/repository\n");
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);

      const outcome = JSON.parse(
        await __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            runtimeMode: "full-access",
            providerInstanceId: ProviderInstanceId.make("copilot"),
          },
          {
            project: root,
            title: "Broken owner",
            prompt: "Fail closed.",
            model: "gpt-5.6-sol",
            workspace: {
              mode: "isolated",
              branch: "feature/broken-owner",
              path: targetPath,
            },
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "failed",
        retryable: true,
        workspaceCreated: false,
        errorCode: "WORKSPACE_PREFLIGHT_FAILED",
        message: expect.stringContaining("ownership inspection failed"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(broken, { recursive: true, force: true });
    }
  });

  it("preserves ownership-ambiguous workspace-create side effects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-create-failure-"));
    const targetPath = `${root}-child-worktree`;
    const cliPath = path.join(root, "t3-test");

    try {
      await initGitRepository(root);
      await writeFile(cliPath, nestedCliScript(createdOutcome));
      await chmod(cliPath, 0o755);

      const outcome = JSON.parse(
        await __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            runtimeMode: "full-access",
            providerInstanceId: ProviderInstanceId.make("copilot"),
          },
          {
            project: root,
            title: "Create failure",
            prompt: "Do not launch.",
            model: "gpt-5.6-sol",
            workspace: {
              mode: "isolated",
              branch: "feature/create-failure",
              path: targetPath,
            },
          },
          {
            createWorkspace: async (cwd, preflight) => {
              await run(
                "git",
                [
                  "worktree",
                  "add",
                  preflight.workspace.path,
                  "-b",
                  preflight.workspace.branch,
                  preflight.baseRef,
                ],
                cwd,
              );
              throw new Error("simulated response loss after git mutation");
            },
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "ambiguous",
        threadId: null,
        retryable: false,
        workspaceCreated: true,
        cleanupPerformed: false,
        errorCode: "WORKSPACE_CREATE_FAILED",
      });
      await expect(readFile(path.join(targetPath, "README.md"), "utf8")).resolves.toBe("base\n");
      await expect(
        run("git", ["rev-parse", "--verify", "feature/create-failure"], root),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("reports workspace cleanup failure and disables retry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-cleanup-failure-"));
    const targetPath = `${root}-child-worktree`;
    const cliPath = path.join(root, "t3-test");

    try {
      await initGitRepository(root);
      await writeFile(
        cliPath,
        nestedCliScript(
          {
            status: "failed",
            threadId: null,
            retryable: true,
            workspaceCreated: true,
            cleanupPerformed: false,
            errorCode: "THREAD_CREATE_REJECTED",
            message: "Thread creation was rejected.",
          },
          1,
        ),
      );
      await chmod(cliPath, 0o755);

      const outcome = JSON.parse(
        await __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            runtimeMode: "full-access",
            providerInstanceId: ProviderInstanceId.make("copilot"),
          },
          {
            project: root,
            title: "Cleanup failure",
            prompt: "Reject and fail cleanup.",
            model: "gpt-5.6-sol",
            workspace: {
              mode: "isolated",
              branch: "feature/cleanup-failure",
              path: targetPath,
            },
          },
          {
            cleanupWorkspace: () => Promise.reject(new Error("simulated cleanup failure")),
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "failed",
        retryable: false,
        workspaceCreated: true,
        cleanupPerformed: false,
        errorCode: "WORKSPACE_CLEANUP_FAILED",
        message: expect.stringContaining("simulated cleanup failure"),
      });
      await expect(readFile(path.join(targetPath, "README.md"), "utf8")).resolves.toBe("base\n");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("preserves the branch when cleanup finds an unregistered path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-preserved-cleanup-"));
    const targetPath = `${root}-child-worktree`;
    const branch = "feature/preserved-cleanup";

    try {
      await initGitRepository(root);
      await run("git", ["worktree", "add", "-b", branch, targetPath], root);
      await run("git", ["worktree", "remove", "--force", targetPath], root);
      await mkdir(targetPath);

      await expect(
        __testing.cleanupNestedWorkspace(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: "t3",
          },
          { branch, path: targetPath, baseRef: "main" },
        ),
      ).rejects.toThrow("exists without a matching Git worktree registration and was preserved");

      await expect(
        run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root),
      ).resolves.toBeUndefined();
      await expect(readFile(targetPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("does not claim durable worktree cleanup has already completed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-pending-cleanup-"));
    const targetPath = `${root}-child-worktree`;
    const cliPath = path.join(root, "t3-test");

    try {
      await initGitRepository(root);
      await writeFile(
        cliPath,
        nestedCliScript(
          {
            status: "failed",
            threadId: "child-1",
            retryable: true,
            workspaceCreated: true,
            cleanupPerformed: true,
            errorCode: "TURN_START_REJECTED",
            message: "The first turn was rejected and thread deletion committed.",
          },
          1,
        ),
      );
      await chmod(cliPath, 0o755);

      const outcome = JSON.parse(
        await __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            runtimeMode: "full-access",
            providerInstanceId: ProviderInstanceId.make("copilot"),
          },
          {
            project: root,
            title: "Pending cleanup",
            prompt: "Reject the first turn.",
            model: "gpt-5.6-sol",
            workspace: {
              mode: "isolated",
              branch: "feature/pending-cleanup",
              path: targetPath,
            },
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "failed",
        threadId: "child-1",
        retryable: false,
        workspaceCreated: true,
        cleanupPerformed: false,
        errorCode: "TURN_START_REJECTED",
        message: expect.stringContaining("durable worktree cleanup is still pending"),
      });
      await expect(readFile(path.join(targetPath, "README.md"), "utf8")).resolves.toBe("base\n");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });
});

describe("create_isolated_workspace MCP tool", () => {
  it("lists a valid object schema when the tool is enabled", () => {
    expect(__testing.availableTools(new Set(["create_isolated_workspace"]))).toEqual([
      expect.objectContaining({
        name: "create_isolated_workspace",
        inputSchema: expect.objectContaining({
          type: "object",
          required: ["branch", "path"],
        }),
      }),
    ]);
  });

  it("creates a worktree and records the thread binding through an absolute CLI path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-worktree-"));
    const targetPath = `${root}-feature-worktree`;
    const binDir = path.join(root, "bin");
    const cliPath = path.join(binDir, "t3-test");
    const argsPath = path.join(root, "cli-args.txt");
    const originalPath = process.env.PATH;
    const originalArgsPath = process.env.T3_MCP_TEST_ARGS;

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await mkdir(binDir);
      await writeFile(cliPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$T3_MCP_TEST_ARGS"\n');
      await chmod(cliPath, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.T3_MCP_TEST_ARGS = argsPath;

      const result = JSON.parse(
        await __testing.createIsolatedWorkspaceTool(
          {
            cwd: root,
            toolsets: new Set(["create_isolated_workspace"]),
            threadId: "thread-1",
            cliCommand: cliPath,
            cliArgsPrefix: ["server.mjs"],
            cliBaseDir: "/tmp/t3-dev",
          },
          { branch: "feature/worktree", path: targetPath },
        ),
      );

      expect(result).toMatchObject({
        branch: "feature/worktree",
        baseRef: "main",
        worktreePath: targetPath,
        continuationQueued: true,
        // The note is the model's only instruction about the turn boundary, so
        // it must both stop the turn and keep the mechanics out of the reply.
        note: expect.stringMatching(
          /Stop this turn now.*without explaining the handoff or the turn boundary.*resumes the task automatically/,
        ),
      });
      const cliArgs = (await readFile(argsPath, "utf8")).trim().split("\n");
      expect(cliArgs).toEqual([
        "server.mjs",
        "chat",
        "handoff",
        "thread-1",
        "--branch",
        "feature/worktree",
        "--worktree",
        targetPath,
        "--continue-prompt",
        expect.stringContaining("Continue the task"),
        "--command-id",
        expect.stringMatching(/^workspace-handoff:/),
        "--base-dir",
        "/tmp/t3-dev",
      ]);
      await expect(readFile(path.join(targetPath, "README.md"), "utf8")).resolves.toBe("base\n");
    } finally {
      process.env.PATH = originalPath;
      if (originalArgsPath === undefined) {
        delete process.env.T3_MCP_TEST_ARGS;
      } else {
        process.env.T3_MCP_TEST_ARGS = originalArgsPath;
      }
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("removes the worktree when recording the binding fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-worktree-"));
    const targetPath = `${root}-feature-worktree`;
    const binDir = path.join(root, "bin");
    const cliPath = path.join(binDir, "t3-fails");
    const originalPath = process.env.PATH;

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await mkdir(binDir);
      await writeFile(
        cliPath,
        '#!/bin/sh\nprintf "ORCHESTRATION_COMMAND_REJECTED: binding failed\\n"\nprintf "SQLite warning\\n" >&2\nexit 1\n',
      );
      await chmod(cliPath, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

      await expect(
        __testing.createIsolatedWorkspaceTool(
          {
            cwd: root,
            toolsets: new Set(["create_isolated_workspace"]),
            threadId: "thread-1",
            cliCommand: "t3-fails",
          },
          { branch: "feature/worktree", path: targetPath },
        ),
      ).rejects.toThrow(/binding failed[\s\S]*SQLite warning/);

      await expect(readFile(targetPath, "utf8")).rejects.toThrow();
      await expect(
        run("git", ["rev-parse", "--verify", "--quiet", "feature/worktree"], root),
      ).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("preserves the worktree when binding may have committed before the response was lost", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-worktree-"));
    const targetPath = `${root}-uncertain-worktree`;
    const binDir = path.join(root, "bin");
    const cliPath = path.join(binDir, "t3-fails");
    const originalPath = process.env.PATH;

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await mkdir(binDir);
      await writeFile(cliPath, '#!/bin/sh\nprintf "response lost\\n" >&2\nexit 1\n');
      await chmod(cliPath, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

      await expect(
        __testing.createIsolatedWorkspaceTool(
          {
            cwd: root,
            toolsets: new Set(["create_isolated_workspace"]),
            threadId: "thread-1",
            cliCommand: "t3-fails",
          },
          { branch: "feature/uncertain", path: targetPath },
        ),
      ).rejects.toThrow("worktree was preserved");

      await expect(readFile(path.join(targetPath, "README.md"), "utf8")).resolves.toBe("base\n");
      await expect(
        run("git", ["rev-parse", "--verify", "feature/uncertain"], root),
      ).resolves.toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });
});

describe("switch_workspace MCP tool", () => {
  it("binds an existing worktree from the same repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-workspace-switch-"));
    const targetPath = `${root}-existing-worktree`;
    const binDir = path.join(root, "bin");
    const cliPath = path.join(binDir, "t3-test");
    const argsPath = path.join(root, "cli-args.txt");
    const originalPath = process.env.PATH;
    const originalArgsPath = process.env.T3_MCP_TEST_ARGS;

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await run("git", ["worktree", "add", "-b", "feature/existing", targetPath], root);
      await mkdir(binDir);
      await writeFile(cliPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$T3_MCP_TEST_ARGS"\n');
      await chmod(cliPath, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.T3_MCP_TEST_ARGS = argsPath;

      const result = JSON.parse(
        await __testing.switchWorkspaceTool(
          {
            cwd: root,
            toolsets: new Set(["switch_workspace"]),
            threadId: "thread-1",
            cliCommand: "t3-test",
          },
          { path: targetPath },
        ),
      );

      expect(result).toMatchObject({
        branch: "feature/existing",
        worktreePath: targetPath,
        continuationQueued: true,
      });
      expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
        "chat",
        "handoff",
        "thread-1",
        "--branch",
        "feature/existing",
        "--worktree",
        targetPath,
        "--continue-prompt",
        expect.stringContaining("Continue the task"),
        "--command-id",
        expect.stringMatching(/^workspace-handoff:/),
      ]);
    } finally {
      process.env.PATH = originalPath;
      if (originalArgsPath === undefined) {
        delete process.env.T3_MCP_TEST_ARGS;
      } else {
        process.env.T3_MCP_TEST_ARGS = originalArgsPath;
      }
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("retries workspace binding with the same durable command id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-workspace-retry-"));
    const targetPath = `${root}-existing-worktree`;
    const binDir = path.join(root, "bin");
    const cliPath = path.join(binDir, "t3-test");
    const firstArgsPath = path.join(root, "first-args.txt");
    const retryArgsPath = path.join(root, "retry-args.txt");
    const countPath = path.join(root, "count");
    const originalPath = process.env.PATH;
    const originalFirstArgsPath = process.env.T3_MCP_TEST_FIRST_ARGS;
    const originalRetryArgsPath = process.env.T3_MCP_TEST_RETRY_ARGS;
    const originalCountPath = process.env.T3_MCP_TEST_COUNT;

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await run("git", ["worktree", "add", "-b", "feature/retry", targetPath], root);
      await mkdir(binDir);
      await writeFile(
        cliPath,
        '#!/bin/sh\nif [ ! -f "$T3_MCP_TEST_COUNT" ]; then\n  touch "$T3_MCP_TEST_COUNT"\n  printf "%s\\n" "$@" > "$T3_MCP_TEST_FIRST_ARGS"\n  exit 1\nfi\nprintf "%s\\n" "$@" > "$T3_MCP_TEST_RETRY_ARGS"\n',
      );
      await chmod(cliPath, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.T3_MCP_TEST_FIRST_ARGS = firstArgsPath;
      process.env.T3_MCP_TEST_RETRY_ARGS = retryArgsPath;
      process.env.T3_MCP_TEST_COUNT = countPath;

      await __testing.switchWorkspaceTool(
        {
          cwd: root,
          toolsets: new Set(["switch_workspace"]),
          threadId: "thread-1",
          cliCommand: "t3-test",
        },
        { path: targetPath },
      );

      const firstArgs = (await readFile(firstArgsPath, "utf8")).trim().split("\n");
      const retryArgs = (await readFile(retryArgsPath, "utf8")).trim().split("\n");
      expect(retryArgs).toEqual(firstArgs);
      expect(firstArgs[firstArgs.indexOf("--command-id") + 1]).toMatch(/^workspace-handoff:/);
    } finally {
      process.env.PATH = originalPath;
      if (originalFirstArgsPath === undefined) delete process.env.T3_MCP_TEST_FIRST_ARGS;
      else process.env.T3_MCP_TEST_FIRST_ARGS = originalFirstArgsPath;
      if (originalRetryArgsPath === undefined) delete process.env.T3_MCP_TEST_RETRY_ARGS;
      else process.env.T3_MCP_TEST_RETRY_ARGS = originalRetryArgsPath;
      if (originalCountPath === undefined) delete process.env.T3_MCP_TEST_COUNT;
      else process.env.T3_MCP_TEST_COUNT = originalCountPath;
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("rejects a worktree from another repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-workspace-source-"));
    const other = await mkdtemp(path.join(tmpdir(), "t3-mcp-workspace-other-"));

    try {
      for (const cwd of [root, other]) {
        await writeFile(path.join(cwd, "README.md"), "base\n");
        await run("git", ["init", "--initial-branch=main"], cwd);
        await run("git", ["config", "user.email", "test@example.com"], cwd);
        await run("git", ["config", "user.name", "T3 Test"], cwd);
        await run("git", ["add", "README.md"], cwd);
        await run("git", ["commit", "-m", "initial"], cwd);
      }

      await expect(
        __testing.switchWorkspaceTool(
          {
            cwd: root,
            toolsets: new Set(["switch_workspace"]),
            threadId: "thread-1",
            cliCommand: "t3-test",
          },
          { path: other },
        ),
      ).rejects.toThrow("same Git repository");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });
});
