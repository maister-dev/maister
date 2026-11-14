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

async function withBrokenLibrarianStream(mutate, callback) {
  const document = readContract(
    "../docs/api/async/librarian-stream.asyncapi.yaml",
  );
  mutate(document.components.schemas);
  return withContractFile("yaml", YAML.stringify(document), callback);
}

test("librarian stream contract rejects a frame that carries a message body", async () => {
  await assert.rejects(
    withBrokenLibrarianStream(
      (schemas) => {
        schemas.LibrarianMessageEvent.properties.body = { type: "string" };
      },
      (file) => validateAsyncApi(file, { log: false }),
    ),
    /LibrarianMessageEvent must not carry a message body/,
  );
});

test("librarian stream contract rejects a heartbeat that carries a frame id", async () => {
  await assert.rejects(
    withBrokenLibrarianStream(
      (schemas) => {
        schemas.LibrarianHeartbeatEvent.properties.id = {
          type: "string",
          pattern: "^(0|[1-9][0-9]{0,18})$",
        };
      },
      (file) => validateAsyncApi(file, { log: false }),
    ),
    /LibrarianHeartbeatEvent must not carry a frame id/,
  );
});

test("librarian work invalidation cannot carry a replay cursor", async () => {
  await assert.rejects(
    withBrokenLibrarianStream(
      (schemas) => {
        schemas.LibrarianWorkEvent.properties.seq = { type: "string" };
      },
      (file) => validateAsyncApi(file, { log: false }),
    ),
    /LibrarianWorkEvent must contain only type and reason/,
  );
});

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

test("interactive runner drafts remain exclusive to the browser contract", () => {
  const web = readContract("../docs/api/web.openapi.yaml");
  const external = readContract("../docs/api/external/operations.openapi.yaml");
  const base = {
    taskId: "task-1",
    expectedTaskRevision: 0,
    expectedSettingsToken: "token-1",
  };
  const draft = {
    flowRevisionId: "revision-1",
    slots: { "session:reviewer": "runner-2" },
  };
  const browser = schemaValidator(web, "browser-draft", "InteractiveTaskLaunchBody");
  const legacy = schemaValidator(web, "legacy-draft", "TaskLaunchBody");
  const bearer = schemaValidator(external, "bearer-draft", "TaskLaunchBody");

  assertValidExample(browser, { ...base, flowRunnerDraft: draft });
  assert.equal(legacy({ ...base, flowRunnerDraft: draft }), false);
  assert.equal(bearer({ ...base, flowRunnerDraft: draft }), false);
  assert.equal(browser({ ...base, flowRunnerDraft: draft, runnerId: "runner-1" }), false);
  assert.equal(browser({ ...base, flowRunnerDraft: { flowRevisionId: "revision-1" } }), false);
});

function assertValidExample(validate, body) {
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
}

test("qualification source failures preserve neutral model-start uncertainty in Web and external contracts", () => {
  const schemas = [];

  for (const [namespace, file] of [
    ["web", "../docs/api/web.openapi.yaml"],
    ["external", "../docs/api/external/operations.openapi.yaml"],
  ]) {
    const document = readContract(file);
    const validate = schemaValidator(
      document,
      namespace,
      "TaskQualificationSummary",
    );
    const summary = {
      required: true,
      mode: "required",
      inputRevision: 2,
      qualificationRevision: null,
      qualificationId: null,
      decision: null,
      publicationState: null,
      freshness: "unassessed",
      blockedReason: "qualification_source_failed",
      nextActions: [],
      candidate: null,
      sourceFailure: {
        runId: "qualifier-run",
        stage: null,
        causeCode: null,
        modelStarted: null,
      },
    };

    assertValidExample(validate, summary);
    assertValidExample(validate, {
      ...summary,
      sourceFailure: {
        ...summary.sourceFailure,
        stage: "baseline",
        causeCode: "ENOENT",
        modelStarted: false,
      },
    });
    for (const details of [
      { stage: "baseline" },
      { causeCode: "ENOENT" },
      { stage: "baseline", causeCode: "ENOENT" },
    ]) {
      assert.equal(
        validate({
          ...summary,
          sourceFailure: { ...summary.sourceFailure, ...details },
        }),
        false,
        "neutral source failure cannot claim proven preparation details",
      );
    }
    assert.equal(
      validate({
        ...summary,
        sourceFailure: { ...summary.sourceFailure, modelStarted: true },
      }),
      false,
    );
    assert.equal(
      validate({
        ...summary,
        sourceFailure: {
          ...summary.sourceFailure,
          privateSource: "not public",
        },
      }),
      false,
    );
    schemas.push(
      document.components.schemas.TaskQualificationSummary.properties
        .sourceFailure,
    );
  }

  assert.deepEqual(schemas[1], schemas[0]);
});

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
      ["410", "permission-not-pending", `${prefix}TerminalError`],
      ["410", "permission-delivery-rejected", `${prefix}TerminalError`],
      ["503", "answer-saved", `${prefix}SavedError`],
      ["409", "session-ended", `${prefix}ErrorBody`],
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

test("task launch request contracts preserve complete delivery and execution settings without accepting client authority", () => {
  const request = {
    taskId: "task-fixture",
    expectedTaskRevision: 0,
    expectedSettingsToken: "resolution-fixture",
    flowId: "flow-fixture",
    runnerId: "runner-fixture",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    targetBranch: "main",
    deliveryPolicy: {
      strategy: "pull_request",
      push: "on_success",
      trigger: "auto_on_ready",
      targetBranch: null,
    },
    executionPolicy: {
      preset: "assisted",
      overrides: {
        reworkExhaustion: "escalate",
        crashRetry: "auto_retry",
        checks: "strict",
        permissions: "ask",
        humanGate: "stop",
        onStuck: "escalate",
        promotion: "manual",
        commits: "keep_all",
        dirtyResolve: "ask",
        onBudgetBreach: "terminate_restorable",
        budget: {
          run: {
            maxTokens: 1000,
            hardMaxTokens: 2000,
            consecutiveFailures: 2,
            wallClockMinutes: 3,
            warnAtPct: 80,
          },
          task: { maxTokens: null },
          tree: {},
        },
      },
    },
    autoPromote: true,
  };

  for (const file of [
    "../docs/api/web.openapi.yaml",
    "../docs/api/external/operations.openapi.yaml",
  ]) {
    const document = readContract(file);
    const launch = schemaValidator(
      document,
      `launch-request-${file}`,
      "TaskLaunchBody",
    );
    const replace = schemaValidator(
      document,
      `replace-request-${file}`,
      "TaskLaunchReplaceBody",
    );
    const cancel = schemaValidator(
      document,
      `cancel-request-${file}`,
      "TaskLaunchCancelBody",
    );

    assertValidExample(launch, request);
    const agentRequest = {
      taskId: request.taskId,
      expectedTaskRevision: request.expectedTaskRevision,
      expectedSettingsToken: request.expectedSettingsToken,
      agentId: "core:implementer",
      workspace: "none",
      runnerId: "codex-sol",
    };

    assertValidExample(launch, agentRequest);
    assertValidExample(replace, { ...agentRequest, expectedStateVersion: 1 });
    assert.equal(launch({ ...request, agentId: agentRequest.agentId }), false);
    assert.equal(launch({ ...request, workspace: "none" }), false);
    assert.equal(launch({ ...agentRequest, workspace: "invalid" }), false);
    assertValidExample(replace, { ...request, expectedStateVersion: 1 });
    assertValidExample(cancel, { expectedStateVersion: 1 });
    assert.equal(launch({ ...request, mode: "manual" }), false);
    assert.equal(launch({ ...request, baseCommit: "invalid-ref" }), false);
    assert.equal(
      launch({ ...request, expectedTaskRevision: Number.MAX_SAFE_INTEGER + 1 }),
      false,
    );
    assert.equal(
      launch({
        ...request,
        executionPolicy: {
          preset: "assisted",
          overrides: { budget: { run: { maxTokens: 0 } } },
        },
      }),
      false,
    );
    assert.equal(
      launch({
        ...request,
        executionPolicy: {
          preset: "assisted",
          overrides: { skipProtection: true },
        },
      }),
      false,
    );
    assert.equal(replace(request), false);
    assert.equal(cancel({ expectedStateVersion: 0 }), false);
    assert.equal(
      cancel({ expectedStateVersion: 1, actorUserId: "forged" }),
      false,
    );
  }
});

test("task launch receipts validate their real examples and distinguish Flow and repository-free agent snapshots", () => {
  for (const file of [
    "../docs/api/web.openapi.yaml",
    "../docs/api/external/operations.openapi.yaml",
  ]) {
    const document = readContract(file);
    const validate = schemaValidator(
      document,
      `launch-${file}`,
      "TaskLaunchReceipt",
    );
    const example = document.components.schemas.TaskLaunchReceipt.example;
    const error = schemaValidator(
      document,
      `launch-error-${file}`,
      "TaskLaunchError",
    );
    const conflict = {
      code: "CONFLICT",
      message: "This task already has accepted delivery work",
      details: {
        reason: "launch_already_reserved",
        existing: {
          intentId: "earlier-intent",
          runId: null,
          basis: "automatic",
        },
      },
    };

    assertValidExample(error, conflict);
    const enforcement = {
      code: "CONFIG",
      message: "The selected runner cannot strictly enforce this Flow setting",
      details: {
        reason: "flow_settings_enforcement_refused",
        nodeId: "policy",
        capabilityClass: "skills",
        capabilityAgent: "claude",
        declared: "strict",
        capability: "instructed",
      },
    };

    assertValidExample(error, enforcement);
    for (const details of [
      { reason: enforcement.details.reason },
      { ...enforcement.details, nodeId: "policy\nprivate" },
      { ...enforcement.details, nodeId: "x".repeat(257) },
      { ...enforcement.details, nodeId: "private/path" },
      { ...enforcement.details, nodeId: "constructor" },
      { ...enforcement.details, capabilityClass: "untrusted-setting" },
      { ...enforcement.details, source: "private content" },
    ]) {
      assert.equal(error({ ...enforcement, details }), false);
    }
    assertValidExample(error, {
      code: "EXECUTOR_UNAVAILABLE",
      message: "Assign an available runner to the indicated Flow slot",
      details: {
        reason: "flow_runner_unresolved",
        slotKey: "session:implementation",
        label: "Implementation",
      },
    });
    if (file.includes("/external/")) {
      assertValidExample(error, {
        code: "UNAUTHORIZED",
        message: "insufficient scope",
        details: { requiredScope: "runs:launch" },
      });
      assertValidExample(error, {
        code: "UNAUTHORIZED",
        message: "owner role does not allow launch",
        details: { requiredAction: "launchRun" },
      });
      assertValidExample(error, {
        code: "CONFLICT",
        message: "effect already succeeded",
        details: {
          reason: "duplicate_of_operation",
          operationId: "existing-operation",
        },
      });
    }
    assert.equal(
      error({
        ...conflict,
        details: {
          ...conflict.details,
          existing: { intentId: null, runId: null, basis: "manual" },
        },
      }),
      false,
    );
    assert.equal(
      error({
        ...conflict,
        details: {
          ...conflict.details,
          existing: { ...conflict.details.existing, token: "private" },
        },
      }),
      false,
    );

    assertValidExample(validate, example);
    assert.equal(
      validate({
        ...example,
        snapshot: { ...example.snapshot, baseCommit: null },
      }),
      false,
    );
    const agent = {
      ...example,
      snapshot: {
        ...example.snapshot,
        kind: "agent",
        workspace: "none",
        agentId: "fixture-agent",
        flowId: null,
        flowRevisionId: null,
        baseCommit: null,
      },
    };
    assertValidExample(validate, agent);
    assert.equal(
      validate({
        ...agent,
        snapshot: { ...agent.snapshot, workspace: "repo_read" },
      }),
      false,
    );
  }
});
