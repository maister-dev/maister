import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { formSchemaSchema } from "@/lib/config.schema";
import { validateHitlResponse } from "@/lib/flows/hitl-validate";

// The shipped intake form_schema for the aif-dev flow's `intake` form node.
// Lives outside web/ (package content), resolved from the repo root.
const here = dirname(fileURLToPath(import.meta.url));
const intakePath = resolve(
  here,
  "../../../plugins/aif/flows/dev/schemas/intake.json",
);
const intakeDoc: unknown = JSON.parse(readFileSync(intakePath, "utf8"));

describe("aif dev intake form_schema (T4 inc3)", () => {
  it("parses under formSchemaSchema (schemaVersion 1)", () => {
    const parsed = formSchemaSchema.safeParse(intakeDoc);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schemaVersion).toBe(1);
      expect(parsed.data.fields.map((f) => f.name)).toEqual([
        "tests",
        "logging",
        "docs",
      ]);
    }
  });

  it("accepts a button-picked response", () => {
    expect(
      validateHitlResponse(
        { tests: "yes", logging: "verbose", docs: "no" },
        intakeDoc,
      ).ok,
    ).toBe(true);
  });

  it("accepts a free-text answer outside the option hints (string type)", () => {
    expect(
      validateHitlResponse(
        { tests: "only unit", logging: "normal", docs: "yes" },
        intakeDoc,
      ).ok,
    ).toBe(true);
  });

  it("rejects a response missing a required field", () => {
    expect(
      validateHitlResponse({ tests: "yes", logging: "verbose" }, intakeDoc).ok,
    ).toBe(false);
  });
});
