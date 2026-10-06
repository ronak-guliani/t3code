import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OwnedProcessGroupIdentity {
  readonly pid: number;
  readonly startIdentity: string;
  readonly ownerToken: string;
  readonly serverInstanceId: string;
}

export type OwnedProcessCleanupResult =
  | "terminated"
  | "missing"
  | "start-identity-mismatch"
  | "owner-token-mismatch"
  | "not-process-group-leader"
  | "current-instance"
  | "unverified";

interface InspectedProcess {
  readonly startIdentity: string;
  readonly isProcessGroupLeader: boolean;
}

async function inspectProcess(pid: number): Promise<InspectedProcess | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference='Stop'; $p=[System.Diagnostics.Process]::GetProcessById(${pid}); $p.StartTime.ToUniversalTime().Ticks`,
        ],
        { timeout: 5_000, maxBuffer: 8 * 1024 },
      );
      const startIdentity = stdout.trim();
      return startIdentity ? { startIdentity, isProcessGroupLeader: true } : null;
    }

    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-p", String(pid), "-o", "pgid=", "-o", "lstart="],
      { timeout: 2_000, maxBuffer: 8 * 1024 },
    );
    const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
    if (!match?.[1] || !match[2]) return null;
    return {
      isProcessGroupLeader: Number(match[1]) === pid,
      startIdentity: match[2].trim(),
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return null;
    return null;
  }
}

async function processHasOwnerToken(pid: number, ownerToken: string): Promise<boolean | null> {
  if (process.platform === "win32") return null;
  try {
    const environment =
      process.platform === "linux"
        ? await readFile(`/proc/${pid}/environ`, "utf8")
        : (
            await execFileAsync("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
              timeout: 2_000,
              maxBuffer: 256 * 1024,
            })
          ).stdout;
    const marker = `T3_TERMINAL_OWNER_TOKEN=${ownerToken}`;
    return process.platform === "linux"
      ? environment.split("\u0000").includes(marker)
      : environment.includes(marker);
  } catch {
    return false;
  }
}

async function processGroupHasOwnerToken(pgid: number, ownerToken: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,pgid="], {
      timeout: 2_000,
      maxBuffer: 256 * 1024,
    });
    const pids = stdout
      .split("\n")
      .flatMap((line) => {
        const [pid, groupId] = line.trim().split(/\s+/);
        return Number(groupId) === pgid && Number.isInteger(Number(pid)) ? [Number(pid)] : [];
      })
      .slice(0, 50);
    for (const pid of pids) {
      if (await processHasOwnerToken(pid, ownerToken)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** OS-observed process start value; records also bind it to an owner token. */
export async function processStartIdentity(pid: number): Promise<string | null> {
  return (await inspectProcess(pid))?.startIdentity ?? null;
}

export function processGroupExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Stop only a recorded process group after rechecking its PID/start identity.
 * The one-second escalation window starts after ownership is verified; a
 * process group cannot be recycled while it still has members.
 */
export async function terminateOwnedProcessGroup(
  identity: OwnedProcessGroupIdentity,
  currentServerInstanceId: string,
  allowCurrentInstance = false,
): Promise<OwnedProcessCleanupResult> {
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    identity.startIdentity.length === 0 ||
    identity.ownerToken.length === 0 ||
    identity.serverInstanceId.length === 0
  ) {
    return "unverified";
  }
  if (!allowCurrentInstance && identity.serverInstanceId === currentServerInstanceId) {
    return "current-instance";
  }

  const current = await inspectProcess(identity.pid);
  if (current === null) {
    if (process.platform === "win32" || !processGroupExists(identity.pid)) return "missing";
    if (!(await processGroupHasOwnerToken(identity.pid, identity.ownerToken))) {
      return "owner-token-mismatch";
    }
  } else {
    if (current.startIdentity !== identity.startIdentity) return "start-identity-mismatch";
    if (!current.isProcessGroupLeader) return "not-process-group-leader";
    const ownerTokenMatches = await processHasOwnerToken(identity.pid, identity.ownerToken);
    if (
      ownerTokenMatches === false &&
      !(await processGroupHasOwnerToken(identity.pid, identity.ownerToken))
    ) {
      return "owner-token-mismatch";
    }
  }

  const pidOrGroup = process.platform === "win32" ? identity.pid : -identity.pid;
  try {
    if (process.platform === "win32") {
      await execFileAsync("taskkill.exe", ["/PID", String(identity.pid), "/T", "/F"], {
        timeout: 5_000,
        maxBuffer: 8 * 1024,
      });
      return "terminated";
    }
    process.kill(pidOrGroup, "SIGTERM");
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unverified";
  }

  await new Promise((resolve) => setTimeout(resolve, 1_000));
  if (!processGroupExists(identity.pid)) return "terminated";

  // Re-check the leader when it is still present. If it exited, the group ID
  // remains reserved while descendants exist, so it still identifies the
  // group just signalled above.
  const afterGrace = await inspectProcess(identity.pid);
  if (afterGrace && afterGrace.startIdentity !== identity.startIdentity) return "unverified";
  if (
    afterGrace &&
    (await processHasOwnerToken(identity.pid, identity.ownerToken)) === false &&
    !(await processGroupHasOwnerToken(identity.pid, identity.ownerToken))
  ) {
    return "unverified";
  }
  if (
    !afterGrace &&
    processGroupExists(identity.pid) &&
    !(await processGroupHasOwnerToken(identity.pid, identity.ownerToken))
  ) {
    return "unverified";
  }
  try {
    process.kill(pidOrGroup, "SIGKILL");
    return "terminated";
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ESRCH" ? "terminated" : "unverified";
  }
}
