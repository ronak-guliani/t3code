import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  COPILOT_MISSING_TRANSCRIPT_MARKER,
  listCopilotHistoryWorkspaces,
} from "./copilotHistoryImport.ts";

async function writeSession(input: {
  readonly homeDir: string;
  readonly sessionId: string;
  readonly workspaceYaml: string;
  readonly eventsJsonl?: string;
}) {
  const sessionDir = join(input.homeDir, ".copilot", "session-state", input.sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "workspace.yaml"), input.workspaceYaml, "utf8");
  if (input.eventsJsonl !== undefined) {
    await writeFile(join(sessionDir, "events.jsonl"), input.eventsJsonl, "utf8");
  }
}

describe("copilotHistoryImport", () => {
  it("indexes Copilot session-state workspaces and counts events", async () => {
    const normalizedHomeDir = await mkdtemp(join(tmpdir(), "t3code-copilot-history-"));
    await writeSession({
      homeDir: normalizedHomeDir,
      sessionId: "session-1",
      workspaceYaml: "workspace: /repo/project\n",
      eventsJsonl: '{"type":"a"}\n{"type":"b"}\n',
    });

    const workspaces = await listCopilotHistoryWorkspaces({ homeDir: normalizedHomeDir });

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      sessionId: "session-1",
      workspacePath: "/repo/project",
      eventCount: 2,
    });
  });

  it("filters sessions outside the requested root", async () => {
    const normalizedHomeDir = await mkdtemp(join(tmpdir(), "t3code-copilot-history-"));
    await writeSession({
      homeDir: normalizedHomeDir,
      sessionId: "inside",
      workspaceYaml: "cwd: /repo/project\n",
      eventsJsonl: "{}\n",
    });
    await writeSession({
      homeDir: normalizedHomeDir,
      sessionId: "outside",
      workspaceYaml: "cwd: /other/project\n",
      eventsJsonl: "{}\n",
    });

    const workspaces = await listCopilotHistoryWorkspaces({
      homeDir: normalizedHomeDir,
      rootPath: "/repo",
    });

    expect(workspaces.map((workspace) => workspace.sessionId)).toEqual(["inside"]);
  });

  it("retains sessions with missing transcripts using a synthetic marker path", async () => {
    const normalizedHomeDir = await mkdtemp(join(tmpdir(), "t3code-copilot-history-"));
    await writeSession({
      homeDir: normalizedHomeDir,
      sessionId: "missing-events",
      workspaceYaml: "workspace: /repo/project\n",
    });

    const workspaces = await listCopilotHistoryWorkspaces({ homeDir: normalizedHomeDir });

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      sessionId: "missing-events",
      workspacePath: "/repo/project",
      eventCount: 0,
    });
    expect(workspaces[0]?.eventsPath).toContain(COPILOT_MISSING_TRANSCRIPT_MARKER);
  });
});
