import * as Schema from "effect/Schema";
import { buildIdentity, buildRevision } from "../buildIdentity.ts";

const ServiceInstallation = Schema.Struct({
  version: Schema.String,
  revision: Schema.String,
  invocation: Schema.Struct({
    cwd: Schema.String,
    host: Schema.optional(Schema.String),
    port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))),
  }),
});
export const decodeServiceInstallation = Schema.decodeUnknownSync(
  Schema.fromJsonString(ServiceInstallation),
);
export const serializeServiceInstallation = (
  invocation: (typeof ServiceInstallation.Type)["invocation"],
) => `${JSON.stringify({ version: buildIdentity.version, revision: buildRevision, invocation })}\n`;

export function isCurrentServiceInstallation(contents: string) {
  const value = contents.trim();
  return value.startsWith("{")
    ? decodeServiceInstallation(value).revision === buildRevision
    : value === buildRevision;
}
