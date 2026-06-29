import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DefectSchema } from "./baseSchemas.ts";

describe("DefectSchema", () => {
  it("can be embedded in optional schema fields", () => {
    expect(() =>
      Schema.Struct({
        cause: Schema.optional(DefectSchema),
      }),
    ).not.toThrow();
  });
});
