import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import Ajv from "ajv";

import { HITL_RESPOND_REASONS } from "../web/lib/hitl-response-contract.ts";

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

function readContract(file) {
  return YAML.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
}

function schemaValidator(document, namespace, component) {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    validateFormats: false,
  });

  ajv.addSchema(document, namespace);
  const validate = ajv.getSchema(
    `${namespace}#/components/schemas/${component}`,
  );

  assert.ok(validate, `missing schema ${component}`);
  return validate;
}

function assertValidExample(validate, body) {
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
}

test("HITL respond reason enums agree with the TypeScript contract", () => {
  for (const file of [
    "../docs/api/web.openapi.yaml",
    "../docs/api/external/operations.openapi.yaml",
  ]) {
    const document = readContract(file);

    assert.deepEqual(
      document.components.schemas.HitlRespondReason.enum,
      [...HITL_RESPOND_REASONS],
      file,
    );
  }
});

test("HITL refusal examples satisfy real JSON Schema validation", () => {
  for (const [file, route, namespace, prefix] of [
    [
      "../docs/api/web.openapi.yaml",
      "/api/runs/{runId}/hitl/{hitlRequestId}/respond",
      "web",
      "HitlRespond",
    ],
    [
      "../docs/api/external/operations.openapi.yaml",
      "/api/v1/ext/runs/{runId}/hitl/{hitlRequestId}/respond",
      "external",
      "ExtHitlRespond",
    ],
  ]) {
    const document = readContract(file);
    const responses = document.paths[route].post.responses;
    const examples = [
      ["410", "agent-session-ended", `${prefix}TerminalError`],
      ["410", "permission-delivery-rejected", `${prefix}TerminalError`],
      ["503", "answer-saved", `${prefix}SavedError`],
    ];

    if (namespace === "web")
      examples.push(["409", "resume-owns-delivery", `${prefix}ErrorBody`]);
    for (const [status, name, component] of examples) {
      const value =
        responses[status].content["application/json"].examples[name].value;
      const validate = schemaValidator(document, namespace, component);

      assertValidExample(validate, value);
      assert.equal(
        validate({ ...value, details: { reason: "not_a_public_reason" } }),
        false,
        `${component} must reject an unknown reason`,
      );
      assert.equal(
        validate({
          ...value,
          details: { ...value.details, privateSessionId: "secret" },
        }),
        false,
        `${component} must reject private detail fields`,
      );
    }
  }
});

test("external HITL inbox example includes every required read-state field", () => {
  const document = readContract("../docs/api/external/operations.openapi.yaml");
  const body =
    document.paths["/api/v1/ext/hitl"].get.responses["200"].content[
      "application/json"
    ].examples.default.value;
  const validate = schemaValidator(document, "external", "ExtHitlInboxItem");

  assert.equal(body.count, body.items.length);
  for (const item of body.items) assertValidExample(validate, item);
  assert.equal(validate({ ...body.items[0], answerState: undefined }), false);
});

test("external HITL success and pending bodies accept the shipped runStatus variants", () => {
  const document = readContract("../docs/api/external/operations.openapi.yaml");
  const delivered = schemaValidator(
    document,
    "external",
    "ExtHitlRespondResponse",
  );
  const pending = schemaValidator(
    document,
    "external",
    "ExtHitlRespondAccepted",
  );

  for (const body of [
    { ok: true, state: "delivered" },
    { ok: true, state: "delivered", runStatus: "Done" },
  ])
    assertValidExample(delivered, body);
  for (const body of [
    { ok: true, state: "delivery-in-progress" },
    { ok: true, state: "resume-in-progress", runStatus: "NeedsInputIdle" },
  ])
    assertValidExample(pending, body);
  assert.equal(pending({ ok: true, state: "delivered" }), false);
});
