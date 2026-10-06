import { spawn } from "node:child_process";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import {
  processGroupExists,
  processStartIdentity,
  terminateOwnedProcessGroup,
} from "./ownedProcessCleanup.ts";

describe("owned terminal process cleanup", () => {
  const children: ReturnType<typeof spawn>[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL");
        } catch {
          // The cleanup under test may already have exited it.
        }
      }
    }
  });

  async function startSleepProcess() {
    const ownerToken = crypto.randomUUID();
    const command = process.platform === "win32" ? process.execPath : "/bin/sleep";
    const args = process.platform === "win32" ? ["-e", "setInterval(() => {}, 60_000)"] : ["60"];
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      stdio: "ignore",
      env: { ...process.env, T3_TERMINAL_OWNER_TOKEN: ownerToken },
      ...(process.platform === "win32" ? {} : { argv0: `T3_TERMINAL_OWNER_TOKEN=${ownerToken}` }),
    });
    children.push(child);
    await once(child, "spawn");
    const pid = child.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) throw new Error("sleep fixture did not start");
    const startIdentity = await processStartIdentity(pid);
    expect(startIdentity).not.toBeNull();
    if (startIdentity === null) throw new Error("could not inspect fixture process identity");
    return { child, pid, startIdentity, ownerToken };
  }

  it("terminates a previous-instance process group with a matching PID start identity", async () => {
    const { child, pid, startIdentity, ownerToken } = await startSleepProcess();

    const exited = once(child, "exit");
    const result = await terminateOwnedProcessGroup(
      { pid, startIdentity, ownerToken, serverInstanceId: "previous-instance" },
      "current-instance",
    );
    await exited;

    expect(result).toBe("terminated");
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("does not signal a reused PID whose recorded start identity differs", async () => {
    const { child, pid, startIdentity, ownerToken } = await startSleepProcess();

    const result = await terminateOwnedProcessGroup(
      {
        pid,
        startIdentity: `${startIdentity}:reused`,
        ownerToken,
        serverInstanceId: "previous-instance",
      },
      "current-instance",
    );

    expect(result).toBe("start-identity-mismatch");
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    process.kill(pid, 0);
  });

  it("finds and terminates owned descendants after the recorded wrapper exits", async () => {
    if (process.platform === "win32") return;
    const ownerToken = crypto.randomUUID();
    const wrapper = spawn(
      process.execPath,
      [
        "-e",
        `const {spawn}=require("node:child_process");spawn(process.execPath,["-e","setInterval(()=>{},60000)"],{stdio:"ignore"});setTimeout(()=>process.exit(0),100)`,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, T3_TERMINAL_OWNER_TOKEN: ownerToken },
      },
    );
    children.push(wrapper);
    await once(wrapper, "spawn");
    const pid = wrapper.pid;
    if (pid === undefined) throw new Error("wrapper fixture did not start");
    const startIdentity = await processStartIdentity(pid);
    if (!startIdentity) throw new Error("could not inspect wrapper process");
    await once(wrapper, "exit");
    expect(processGroupExists(pid)).toBe(true);

    const result = await terminateOwnedProcessGroup(
      { pid, startIdentity, ownerToken, serverInstanceId: "previous-instance" },
      "current-instance",
    );

    expect(result).toBe("terminated");
    expect(processGroupExists(pid)).toBe(false);
  });
});
