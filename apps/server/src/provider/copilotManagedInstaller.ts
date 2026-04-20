import { createHash } from "node:crypto";
import { basename, join } from "node:path";

export interface CopilotReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

export interface CopilotRelease {
  readonly tag_name?: string;
  readonly assets: ReadonlyArray<CopilotReleaseAsset>;
}

export interface CopilotManagedInstallResult {
  readonly version: string | null;
  readonly binaryPath: string;
  readonly assetName: string;
  readonly archivePath: string;
}

export interface InstallManagedCopilotInput {
  readonly stateDir: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly fetchRelease: () => Promise<CopilotRelease>;
  readonly fetchBytes: (url: string) => Promise<Uint8Array>;
  readonly extractArchive: (input: {
    archivePath: string;
    destinationDir: string;
    binaryName: string;
  }) => Promise<string>;
  readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly makeDirectory: (path: string) => Promise<void>;
}

const COPILOT_BINARY_NAME = process.platform === "win32" ? "copilot.exe" : "copilot";
const SHA256SUMS_ASSET_NAMES = new Set(["SHA256SUMS.txt", "sha256sums.txt", "checksums.txt"]);

export function getManagedCopilotInstallDir(stateDir: string): string {
  return join(stateDir, "providers", "copilot", "managed");
}

export function getManagedCopilotBinaryPath(input: {
  readonly stateDir: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const binaryName = (input.platform ?? process.platform) === "win32" ? "copilot.exe" : "copilot";
  return join(getManagedCopilotInstallDir(input.stateDir), "bin", binaryName);
}

export function copilotAssetPlatformTokens(platform: NodeJS.Platform): ReadonlyArray<string> {
  switch (platform) {
    case "darwin":
      return ["darwin", "macos", "apple"];
    case "linux":
      return ["linux"];
    case "win32":
      return ["windows", "win32", "win"];
    default:
      return [platform];
  }
}

export function copilotAssetArchTokens(arch: NodeJS.Architecture): ReadonlyArray<string> {
  switch (arch) {
    case "arm64":
      return ["arm64", "aarch64"];
    case "x64":
      return ["x64", "amd64", "x86_64"];
    default:
      return [arch];
  }
}

export function selectCopilotReleaseAsset(input: {
  readonly release: CopilotRelease;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
}): CopilotReleaseAsset {
  const platformTokens = copilotAssetPlatformTokens(input.platform ?? process.platform);
  const archTokens = copilotAssetArchTokens(input.arch ?? process.arch);
  const archiveAssets = input.release.assets.filter(
    (asset) =>
      !SHA256SUMS_ASSET_NAMES.has(asset.name) && /\.(?:zip|tar\.gz|tgz)$/i.test(asset.name),
  );
  const selected = archiveAssets.find((asset) => {
    const lowerName = asset.name.toLowerCase();
    return (
      platformTokens.some((token) => lowerName.includes(token)) &&
      archTokens.some((token) => lowerName.includes(token))
    );
  });

  if (!selected) {
    throw new Error(
      `No GitHub Copilot CLI release asset matched ${input.platform ?? process.platform}/${
        input.arch ?? process.arch
      }.`,
    );
  }
  return selected;
}

export function parseSha256Sums(contents: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    const expectedHex = match?.[1];
    const fileName = match?.[2];
    if (expectedHex && fileName) {
      sums.set(basename(fileName), expectedHex.toLowerCase());
    }
  }
  return sums;
}

export function verifySha256(input: {
  readonly bytes: Uint8Array;
  readonly expectedHex: string;
}): void {
  const actual = createHash("sha256").update(input.bytes).digest("hex");
  if (actual !== input.expectedHex.toLowerCase()) {
    throw new Error(
      `Checksum mismatch for GitHub Copilot CLI archive. Expected ${input.expectedHex}, got ${actual}.`,
    );
  }
}

export async function installManagedCopilot(
  input: InstallManagedCopilotInput,
): Promise<CopilotManagedInstallResult> {
  const release = await input.fetchRelease();
  const asset = selectCopilotReleaseAsset({
    release,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.arch ? { arch: input.arch } : {}),
  });
  const sumsAsset = release.assets.find((candidate) => SHA256SUMS_ASSET_NAMES.has(candidate.name));
  const archiveBytes = await input.fetchBytes(asset.browser_download_url);

  if (sumsAsset) {
    const sumsBytes = await input.fetchBytes(sumsAsset.browser_download_url);
    const sums = parseSha256Sums(new TextDecoder().decode(sumsBytes));
    const expected = sums.get(basename(asset.name));
    if (!expected) {
      throw new Error(`No checksum entry found for ${asset.name}.`);
    }
    verifySha256({ bytes: archiveBytes, expectedHex: expected });
  }

  const installDir = getManagedCopilotInstallDir(input.stateDir);
  const archivePath = join(installDir, "downloads", asset.name);
  await input.makeDirectory(join(installDir, "downloads"));
  await input.makeDirectory(join(installDir, "bin"));
  await input.writeFile(archivePath, archiveBytes);
  const binaryPath = await input.extractArchive({
    archivePath,
    destinationDir: join(installDir, "bin"),
    binaryName:
      (input.platform ?? process.platform) === "win32" ? "copilot.exe" : COPILOT_BINARY_NAME,
  });

  return {
    version: release.tag_name ?? null,
    binaryPath,
    assetName: asset.name,
    archivePath,
  };
}
