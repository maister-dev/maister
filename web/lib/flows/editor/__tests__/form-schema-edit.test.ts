// T4.6 (RED): pure builder⇄JSON sync reducer over `formSchemaSchema`.
// Unit-tests the field add/remove/reorder/update edits, the JSON parse/serialize
// round-trip, and the `formFieldsFromSchema` extraction on a nested object
// schema (reused from the HITL controls). Client-safe module — imports
// `@/lib/errors-core` only.
//
// Contract (module not built yet — RED on the missing imports):
//   web/lib/flows/editor/form-schema-edit.ts exports
//     parseFormSchemaJson(text): { ok: true; schema } | { ok: false; error }
//     serializeFormSchema(schema): string
//     applyFieldEdit(schema, edit): FormSchema
//       edit ∈ { kind: "add"; path }
//             | { kind: "remove"; path }
//             | { kind: "move"; path; direction: "up" | "down" }
//             | { kind: "update"; path; patch }

import type { FormSchema } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { formFieldsFromSchema } from "@/components/board/hitl-decision-controls";
import { formSchemaSchema } from "@/lib/config.schema";
import {
  applyFieldEdit,
  parseFormSchemaJson,
  serializeFormSchema,
} from "@/lib/flows/editor/form-schema-edit";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FLAT: FormSchema = {
  schemaVersion: 1,
  fields: [
    { name: "tests", label: "Tests", type: "enum", options: ["yes", "no"] },
    { name: "logging", type: "string", required: true },
  ],
};

const NESTED: FormSchema = {
  schemaVersion: 1,
  fields: [
    {
      name: "config",
      type: "object",
      fields: [
        { name: "host", type: "string" },
        { name: "port", type: "number" },
      ],
    },
  ],
};

// ─── parseFormSchemaJson ─────────────────────────────────────────────────────

describe("parseFormSchemaJson", () => {
  it("returns ok with the parsed schema for a valid form-schema doc", () => {
    const result = parseFormSchemaJson(JSON.stringify(FLAT));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schema.fields).toHaveLength(2);
      expect(result.schema.fields[0].name).toBe("tests");
    }
  });

  it("preserves schema and field extension keys", () => {
    const result = parseFormSchemaJson(
      JSON.stringify({
        schemaVersion: 1,
        "x-form-layout": { columns: 2 },
        fields: [
          {
            name: "tests",
            type: "enum",
            options: ["yes", "no"],
            "x-widget": "segmented",
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = serializeFormSchema(result.schema);

    expect(serialized).toContain('"x-form-layout"');
    expect(serialized).toContain('"x-widget"');
  });

  it("returns an error for syntactically invalid JSON", () => {
    const result = parseFormSchemaJson("{ not json");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns an error for JSON that violates formSchemaSchema", () => {
    // `fields` missing → fails the zod schema.
    const result = parseFormSchemaJson(JSON.stringify({ schemaVersion: 1 }));

    expect(result.ok).toBe(false);
  });

  it("returns an error for a field with an unknown type", () => {
    const result = parseFormSchemaJson(
      JSON.stringify({
        schemaVersion: 1,
        fields: [{ name: "x", type: "datetime" }],
      }),
    );

    expect(result.ok).toBe(false);
  });
});

// ─── serializeFormSchema + round-trip ────────────────────────────────────────

describe("serializeFormSchema", () => {
  it("serializes to pretty JSON that parses back to an equal schema", () => {
    const text = serializeFormSchema(FLAT);

    expect(text).toContain("\n"); // pretty-printed, not minified

    const back = parseFormSchemaJson(text);

    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.schema).toEqual(FLAT);
    }
  });

  it("is stable across a schema→JSON→schema→JSON round-trip", () => {
    const once = serializeFormSchema(NESTED);
    const reparsed = parseFormSchemaJson(once);

    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(serializeFormSchema(reparsed.schema)).toBe(once);
    }
  });
});

// ─── applyFieldEdit: add ─────────────────────────────────────────────────────

describe("applyFieldEdit — add", () => {
  it("appends a new field at the top level", () => {
    const next = applyFieldEdit(FLAT, { kind: "add", path: [] });

    expect(next.fields).toHaveLength(3);
    // a fresh field gets a non-empty name and a default `string` type
    expect(next.fields[2].name.length).toBeGreaterThan(0);
    expect(next.fields[2].type).toBe("string");
  });

  it("appends a nested field into an object field's children", () => {
    const next = applyFieldEdit(NESTED, { kind: "add", path: [0] });
    const child = next.fields[0];

    expect(child.fields).toHaveLength(3);
  });

  it("does not mutate the input schema", () => {
    const snapshot = JSON.parse(JSON.stringify(FLAT)) as FormSchema;

    applyFieldEdit(FLAT, { kind: "add", path: [] });

    expect(FLAT).toEqual(snapshot);
  });
});

// ─── applyFieldEdit: remove ──────────────────────────────────────────────────

describe("applyFieldEdit — remove", () => {
  it("removes a top-level field by index path", () => {
    const next = applyFieldEdit(FLAT, { kind: "remove", path: [0] });

    expect(next.fields).toHaveLength(1);
    expect(next.fields[0].name).toBe("logging");
  });

  it("removes a nested field by index path", () => {
    const next = applyFieldEdit(NESTED, { kind: "remove", path: [0, 1] });
    const child = next.fields[0];

    expect(child.fields).toHaveLength(1);
    expect(child.fields?.[0].name).toBe("host");
  });
});

// ─── applyFieldEdit: move (reorder) ──────────────────────────────────────────

describe("applyFieldEdit — move", () => {
  it("moves a top-level field up", () => {
    const next = applyFieldEdit(FLAT, {
      kind: "move",
      path: [1],
      direction: "up",
    });

    expect(next.fields.map((f) => f.name)).toEqual(["logging", "tests"]);
  });

  it("moves a top-level field down", () => {
    const next = applyFieldEdit(FLAT, {
      kind: "move",
      path: [0],
      direction: "down",
    });

    expect(next.fields.map((f) => f.name)).toEqual(["logging", "tests"]);
  });

  it("is a no-op moving the first field up", () => {
    const next = applyFieldEdit(FLAT, {
      kind: "move",
      path: [0],
      direction: "up",
    });

    expect(next.fields.map((f) => f.name)).toEqual(["tests", "logging"]);
  });

  it("is a no-op moving the last field down", () => {
    const next = applyFieldEdit(FLAT, {
      kind: "move",
      path: [1],
      direction: "down",
    });

    expect(next.fields.map((f) => f.name)).toEqual(["tests", "logging"]);
  });

  it("reorders nested children", () => {
    const next = applyFieldEdit(NESTED, {
      kind: "move",
      path: [0, 1],
      direction: "up",
    });

    expect(next.fields[0].fields?.map((f) => f.name)).toEqual(["port", "host"]);
  });
});

// ─── applyFieldEdit: update ──────────────────────────────────────────────────

describe("applyFieldEdit — update", () => {
  it("renames a field", () => {
    const next = applyFieldEdit(FLAT, {
      kind: "update",
      path: [1],
      patch: { name: "log_level" },
    });

    expect(next.fields[1].name).toBe("log_level");
  });

  it("sets label/required/options/type via patch", () => {
    const next = applyFieldEdit(FLAT, {
      kind: "update",
      path: [1],
      patch: {
        label: "Log level",
        required: false,
        type: "enum",
        options: ["debug", "info"],
      },
    });

    expect(next.fields[1].label).toBe("Log level");
    expect(next.fields[1].required).toBe(false);
    expect(next.fields[1].type).toBe("enum");
    expect(next.fields[1].options).toEqual(["debug", "info"]);
  });

  it("updates a nested field", () => {
    const next = applyFieldEdit(NESTED, {
      kind: "update",
      path: [0, 0],
      patch: { name: "hostname" },
    });

    expect(next.fields[0].fields?.[0].name).toBe("hostname");
  });

  it("keeps extension keys on unrelated fields when editing", () => {
    const schema = parseFormSchemaJson(
      JSON.stringify({
        schemaVersion: 1,
        fields: [
          {
            name: "config",
            type: "object",
            "x-section": "advanced",
            fields: [
              {
                name: "host",
                type: "string",
                "x-placeholder": "localhost",
              },
              { name: "port", type: "number" },
            ],
          },
        ],
      }),
    );

    expect(schema.ok).toBe(true);
    if (!schema.ok) return;

    const next = applyFieldEdit(schema.schema, {
      kind: "update",
      path: [0, 1],
      patch: { name: "listen_port" },
    });

    expect(serializeFormSchema(next)).toContain('"x-section"');
    expect(serializeFormSchema(next)).toContain('"x-placeholder"');
  });

  it("keeps the result parseable by formSchemaSchema after an update", () => {
    const next = applyFieldEdit(FLAT, {
      kind: "update",
      path: [0],
      patch: { name: "tests_run" },
    });

    expect(() => formSchemaSchema.parse(next)).not.toThrow();
  });
});

// ─── formFieldsFromSchema extraction on a nested object schema ────────────────

describe("formFieldsFromSchema on a nested object schema", () => {
  it("extracts the top-level fields (preview reuses the HITL extractor)", () => {
    const views = formFieldsFromSchema(NESTED);

    expect(views).not.toBeNull();
    expect(views?.map((v) => v.name)).toEqual(["config"]);
  });

  it("extracts enum options for a flat field", () => {
    const views = formFieldsFromSchema(FLAT);

    expect(views?.[0].options).toEqual(["yes", "no"]);
  });

  it("returns null for a schema with no fields", () => {
    expect(formFieldsFromSchema({ schemaVersion: 1, fields: [] })).toBeNull();
  });
});
