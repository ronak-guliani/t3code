import { expect, it } from "vitest";
import { buildRevision } from "../buildIdentity.ts";
import {
  decodeServiceInstallation,
  isCurrentServiceInstallation,
  serializeServiceInstallation,
} from "./serviceInstallation.ts";

it("persists startup settings and identifies the exact bundled revision", () => {
  const invocation = { cwd: "/projects", host: "127.0.0.1", port: 13773 };
  const encoded = serializeServiceInstallation(invocation);
  expect(decodeServiceInstallation(encoded)).toMatchObject({ revision: buildRevision, invocation });
  expect(isCurrentServiceInstallation(encoded)).toBe(true);
  expect(
    isCurrentServiceInstallation(JSON.stringify({ ...JSON.parse(encoded), revision: "old" })),
  ).toBe(false);
});
it("rejects malformed saved invocations rather than changing bind defaults", () => {
  expect(() =>
    decodeServiceInstallation('{"version":"1","revision":"1","invocation":{"cwd":"/x","port":0}}'),
  ).toThrow();
});
