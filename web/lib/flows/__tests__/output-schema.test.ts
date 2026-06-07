import { describe, expect, it } from "vitest";

import { validateStructuredOutput } from "@/lib/flows/output-schema";

describe("validateStructuredOutput — scalar types", () => {
  it("string: passes valid, fails wrong type", () => {
    const schema = {
      schemaVersion: 1,
      fields: [{ name: "title", type: "string", required: true }],
    };

    expect(validateStructuredOutput({ title: "hello" }, schema)).toEqual({
      ok: true,
    });
    expect(validateStructuredOutput({ title: 42 }, schema).ok).toBe(false);
  });

  it("number: passes finite, fails non-finite/non-number", () => {
    const schema = {
      schemaVersion: 1,
      fields: [{ name: "count", type: "number", required: true }],
    };

    expect(validateStructuredOutput({ count: 7 }, schema)).toEqual({
      ok: true,
    });
    expect(validateStructuredOutput({ count: "7" }, schema).ok).toBe(false);
    expect(validateStructuredOutput({ count: Number.NaN }, schema).ok).toBe(
      false,
    );
  });

  it("boolean: passes valid, fails wrong type", () => {
    const schema = {
      schemaVersion: 1,
      fields: [{ name: "done", type: "boolean", required: true }],
    };

    expect(validateStructuredOutput({ done: true }, schema)).toEqual({
      ok: true,
    });
    expect(validateStructuredOutput({ done: "true" }, schema).ok).toBe(false);
  });

  it("enum: passes allowed, fails disallowed", () => {
    const schema = {
      schemaVersion: 1,
      fields: [
        {
          name: "status",
          type: "enum",
          required: true,
          options: ["pass", "fail"],
        },
      ],
    };

    expect(validateStructuredOutput({ status: "pass" }, schema)).toEqual({
      ok: true,
    });
    expect(validateStructuredOutput({ status: "maybe" }, schema).ok).toBe(
      false,
    );
  });

  it("array: passes array, fails non-array", () => {
    const schema = {
      schemaVersion: 1,
      fields: [{ name: "items", type: "array", required: true }],
    };

    expect(validateStructuredOutput({ items: [1, 2] }, schema)).toEqual({
      ok: true,
    });
    expect(validateStructuredOutput({ items: "nope" }, schema).ok).toBe(false);
  });

  it("optional field absent is allowed", () => {
    const schema = {
      schemaVersion: 1,
      fields: [{ name: "note", type: "string" }],
    };

    expect(validateStructuredOutput({}, schema)).toEqual({ ok: true });
  });

  it("required field absent fails", () => {
    const schema = {
      schemaVersion: 1,
      fields: [{ name: "note", type: "string", required: true }],
    };

    expect(validateStructuredOutput({}, schema).ok).toBe(false);
  });
});

describe("validateStructuredOutput — nested object", () => {
  const schema = {
    schemaVersion: 1,
    fields: [
      {
        name: "result",
        type: "object",
        required: true,
        fields: [
          { name: "ok", type: "boolean", required: true },
          { name: "score", type: "number", required: true },
        ],
      },
    ],
  };

  it("passes a well-formed nested object", () => {
    expect(
      validateStructuredOutput({ result: { ok: true, score: 0.9 } }, schema),
    ).toEqual({ ok: true });
  });

  it("fails when a required nested field is missing", () => {
    const r = validateStructuredOutput({ result: { ok: true } }, schema);

    expect(r.ok).toBe(false);
  });

  it("fails when a nested field has the wrong type", () => {
    const r = validateStructuredOutput(
      { result: { ok: "yes", score: 0.9 } },
      schema,
    );

    expect(r.ok).toBe(false);
  });

  it("fails when the object value is not an object", () => {
    const r = validateStructuredOutput({ result: "nope" }, schema);

    expect(r.ok).toBe(false);
  });

  it("allows an optional nested object to be absent", () => {
    const optSchema = {
      schemaVersion: 1,
      fields: [
        {
          name: "meta",
          type: "object",
          fields: [{ name: "k", type: "string", required: true }],
        },
      ],
    };

    expect(validateStructuredOutput({}, optSchema)).toEqual({ ok: true });
  });
});

describe("validateStructuredOutput — deeply nested (2 levels)", () => {
  const schema = {
    schemaVersion: 1,
    fields: [
      {
        name: "outer",
        type: "object",
        required: true,
        fields: [
          {
            name: "inner",
            type: "object",
            required: true,
            fields: [{ name: "leaf", type: "string", required: true }],
          },
        ],
      },
    ],
  };

  it("passes a valid 2-level structure", () => {
    expect(
      validateStructuredOutput({ outer: { inner: { leaf: "x" } } }, schema),
    ).toEqual({ ok: true });
  });

  it("fails on a wrong type two levels deep", () => {
    const r = validateStructuredOutput(
      { outer: { inner: { leaf: 123 } } },
      schema,
    );

    expect(r.ok).toBe(false);
  });

  it("fails on a missing field two levels deep", () => {
    const r = validateStructuredOutput({ outer: { inner: {} } }, schema);

    expect(r.ok).toBe(false);
  });
});

describe("validateStructuredOutput — malformed inputs", () => {
  it("rejects a non-object value", () => {
    const schema = { schemaVersion: 1, fields: [] };

    expect(validateStructuredOutput("nope", schema).ok).toBe(false);
    expect(validateStructuredOutput(null, schema).ok).toBe(false);
    expect(validateStructuredOutput([1, 2], schema).ok).toBe(false);
  });

  it("rejects a malformed schema", () => {
    expect(validateStructuredOutput({}, null).ok).toBe(false);
    expect(validateStructuredOutput({}, { fields: "nope" }).ok).toBe(false);
  });
});
