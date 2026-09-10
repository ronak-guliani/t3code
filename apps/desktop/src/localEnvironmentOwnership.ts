import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { isMissingFile } from "@t3tools/shared/localEnvironment";

const WindowsAclSnapshot = Schema.Struct({
  currentUserSid: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      ownerSid: Schema.String,
      hasDacl: Schema.Boolean,
      rules: Schema.Array(
        Schema.Struct({
          sid: Schema.String,
          accessType: Schema.Literals(["Allow", "Deny"]),
          rights: Schema.Int,
        }),
      ),
    }),
  ),
});
type WindowsAclSnapshot = typeof WindowsAclSnapshot.Type;
const decodeAcl = Schema.decodeUnknownSync(Schema.fromJsonString(WindowsAclSnapshot));
// Only known read/execute/synchronize rights are safe for untrusted principals.
const readOnlyRights = 1 | 8 | 32 | 128 | 131072 | 1048576;
const systemAdministrators = new Set(["S-1-5-18", "S-1-5-32-544"]);
const ownershipError = () =>
  new Error(
    "Automatic attachment requires environment files owned by this user and not writable by other users. Use explicit pairing if ownership cannot be verified.",
  );

// Paths travel as JSON data, never as PowerShell source or wildcard patterns.
const inspectAclScript = `
$ErrorActionPreference = 'Stop'
# Node can inherit PowerShell 7 module paths; use only this runtime's built-in modules.
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$paths = ConvertFrom-Json -InputObject $env:T3CODE_LOCAL_ACL_PATHS
$entries = @($paths | ForEach-Object {
  $acl = Get-Acl -LiteralPath $_
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  [ordered]@{
    ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    hasDacl = ($null -ne $descriptor.DiscretionaryAcl)
    rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      [ordered]@{ sid = $_.IdentityReference.Value; accessType = $_.AccessControlType.ToString(); rights = [int]$_.FileSystemRights }
    })
  }
})
[ordered]@{
  currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  entries = $entries
} | ConvertTo-Json -Depth 6 -Compress
`;

async function inspectWindowsAcl(paths: readonly string[]): Promise<WindowsAclSnapshot> {
  try {
    const { stdout } = await promisify(execFile)(
      win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", inspectAclScript],
      {
        env: { ...process.env, T3CODE_LOCAL_ACL_PATHS: JSON.stringify(paths) },
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    );
    return decodeAcl(stdout);
  } catch {
    // Do not expose subprocess output, ACL principals, or partially decoded data.
    throw new Error(
      "Windows ownership verification failed. No pairing credential was issued; use explicit pairing.",
    );
  }
}

export function assertWindowsOwnership(
  snapshot: WindowsAclSnapshot,
  expectedEntries: number,
): void {
  if (
    !snapshot.currentUserSid.startsWith("S-1-") ||
    snapshot.entries.length !== expectedEntries ||
    snapshot.entries.some(
      (entry) =>
        entry.ownerSid !== snapshot.currentUserSid ||
        !entry.hasDacl ||
        entry.rules.some(
          (rule) =>
            rule.accessType === "Allow" &&
            (rule.rights & ~readOnlyRights) !== 0 &&
            rule.sid !== snapshot.currentUserSid &&
            !systemAdministrators.has(rule.sid),
        ),
    )
  ) {
    throw ownershipError();
  }
}

export async function verifyLocalEnvironmentOwnership(
  baseDir: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly userId?: number;
    readonly windowsAcl?: (paths: readonly string[]) => Promise<WindowsAclSnapshot>;
  } = {},
): Promise<void> {
  const paths = [
    baseDir,
    join(baseDir, "userdata"),
    join(baseDir, "userdata", "environment-id"),
    join(baseDir, "userdata", "server-runtime.json"),
  ];
  for (const name of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]) {
    const path = join(baseDir, "userdata", name);
    try {
      await lstat(path);
      paths.push(path);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  const stats = await Promise.all(paths.map((path) => lstat(path)));
  if (stats.some((info) => info.isSymbolicLink())) throw ownershipError();
  if ((options.platform ?? process.platform) === "win32") {
    assertWindowsOwnership(await (options.windowsAcl ?? inspectWindowsAcl)(paths), paths.length);
    return;
  }
  const uid = options.userId ?? process.getuid?.();
  if (uid === undefined || stats.some((info) => info.uid !== uid || (info.mode & 0o022) !== 0)) {
    throw ownershipError();
  }
}
