import { describe, expect, it } from "vitest";

import { serializeFormSchema } from "@/lib/flows/editor/form-schema-edit";
import {
  buildSchemaWriteFromRef,
  buildSchemaWriteFromTitle,
} from "@/lib/flows/editor/schema-ref-actions";

const VALID_SCHEMA = JSON.stringify({
  schemaVersion: 1,
  fields: [{ name: "decision", type: "string" }],
});

describe("schema ref actions", () => {
  it("builds a validated write intent from a title", () => {
    const result = buildSchemaWriteFromTitle("Review intake", [], VALID_SCHEMA);

    expect(result).toEqual({
      ok: true,
      path: "schemas/review-intake.json",
      ref: "./schemas/review-intake.json",
      content: serializeFormSchema({
        schemaVersion: 1,
        fields: [{ name: "decision", type: "string" }],
      }),
    });
  });

  it("appends a numeric suffix when the derived schema file exists", () => {
    const result = buildSchemaWriteFromTitle(
      "Review intake",
      ["schemas/review-intake.json"],
      VALID_SCHEMA,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe("schemas/review-intake-2.json");
      expect(result.ref).toBe("./schemas/review-intake-2.json");
    }
  });

  it("reuses the existing schemas path when editing a ref", () => {
    const result = buildSchemaWriteFromRef(
      "./schemas/review.json",
      VALID_SCHEMA,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe("schemas/review.json");
      expect(result.ref).toBe("./schemas/review.json");
    }
  });

  it("rejects edit intents outside root schemas json files", () => {
    for (const ref of [
      "README.md",
      "maister-package.yaml",
      "./flows/review/flow.yaml",
      "./schemas/nested/review.json",
    ]) {
      const result = buildSchemaWriteFromRef(ref, VALID_SCHEMA);

      expect(result).toEqual({
        ok: false,
        error: "schema ref must point at ./schemas/<name>.json",
      });
    }
  });

  it("returns an error and no write intent for invalid JSON", () => {
    const result = buildSchemaWriteFromTitle("Broken", [], "{ not json");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns an error and no write intent for JSON outside formSchemaSchema", () => {
    const result = buildSchemaWriteFromTitle(
      "Broken",
      [],
      JSON.stringify({ schemaVersion: 1 }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
