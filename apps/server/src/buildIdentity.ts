import packageJson from "../package.json" with { type: "json" };

declare const __T3CODE_BUILD_COMMIT__: string;
declare const __T3CODE_BUILD_CHANNEL__: string;

export const buildIdentity = {
  distribution: "ronak-guliani/t3code",
  version: packageJson.version,
  channel: typeof __T3CODE_BUILD_CHANNEL__ === "undefined" ? "source" : __T3CODE_BUILD_CHANNEL__,
  commit: typeof __T3CODE_BUILD_COMMIT__ === "undefined" ? null : __T3CODE_BUILD_COMMIT__ || null,
};
export const buildRevision = buildIdentity.commit
  ? `${buildIdentity.version}@${buildIdentity.commit}`
  : buildIdentity.version;
