import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWindowsOwnership,
  verifyLocalEnvironmentOwnership,
} from "./localEnvironmentOwnership.ts";

const sid = "S-1-5-21-100-200-300-1001";
const other = "S-1-5-21-100-200-300-1002";
const entry = () => ({
  ownerSid: sid,
  hasDacl: true,
  rules: [
    { sid, accessType: "Allow" as const, rights: 2032127 },
    { sid: "S-1-5-18", accessType: "Allow" as const, rights: 2032127 },
    { sid: "S-1-5-32-544", accessType: "Allow" as const, rights: 2032127 },
  ],
});
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("Windows local attachment ownership", () => {
  it.skipIf(process.platform !== "win32")(
    "checks real Windows ACLs and refuses a writable-by-everyone directory",
    async () => {
      directory = await mkdtemp(join(tmpdir(), "t3-native-acl-"));
      const userdata = join(directory, "userdata");
      await mkdir(userdata);
      const paths = [
        directory,
        userdata,
        join(userdata, "environment-id"),
        join(userdata, "server-runtime.json"),
      ];
      await writeFile(paths[2]!, "test");
      await writeFile(paths[3]!, "test");
      const powershell = win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const run = (script: string) =>
        promisify(execFile)(
          powershell,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          {
            env: { ...process.env, T3CODE_TEST_ACL_PATHS: JSON.stringify(paths) },
            timeout: 15000,
            windowsHide: true,
          },
        );
      await run(`
      $ErrorActionPreference = 'Stop'
      $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      foreach ($path in (ConvertFrom-Json -InputObject $env:T3CODE_TEST_ACL_PATHS)) {
        $acl = Get-Acl -LiteralPath $path
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
        Set-Acl -LiteralPath $path -AclObject $acl
      }
    `);
      await verifyLocalEnvironmentOwnership(directory);
      await run(`
      $ErrorActionPreference = 'Stop'
      $path = (ConvertFrom-Json -InputObject $env:T3CODE_TEST_ACL_PATHS)[0]
      $acl = Get-Acl -LiteralPath $path
      $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
      $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Write', 'Allow'))
      Set-Acl -LiteralPath $path -AclObject $acl
    `);
      await expect(verifyLocalEnvironmentOwnership(directory)).rejects.toThrow("not writable");
    },
    45000,
  );
  it("permits the current user and privileged operating-system principals", () => {
    expect(() =>
      assertWindowsOwnership({ currentUserSid: sid, entries: [entry()] }, 1),
    ).not.toThrow();
  });
  it("rejects a different owner even if the directory is readable", () => {
    expect(() =>
      assertWindowsOwnership(
        { currentUserSid: sid, entries: [{ ...entry(), ownerSid: other }] },
        1,
      ),
    ).toThrow("owned by this user");
  });
  it.each([2, 4, 16, 64, 256, 65536, 262144, 524288, 0x10000000, 0x40000000, 0x02000000])(
    "rejects mutation right %i granted to other principals",
    (rights) => {
      expect(() =>
        assertWindowsOwnership(
          {
            currentUserSid: sid,
            entries: [
              {
                ...entry(),
                rules: [...entry().rules, { sid: other, accessType: "Allow", rights }],
              },
            ],
          },
          1,
        ),
      ).toThrow("not writable");
    },
  );
  it("allows read-only rules and rejects missing DACLs or partial probe output", () => {
    expect(() =>
      assertWindowsOwnership(
        {
          currentUserSid: sid,
          entries: [
            {
              ...entry(),
              rules: [{ sid: other, accessType: "Allow", rights: 131209 }],
            },
          ],
        },
        1,
      ),
    ).not.toThrow();
    expect(() =>
      assertWindowsOwnership({ currentUserSid: sid, entries: [{ ...entry(), hasDacl: false }] }, 1),
    ).toThrow();
    expect(() => assertWindowsOwnership({ currentUserSid: sid, entries: [] }, 1)).toThrow();
  });
  it("runs the Windows ACL path instead of accepting absent POSIX uid support", async () => {
    directory = await mkdtemp(join(tmpdir(), "t3-windows-ownership-"));
    await mkdir(join(directory, "userdata"));
    for (const name of ["environment-id", "server-runtime.json", "state.sqlite"]) {
      await writeFile(join(directory, "userdata", name), "test");
    }
    const probe = vi.fn(async (paths: readonly string[]) => ({
      currentUserSid: sid,
      entries: paths.map(() => entry()),
    }));
    await verifyLocalEnvironmentOwnership(directory, { platform: "win32", windowsAcl: probe });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[0]).toContain(join(directory, "userdata", "state.sqlite"));
    await expect(
      verifyLocalEnvironmentOwnership(directory, {
        platform: "win32",
        windowsAcl: async () => {
          throw new Error("ACL unavailable");
        },
      }),
    ).rejects.toThrow("ACL unavailable");
  });
});
