import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import { DateTime, Schema } from "effect";

import { ClientActivityReportInput } from "./background.ts";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/background/official-ios-client-activity.json",
);

it("decodes the pinned App Store iOS activity report", () => {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  const decode = Schema.decodeUnknownSync(ClientActivityReportInput);

  expect(
    decode({
      ...fixture,
      observedAt: DateTime.makeUnsafe(String(fixture.observedAt)),
    }),
  ).toMatchObject({
    environmentId: "env-official-ios",
    clientKind: "mobile",
    appState: "active",
    scopes: [{ type: "provider-status" }],
    ttlMs: 45_000,
  });
});
