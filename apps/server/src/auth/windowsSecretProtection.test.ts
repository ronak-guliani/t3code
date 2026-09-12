import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  protectWindowsSecretDirectory,
  WINDOWS_SECRET_ACL_SCRIPT,
} from "./windowsSecretProtection.ts";

describe("Windows secret protection", () => {
  it("uses account SIDs, protected inheritable ACLs, and rejects reparse points", () => {
    expect(WINDOWS_SECRET_ACL_SCRIPT).toContain("WindowsIdentity]::GetCurrent().User");
    expect(WINDOWS_SECRET_ACL_SCRIPT).toContain("ReparsePoint");
    expect(WINDOWS_SECRET_ACL_SCRIPT).toContain("SetAccessRuleProtection($true, $false)");
    expect(WINDOWS_SECRET_ACL_SCRIPT).toContain("ContainerInherit,ObjectInherit");
    expect(WINDOWS_SECRET_ACL_SCRIPT).toContain(
      "Secret storage belongs to another Windows account",
    );
  });

  it.skipIf(process.platform !== "win32")(
    "protects existing and future secret files without changing their bytes",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "t3-secret-acl-"));
      const powershell = (script: string) =>
        promisify(execFile)(
          join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(
              `$ErrorActionPreference = 'Stop'; $env:PSModulePath = Join-Path $PSHOME 'Modules'; ${script}`,
              "utf16le",
            ).toString("base64"),
          ],
          { env: { ...process.env, T3_SECRET_DIRECTORY: directory }, windowsHide: true },
        );
      try {
        const existing = join(directory, "existing.bin");
        await writeFile(existing, "test-only");
        await powershell(`
        $acl = Get-Acl -LiteralPath $env:T3_SECRET_DIRECTORY
        $everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $env:T3_SECRET_DIRECTORY -AclObject $acl
      `);
        await protectWindowsSecretDirectory(directory);
        await protectWindowsSecretDirectory(directory);
        const created = join(directory, "created.bin");
        await writeFile(created, "new-test-only");
        expect(await readFile(existing, "utf8")).toBe("test-only");
        expect(await readFile(created, "utf8")).toBe("new-test-only");
        const verified = await powershell(`
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $items = @((Get-Item -LiteralPath $env:T3_SECRET_DIRECTORY)) + @(Get-ChildItem -LiteralPath $env:T3_SECRET_DIRECTORY)
        foreach ($item in $items) {
          $acl = Get-Acl -LiteralPath $item.FullName
          if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'Unexpected owner' }
          $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
          if ($rules.Count -eq 0) { throw 'No inherited access rules' }
          foreach ($rule in $rules) {
            if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid) { throw 'Other principal can read secrets' }
          }
        }
        Write-Output 'verified'
      `);
        expect(verified.stdout.trim()).toBe("verified");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
