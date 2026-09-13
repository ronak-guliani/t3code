import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const WINDOWS_SECRET_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$directory = Get-Item -LiteralPath $env:T3_SECRET_DIRECTORY -Force
function Assert-Owned($item) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Secret storage must not contain reparse points.'
  }
  $acl = Get-Acl -LiteralPath $item.FullName
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
    throw 'Secret storage belongs to another Windows account.'
  }
}
Assert-Owned $directory
if (-not $directory.PSIsContainer) { throw 'Secret storage is not a directory.' }
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $directory.FullName -AclObject $acl
foreach ($item in Get-ChildItem -LiteralPath $directory.FullName -Force) {
  Assert-Owned $item
  if ($item.PSIsContainer) { throw 'Unexpected directory in secret storage.' }
  $fileAcl = New-Object System.Security.AccessControl.FileSecurity
  $fileAcl.SetOwner($sid)
  $fileAcl.SetAccessRuleProtection($false, $false)
  Set-Acl -LiteralPath $item.FullName -AclObject $fileAcl
}
$actual = Get-Acl -LiteralPath $directory.FullName
if (-not $actual.AreAccessRulesProtected) { throw 'Secret directory ACL inheritance is still enabled.' }
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) {
    throw 'Secret storage remains accessible to another Windows account.'
  }
}
`;

export async function protectWindowsSecretDirectory(directory: string): Promise<void> {
  await run(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_SECRET_ACL_SCRIPT, "utf16le").toString("base64"),
    ],
    {
      env: { ...process.env, T3_SECRET_DIRECTORY: directory },
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    },
  );
}
