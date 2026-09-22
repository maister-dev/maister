import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";

import {
  validateAsyncApi,
  validateContracts,
  validateOpenApi,
} from "./validate-contracts.mjs";

async function withContractFile(extension, body, callback) {
  const directory = mkdtempSync(join(tmpdir(), "maister-contract-"));
  const file = join(directory, `invalid.${extension}`);
  writeFileSync(file, body, "utf8");

  try {
    return await callback(file);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("validates every registered contract through official parsers", async () => {
  await validateContracts({ log: false });
});

test("rejects an OpenAPI document that fails official meta-schema validation", async () => {
  await assert.rejects(
    withContractFile(
      "yaml",
      "openapi: 3.0.3\ninfo: { title: missing-version }\npaths: {}\n",
      (file) => validateOpenApi(file, { log: false }),
    ),
    /OpenAPI meta-schema validation failed/,
  );
});

test("rejects an AsyncAPI document that fails official meta-schema validation", async () => {
  await assert.rejects(
    withContractFile(
      "yaml",
      "asyncapi: 2.6.0\ninfo: { title: missing-version }\nchannels: {}\n",
      (file) => validateAsyncApi(file, { log: false }),
    ),
    /AsyncAPI meta-schema validation failed/,
  );
});

function assertExample(schema, value, document) {
  if (schema.$ref) {
    const parts = schema.$ref.split("/").slice(1);
    const target = parts.reduce((current, part) => current?.[part], document);

    assert.ok(target, `unresolved example schema ${schema.$ref}`);
    assertExample(target, value, document);
  }
  for (const member of schema.allOf ?? [])
    assertExample(member, value, document);
  if (value === null) {
    assert.equal(schema.nullable, true);
    return;
  }
  if (schema.type === "object") {
    assert.equal(typeof value, "object");
    assert.equal(Array.isArray(value), false);
    for (const key of schema.required ?? [])
      assert.ok(Object.hasOwn(value, key), `missing ${key}`);
    for (const [key, child] of Object.entries(value)) {
      const property = schema.properties?.[key];

      if (!property) {
        assert.notEqual(
          schema.additionalProperties,
          false,
          `unexpected ${key}`,
        );
        continue;
      }
      assertExample(property, child, document);
    }
  } else if (schema.type === "string") {
    assert.equal(typeof value, "string");
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern));
  } else if (schema.type === "boolean") {
    assert.equal(typeof value, "boolean");
  } else if (schema.type === "number" || schema.type === "integer") {
    assert.equal(typeof value, "number");
    if (schema.type === "integer") assert.equal(Number.isInteger(value), true);
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum);
  }
  if (schema.enum)
    assert.ok(schema.enum.includes(value), `unexpected enum value ${value}`);
}

test("HITL respond refusal examples satisfy both public response contracts", () => {
  for (const [file, path, prefix] of [
    [
      "../docs/api/web.openapi.yaml",
      "/api/runs/{runId}/hitl/{hitlRequestId}/respond",
      "HitlRespond",
    ],
    [
      "../docs/api/external/operations.openapi.yaml",
      "/api/v1/ext/runs/{runId}/hitl/{hitlRequestId}/respond",
      "ExtHitlRespond",
    ],
  ]) {
    const document = YAML.parse(
      readFileSync(new URL(file, import.meta.url), "utf8"),
    );
    const responses = document.paths[path].post.responses;
    const examples = [
      ["410", "agent-session-ended", `${prefix}TerminalError`],
      ["503", "answer-saved", `${prefix}SavedError`],
    ];

    if (prefix === "HitlRespond")
      examples.push(["409", "resume-owns-delivery", `${prefix}ErrorBody`]);
    for (const [status, name, component] of examples) {
      const value =
        responses[status].content["application/json"].examples[name].value;

      assertExample(document.components.schemas[component], value, document);
      assert.throws(() =>
        assertExample(
          document.components.schemas[component],
          {
            ...value,
            details: {
              reason: "not_a_public_reason",
              privateSessionId: "secret",
            },
          },
          document,
        ),
      );
    }
  }
});

test("external HITL success and pending bodies accept the shipped runStatus variants", () => {
  const document = YAML.parse(
    readFileSync(
      new URL("../docs/api/external/operations.openapi.yaml", import.meta.url),
      "utf8",
    ),
  );
  const schemas = document.components.schemas;

  for (const body of [
    { ok: true, state: "delivered" },
    { ok: true, state: "delivered", runStatus: "Done" },
  ])
    assertExample(schemas.ExtHitlRespondResponse, body, document);
  for (const body of [
    { ok: true, state: "delivery-in-progress" },
    { ok: true, state: "resume-in-progress", runStatus: "NeedsInputIdle" },
  ])
    assertExample(schemas.ExtHitlRespondAccepted, body, document);
  assert.throws(() =>
    assertExample(
      schemas.ExtHitlRespondAccepted,
      { ok: true, state: "delivered" },
      document,
    ),
  );
});
