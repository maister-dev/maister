import { describe, expect, it } from "vitest";

import {
  MAX_OUTPUT_ARRAY_LENGTH,
  MAX_OUTPUT_DEPTH,
  MAX_OUTPUT_OBJECT_KEYS,
  validateStructuredOutput,
} from "@/lib/flows/output-schema";

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

// --- ADR-162 (Wave 3) -------------------------------------------------------

describe("validateStructuredOutput — json field type (AC-1)", () => {
  const schema = {
    schemaVersion: 1,
    fields: [{ name: "payload", type: "json", required: true }],
  };

  it("treats an explicit null as PRESENT for json only", () => {
    expect(validateStructuredOutput({ payload: null }, schema)).toEqual({
      ok: true,
    });
  });

  it("fails a required json field when the key is missing", () => {
    const r = validateStructuredOutput({}, schema);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("required");
  });

  it("accepts any JSON value", () => {
    for (const value of [
      "text",
      0,
      -1.5,
      true,
      false,
      [],
      [1, "two", { three: 3 }],
      {},
      { nested: { deep: [null, 1] } },
    ]) {
      expect(validateStructuredOutput({ payload: value }, schema)).toEqual({
        ok: true,
      });
    }
  });

  it("keeps null = absent for every non-json type", () => {
    const strict = {
      schemaVersion: 1,
      fields: [{ name: "title", type: "string", required: true }],
    };

    expect(validateStructuredOutput({ title: null }, strict).ok).toBe(false);
  });
});

describe("validateStructuredOutput — typed array items (AC-2)", () => {
  it("validates each element and names field[i] on a violation", () => {
    const schema = {
      schemaVersion: 1,
      fields: [
        {
          name: "tags",
          type: "array",
          required: true,
          items: { type: "string" },
        },
      ],
    };

    expect(validateStructuredOutput({ tags: ["a", "b"] }, schema)).toEqual({
      ok: true,
    });

    const r = validateStructuredOutput({ tags: ["a", 2] }, schema);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("tags[1]");
  });

  it("validates object items recursively", () => {
    const schema = {
      schemaVersion: 1,
      fields: [
        {
          name: "rows",
          type: "array",
          required: true,
          items: {
            type: "object",
            fields: [{ name: "id", type: "string", required: true }],
          },
        },
      ],
    };

    expect(
      validateStructuredOutput({ rows: [{ id: "x" }, { id: "y" }] }, schema),
    ).toEqual({ ok: true });

    const r = validateStructuredOutput({ rows: [{ id: "x" }, {}] }, schema);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("rows[1]");
  });

  it("validates nested array items", () => {
    const schema = {
      schemaVersion: 1,
      fields: [
        {
          name: "matrix",
          type: "array",
          required: true,
          items: { type: "array", items: { type: "number" } },
        },
      ],
    };

    expect(validateStructuredOutput({ matrix: [[1, 2], [3]] }, schema)).toEqual(
      { ok: true },
    );
    expect(
      validateStructuredOutput({ matrix: [[1], ["nope"]] }, schema).ok,
    ).toBe(false);
  });

  it("rejects a null element under a typed items (elements are never optional)", () => {
    // `null` = absent applies to FIELDS, which can be optional. An array
    // element has no optionality, so a typed items rejects null rather than
    // silently treating it as an absent value.
    const schema = {
      schemaVersion: 1,
      fields: [
        {
          name: "tags",
          type: "array",
          required: true,
          items: { type: "string" },
        },
      ],
    };
    const r = validateStructuredOutput({ tags: ["a", null] }, schema);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("tags[1]");
  });

  it("accepts a null element under items: { type: json }", () => {
    const schema = {
      schemaVersion: 1,
      fields: [
        {
          name: "rows",
          type: "array",
          required: true,
          items: { type: "json" },
        },
      ],
    };

    expect(
      validateStructuredOutput({ rows: [null, 1, { a: 1 }] }, schema),
    ).toEqual({ ok: true });
  });

  it("leaves an items-less array untyped (mixed elements pass)", () => {
    const schema = {
      schemaVersion: 1,
      fields: [{ name: "items", type: "array", required: true }],
    };

    expect(
      validateStructuredOutput({ items: [1, "two", null, { k: 1 }] }, schema),
    ).toEqual({ ok: true });
  });
});

describe("validateStructuredOutput — open objects (AC-3)", () => {
  const schema = {
    schemaVersion: 1,
    fields: [
      {
        name: "result",
        type: "object",
        required: true,
        fields: [{ name: "ok", type: "boolean", required: true }],
      },
    ],
  };

  it("passes undeclared keys at the top level and nested", () => {
    expect(
      validateStructuredOutput(
        {
          result: { ok: true, extra: { deep: [1, 2] } },
          undeclaredTop: "kept",
        },
        schema,
      ),
    ).toEqual({ ok: true });
  });

  it("does not mutate or strip the validated value", () => {
    const value = {
      result: { ok: true, extra: { deep: [1, 2] } },
      undeclaredTop: "kept",
    };
    const snapshot = JSON.parse(JSON.stringify(value)) as unknown;

    expect(validateStructuredOutput(value, schema)).toEqual({ ok: true });
    expect(value).toEqual(snapshot);
  });
});

describe("validateStructuredOutput — unsafe keys (AC-4)", () => {
  const schema = { schemaVersion: 1, fields: [] };

  it("rejects an unsafe own key at the top level, naming the path", () => {
    const value = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    const r = validateStructuredOutput(value, schema);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("__proto__");
  });

  it("rejects constructor / prototype own keys", () => {
    expect(validateStructuredOutput({ constructor: 1 }, schema).ok).toBe(false);
    expect(validateStructuredOutput({ prototype: 1 }, schema).ok).toBe(false);
  });

  it("rejects an unsafe key nested inside arrays and objects, naming the path", () => {
    const value = JSON.parse(
      '{"a": {"b": [{"__proto__": {"x": 1}}]}}',
    ) as unknown;
    const r = validateStructuredOutput(value, schema);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("a.b[0].__proto__");
  });

  it("runs before field checks (an unsafe key beats a required-field error)", () => {
    const required = {
      schemaVersion: 1,
      fields: [{ name: "title", type: "string", required: true }],
    };
    const value = JSON.parse('{"__proto__": {"x": 1}}') as unknown;
    const r = validateStructuredOutput(value, required);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("__proto__");
    expect(r.ok === false && r.message).not.toContain("required");
  });
});

describe("validateStructuredOutput — structural limits (AC-5)", () => {
  const schema = { schemaVersion: 1, fields: [] };

  function nest(depth: number): Record<string, unknown> {
    let node: Record<string, unknown> = { leaf: 1 };

    for (let i = 1; i < depth; i += 1) node = { n: node };

    return node;
  }

  it("accepts a payload at MAX_OUTPUT_DEPTH and rejects depth + 1", () => {
    expect(validateStructuredOutput(nest(MAX_OUTPUT_DEPTH), schema)).toEqual({
      ok: true,
    });

    const r = validateStructuredOutput(nest(MAX_OUTPUT_DEPTH + 1), schema);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain(String(MAX_OUTPUT_DEPTH));
  });

  it("accepts MAX_OUTPUT_OBJECT_KEYS and rejects one more", () => {
    const atLimit: Record<string, unknown> = {};

    for (let i = 0; i < MAX_OUTPUT_OBJECT_KEYS; i += 1) atLimit[`k${i}`] = 1;

    expect(validateStructuredOutput(atLimit, schema)).toEqual({ ok: true });

    const over = { ...atLimit, overflow: 1 };
    const r = validateStructuredOutput(over, schema);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain(
      String(MAX_OUTPUT_OBJECT_KEYS),
    );
  });

  it("accepts MAX_OUTPUT_ARRAY_LENGTH and rejects one more", () => {
    const atLimit = { list: new Array(MAX_OUTPUT_ARRAY_LENGTH).fill(1) };

    expect(validateStructuredOutput(atLimit, schema)).toEqual({ ok: true });

    const over = { list: new Array(MAX_OUTPUT_ARRAY_LENGTH + 1).fill(1) };
    const r = validateStructuredOutput(over, schema);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain(
      String(MAX_OUTPUT_ARRAY_LENGTH),
    );
  });
});
