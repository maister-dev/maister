#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import SwaggerParser from "@apidevtools/swagger-parser";
import { DiagnosticSeverity, Parser } from "@asyncapi/parser";
import { parse } from "yaml";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import { canonicalCommandJson } from "../runtime/command-json.ts";

const OPENAPI_FILES = [
  "docs/api/external/operations.openapi.yaml",
  "docs/api/web.openapi.yaml",
  "docs/api/supervisor.openapi.yaml",
  "docs/api/external/stand-connector.openapi.yaml",
  "docs/api/external/github-catalog.openapi.yaml",
  "docs/api/external/mcp-registry.openapi.yaml",
  "docs/api/external/npm-registry.openapi.yaml",
];

const ASYNCAPI_FILES = [
  "docs/api/async/operational-lifecycle.asyncapi.yaml",
  "docs/api/async/attention-stream.asyncapi.yaml",
  "docs/api/async/librarian-stream.asyncapi.yaml",
  "docs/api/async/outbound-webhooks.asyncapi.yaml",
  "docs/api/async/supervisor-sse.asyncapi.yaml",
  "docs/api/async/execution-host-events.asyncapi.yaml",
  "docs/api/async/web-evaluations.asyncapi.yaml",
  "docs/api/async/web-runs.asyncapi.yaml",
];

function readYaml(file) {
  try {
    const parsed = parse(readFileSync(file, "utf8"), {
      prettyErrors: true,
      strict: true,
    });

    if (!parsed || typeof parsed !== "object") {
      throw new Error("document is empty or not an object");
    }

    return parsed;
  } catch (err) {
    throw new Error(`${file}: YAML parse failed: ${err.message}`);
  }
}

function pointerSegments(ref) {
  if (!ref.startsWith("#/")) {
    throw new Error(`external refs are not supported by validate:contracts: ${ref}`);
  }

  return ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function resolvePointer(doc, ref) {
  let current = doc;

  for (const segment of pointerSegments(ref)) {
    if (
      current === null ||
      typeof current !== "object" ||
      !(segment in current)
    ) {
      throw new Error(`unresolved local ref ${ref}`);
    }

    current = current[segment];
  }
}

function visitRefs(doc, node, path = "$") {
  if (Array.isArray(node)) {
    node.forEach((item, index) => visitRefs(doc, item, `${path}[${index}]`));
    return;
  }

  if (!node || typeof node !== "object") return;

  if (typeof node.$ref === "string") {
    try {
      resolvePointer(doc, node.$ref);
    } catch (err) {
      throw new Error(`${path}: ${err.message}`);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    visitRefs(doc, value, `${path}.${key}`);
  }
}

function assertObject(doc, key, file) {
  if (!doc[key] || typeof doc[key] !== "object" || Array.isArray(doc[key])) {
    throw new Error(`${file}: missing object '${key}'`);
  }
}

function schemaFor(doc, name, file) {
  const schema = doc.components?.schemas?.[name];

  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`${file}: missing schema '${name}'`);
  }

  return schema;
}

function assertEnumIncludes(schema, values, context) {
  if (!Array.isArray(schema?.enum)) {
    throw new Error(`${context}: expected enum`);
  }

  const missing = values.filter((value) => !schema.enum.includes(value));

  if (missing.length > 0) {
    throw new Error(`${context}: missing enum values ${missing.join(", ")}`);
  }
}

function assertNullableString(schema, context) {
  if (schema?.type !== "string" || schema?.nullable !== true) {
    throw new Error(`${context}: expected nullable string`);
  }
}

function assertRequired(schema, key, context) {
  if (!Array.isArray(schema?.required) || !schema.required.includes(key)) {
    throw new Error(`${context}: expected required '${key}'`);
  }
}

function assertIncompatibilityUnion(schema, context) {
  if (!Array.isArray(schema?.oneOf)) {
    throw new Error(`${context}: expected incompatibility union`);
  }

  const hasTypedReason = schema.oneOf.some(
    (branch) =>
      branch?.$ref === "#/components/schemas/FlowManifestIncompatibility",
  );
  const hasNull = schema.oneOf.some(
    (branch) =>
      branch?.type === "object" &&
      branch?.nullable === true &&
      branch?.enum?.includes(null),
  );

  if (!hasTypedReason || !hasNull) {
    throw new Error(
      `${context}: expected FlowManifestIncompatibility or null`,
    );
  }
}

function assertIncompatibleResponseBranch(schema, name, file) {
  if (!Array.isArray(schema.oneOf)) {
    throw new Error(`${file}: ${name} must use a compatible/incompatible union`);
  }

  const compatible = schema.oneOf.find(
    (branch) => branch?.properties?.compatible?.enum?.includes(true),
  );
  const incompatible = schema.oneOf.find(
    (branch) => branch?.properties?.compatible?.enum?.includes(false),
  );

  const compatibleIncompatibility = compatible?.properties?.incompatibility;

  if (
    !compatible?.required?.includes("incompatibility") ||
    compatibleIncompatibility?.type !== "object" ||
    compatibleIncompatibility?.nullable !== true ||
    !compatibleIncompatibility?.enum?.includes(null)
  ) {
    throw new Error(
      `${file}: ${name} compatible branch must expose incompatibility: null`,
    );
  }

  if (
    !incompatible ||
    !incompatible.required?.includes("incompatibility") ||
    incompatible.properties?.incompatibility?.$ref !==
      "#/components/schemas/FlowManifestIncompatibility"
  ) {
    throw new Error(
      `${file}: ${name} incompatible branch must expose FlowManifestIncompatibility`,
    );
  }
}

function validateM43WebContract(doc, file) {
  if (file !== "docs/api/web.openapi.yaml") return;

  const incompatibility = schemaFor(doc, "FlowManifestIncompatibility", file);
  assertEnumIncludes(
    incompatibility.properties?.kind,
    ["legacy_steps", "invalid_manifest", "engine_incompatible"],
    `${file}: FlowManifestIncompatibility.kind`,
  );

  const launchOptions = schemaFor(doc, "TaskRunLaunchOptionsResponse", file);
  const launchability = launchOptions.properties?.launchability;
  const relaunch = launchOptions.properties?.relaunch;
  const flows = launchOptions.properties?.flows;
  const flowIssueReasons = [
    "unconfigured",
    "flow_missing",
    "no_revision",
    "not_enabled",
    "not_installed",
    "setup_failed",
    "setup_pending",
    "unsupported_schema",
    "incompatible",
  ];

  assertNullableString(
    launchOptions.properties?.task?.properties?.flowId,
    `${file}: TaskRunLaunchOptionsResponse.task.flowId`,
  );
  assertRequired(
    launchOptions.properties?.task,
    "flowId",
    `${file}: TaskRunLaunchOptionsResponse.task`,
  );
  assertNullableString(
    launchability?.properties?.incompatibilityReason,
    `${file}: TaskRunLaunchOptionsResponse.launchability.incompatibilityReason`,
  );
  assertNullableString(
    relaunch?.properties?.incompatibilityReason,
    `${file}: TaskRunLaunchOptionsResponse.relaunch.incompatibilityReason`,
  );
  assertNullableString(
    flows?.items?.properties?.disabledReasonMessage,
    `${file}: TaskRunLaunchOptionsResponse.flows[].disabledReasonMessage`,
  );
  assertRequired(
    launchability,
    "incompatibilityReason",
    `${file}: TaskRunLaunchOptionsResponse.launchability`,
  );
  assertRequired(
    relaunch,
    "incompatibilityReason",
    `${file}: TaskRunLaunchOptionsResponse.relaunch`,
  );
  assertRequired(
    flows?.items,
    "disabledReasonMessage",
    `${file}: TaskRunLaunchOptionsResponse.flows[]`,
  );
  assertEnumIncludes(
    launchability?.properties?.reason,
    [
      "launchable",
      "busy",
      "crashed",
      "target_terminal",
      "flagged",
      "blocked",
      ...flowIssueReasons,
    ],
    `${file}: TaskRunLaunchOptionsResponse.launchability.reason`,
  );
  assertEnumIncludes(
    relaunch?.properties?.reason,
    ["launchable", "flagged", "blocked", ...flowIssueReasons],
    `${file}: TaskRunLaunchOptionsResponse.relaunch.reason`,
  );

  for (const name of [
    "RunGraphResponse",
    "RunGraphStatusResponse",
    "RunTranscriptResponse",
  ]) {
    assertIncompatibleResponseBranch(schemaFor(doc, name, file), name, file);
  }

  const upgradePreview = schemaFor(doc, "UpgradePreview", file);

  for (const key of ["compatible", "incompatibility", "nodes"]) {
    if (!upgradePreview.required?.includes(key)) {
      throw new Error(`${file}: UpgradePreview must require '${key}'`);
    }
  }
  assertIncompatibilityUnion(
    upgradePreview.properties?.incompatibility,
    `${file}: UpgradePreview.incompatibility`,
  );
}

function validateExecutionHostEventContract(doc, file) {
  if (file !== "docs/api/async/execution-host-events.asyncapi.yaml") return;

  const envelope = schemaFor(doc, "RuntimeEventEnvelope", file);
  const expectedSpine = [
    "envelopeVersion",
    "eventId",
    "hostKey",
    "hostBootId",
    "streamId",
    "sequence",
    "runId",
    "assignmentId",
    "assignmentEpoch",
    "hostSessionId",
    "eventType",
    "occurredAt",
    "payloadSchema",
    "payload",
  ];
  for (const key of expectedSpine) {
    assertRequired(envelope, key, `${file}: RuntimeEventEnvelope`);
  }
  if (envelope.additionalProperties !== false) {
    throw new Error(`${file}: RuntimeEventEnvelope must close its spine`);
  }
  const sequence = schemaFor(doc, "Sequence", file);
  if (sequence.type !== "string" || !sequence.pattern?.startsWith("^(0|")) {
    throw new Error(`${file}: Sequence must be canonical decimal string`);
  }
  if (envelope.properties?.payload?.additionalProperties !== true) {
    throw new Error(`${file}: RuntimeEventEnvelope.payload must remain open JSON`);
  }
  const ack = schemaFor(doc, "RuntimeEventAck", file);
  assertRequired(ack, "streamId", `${file}: RuntimeEventAck`);
  assertRequired(ack, "throughSequence", `${file}: RuntimeEventAck`);
}

function validateAttentionStreamContract(doc, file) {
  if (file !== "docs/api/async/attention-stream.asyncapi.yaml") return;

  const tick = schemaFor(doc, "AttentionTickEvent", file);
  for (const key of [
    "type",
    "id",
    "occurredAt",
    "decisions",
    "updates",
    "changed",
    "projectIds",
  ]) {
    assertRequired(tick, key, `${file}: AttentionTickEvent`);
  }
  if (tick.additionalProperties !== false) {
    throw new Error(`${file}: AttentionTickEvent must close its spine`);
  }
  // The frame id is the exclusive replay cursor, so it is a canonical decimal
  // string like every other cursor on the wire — never a number.
  if (
    tick.properties?.id?.type !== "string" ||
    !tick.properties?.id?.pattern?.startsWith("^(0|")
  ) {
    throw new Error(`${file}: AttentionTickEvent.id must be a canonical decimal string`);
  }
  // Both counters are counts. A negative one would mean the subtraction in
  // ADR-169 D2 underflowed rather than that nothing is waiting.
  for (const key of ["decisions", "updates"]) {
    const counter = tick.properties?.[key];
    if (counter?.type !== "integer" || counter?.minimum !== 0) {
      throw new Error(`${file}: AttentionTickEvent.${key} must be a non-negative integer`);
    }
  }
  assertEnumIncludes(
    tick.properties?.changed?.items,
    ["decisions", "work", "activity"],
    `${file}: AttentionTickEvent.changed`,
  );
  if (tick.properties?.projectIds?.type !== "array") {
    throw new Error(
      `${file}: AttentionTickEvent.projectIds must be an array — the per-frame ` +
        `visibility filter is asserted against it`,
    );
  }

  const designedReviewFields =
    Object.hasOwn(tick.properties ?? {}, "reviews") ||
    Object.hasOwn(tick.properties ?? {}, "reviewVersion");
  if (designedReviewFields) {
    const reviews = tick.properties.reviews;
    const version = tick.properties.reviewVersion;
    if (reviews?.type !== "integer" || reviews?.minimum !== 0)
      throw new Error(`${file}: AttentionTickEvent.reviews must be a non-negative integer`);
    if (version?.type !== "string" || version?.pattern !== "^[0-9a-f]{64}$")
      throw new Error(`${file}: AttentionTickEvent.reviewVersion must be an opaque SHA-256 value`);
    assertEnumIncludes(tick.properties.changed.items, ["reviews"], `${file}: AttentionTickEvent.changed`);
  }
  // Synthetic frames carry no SSE id and must never advance a replay cursor.
  const heartbeat = schemaFor(doc, "AttentionHeartbeatEvent", file);
  if (heartbeat.properties && "id" in heartbeat.properties) {
    throw new Error(`${file}: AttentionHeartbeatEvent must not carry a frame id`);
  }
}

const LIBRARIAN_STREAM_FILE = "docs/api/async/librarian-stream.asyncapi.yaml";
const LIBRARIAN_STREAM_CHANNEL = "/api/librarian/stream";
const LIBRARIAN_STREAM_FRAMES = {
  LibrarianMessageEvent: ["type", "id", "seq", "messageId"],
  LibrarianTurnEvent: ["type", "id", "seq", "turnId", "status"],
  LibrarianIndicatorEvent: ["type", "id", "seq", "state"],
  LibrarianResetEvent: ["type", "id", "seq", "resetState"],
};

function derefLocal(doc, node) {
  if (typeof node?.$ref !== "string") return node;

  let current = doc;
  for (const segment of pointerSegments(node.$ref)) current = current?.[segment];
  return current;
}

function hasPropertyNamed(schema, name) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.properties && name in schema.properties) return true;

  return [
    ...Object.values(schema.properties ?? {}),
    schema.items,
    ...(schema.oneOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.allOf ?? []),
  ].some((child) => hasPropertyNamed(child, name));
}

// Keyed on the channel as well as the path, so a copy of the file anywhere
// (the negative tests) is held to the same contract as the registered one.
function validateLibrarianStreamContract(doc, file) {
  const channel = doc.channels?.[LIBRARIAN_STREAM_CHANNEL];
  if (file !== LIBRARIAN_STREAM_FILE && !channel) return;
  if (!channel) {
    throw new Error(`${file}: missing channel ${LIBRARIAN_STREAM_CHANNEL}`);
  }

  for (const [name, keys] of Object.entries(LIBRARIAN_STREAM_FRAMES)) {
    const frame = schemaFor(doc, name, file);
    for (const key of keys) assertRequired(frame, key, `${file}: ${name}`);
    if (frame.additionalProperties !== false) {
      throw new Error(`${file}: ${name} must close its spine`);
    }
    // The SSE id is the exclusive replay cursor over a bigint sequence, so it
    // is a canonical decimal string like every other cursor on the wire.
    for (const key of ["id", "seq"]) {
      const cursor = frame.properties?.[key];
      if (cursor?.type !== "string" || !cursor?.pattern?.startsWith("^(0|")) {
        throw new Error(`${file}: ${name}.${key} must be a canonical decimal string`);
      }
    }
  }
  assertEnumIncludes(
    schemaFor(doc, "LibrarianIndicatorEvent", file).properties?.state,
    ["running", "unread", "action_required", "none"],
    `${file}: LibrarianIndicatorEvent.state`,
  );
  assertEnumIncludes(
    schemaFor(doc, "LibrarianResetEvent", file).properties?.resetState,
    ["none", "resetting"],
    `${file}: LibrarianResetEvent.resetState`,
  );

  // Synthetic frames carry no SSE id and must never advance a replay cursor.
  const heartbeat = schemaFor(doc, "LibrarianHeartbeatEvent", file);
  if (heartbeat.additionalProperties !== false) {
    throw new Error(`${file}: LibrarianHeartbeatEvent must close its spine`);
  }
  if (
    (heartbeat.properties && "id" in heartbeat.properties) ||
    heartbeat.required?.includes("id")
  ) {
    throw new Error(`${file}: LibrarianHeartbeatEvent must not carry a frame id`);
  }

  const work = schemaFor(doc, "LibrarianWorkEvent", file);
  for (const key of ["type", "reason"])
    assertRequired(work, key, `${file}: LibrarianWorkEvent`);
  if (
    work.additionalProperties !== false ||
    Object.keys(work.properties ?? {}).some(
      (key) => key !== "type" && key !== "reason",
    )
  ) {
    throw new Error(`${file}: LibrarianWorkEvent must contain only type and reason`);
  }

  // Frames are notifications: bodies are fetched from /api/librarian/messages,
  // so no frame reachable from the channel may carry one.
  const messages = channel.subscribe?.message?.oneOf ?? [];
  if (messages.length === 0) {
    throw new Error(`${file}: ${LIBRARIAN_STREAM_CHANNEL} declares no frames`);
  }
  for (const ref of messages) {
    const payload = derefLocal(doc, ref)?.payload;
    const name = payload?.$ref?.split("/").pop() ?? "an inline frame";
    if (hasPropertyNamed(derefLocal(doc, payload), "body")) {
      throw new Error(`${file}: ${name} must not carry a message body`);
    }
  }
}

async function validateOpenApiMetaSchema(file) {
  try {
    await SwaggerParser.validate(file);
  } catch (error) {
    throw new Error(
      `${file}: OpenAPI meta-schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function validateAsyncApiMetaSchema(file) {
  const result = await new Parser().parse(readFileSync(file, "utf8"));
  const errors = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === DiagnosticSeverity.Error,
  );

  if (errors.length > 0) {
    throw new Error(
      `${file}: AsyncAPI meta-schema validation failed: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`,
    );
  }
}

export async function validateOpenApi(file, { log = true } = {}) {
  await validateOpenApiMetaSchema(file);
  const doc = readYaml(file);

  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    throw new Error(`${file}: expected OpenAPI 3.x document`);
  }

  assertObject(doc, "info", file);
  assertObject(doc, "paths", file);
  assertObject(doc, "components", file);
  visitRefs(doc, doc);
  validateM43WebContract(doc, file);
  if (log) console.log(`validate-contracts: ${basename(file)} ok`);
}

export async function validateAsyncApi(file, { log = true } = {}) {
  await validateAsyncApiMetaSchema(file);
  const doc = readYaml(file);

  if (typeof doc.asyncapi !== "string") {
    throw new Error(`${file}: expected AsyncAPI document`);
  }

  assertObject(doc, "info", file);
  assertObject(doc, "channels", file);
  visitRefs(doc, doc);
  validateExecutionHostEventContract(doc, file);
  validateAttentionStreamContract(doc, file);
  validateLibrarianStreamContract(doc, file);
  if (log) console.log(`validate-contracts: ${basename(file)} ok`);
}

function validateCompanyBrainExamples() {
  const surfaces = {
    web: readYaml("docs/api/web.openapi.yaml"),
    external: readYaml("docs/api/external/operations.openapi.yaml"),
  };
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  for (const [name, document] of Object.entries(surfaces)) ajv.addSchema(document, name);
  for (const [name, schema] of Object.entries(surfaces.external.components.schemas)) {
    if (name.startsWith("CB") && !isDeepStrictEqual(schema, surfaces.web.components.schemas[name])) {
      throw new Error(`${name}: web/external schema parity failed`);
    }
  }
  const { cases } = readYaml("docs/api/company-brain-examples.yaml");
  if (!Array.isArray(cases) || cases.length === 0) throw new Error("company examples: no cases");
  const seen = new Set();
  let count = 0;
  for (const entry of cases) {
    if (typeof entry.id !== "string" || seen.has(entry.id)) throw new Error("company examples: missing or duplicate case id");
    seen.add(entry.id);
    if (typeof entry.valid !== "boolean" || !Array.isArray(entry.surfaces) || entry.surfaces.length === 0) {
      throw new Error(`${entry.id}: expected boolean validity and explicit surfaces`);
    }
    for (const surface of entry.surfaces) {
      if (!Object.hasOwn(surfaces, surface)) throw new Error(`${entry.id}: unknown surface`);
      const validate = ajv.getSchema(`${surface}#/components/schemas/${entry.schema}`);
      if (!validate) throw new Error(`${entry.id}: missing ${surface} schema ${entry.schema}`);
      if (validate(entry.value) !== entry.valid) {
        throw new Error(`${entry.id}: ${surface}/${entry.schema} example validity mismatch`);
      }
      count += 1;
    }
  }
  return count;
}

// Reviewed C-02 through C-11 transport surface. Keeping this inventory
// independent prevents deleting both an operation and its example silently.
const STAGE_C_REQUIRED_OPERATIONS = [
  "stageCHostCapabilities", "stageCRepositoryRefs", "stageCResolveRevision",
  "stageCPrepare", "stageCMaterialize", "stageCRunWorkload", "stageCCancelWorkload",
  "stageCGetWorkspace", "stageCGetWorkspaceStatus", "stageCGetWorkspaceDiff", "stageCGetReviewFingerprint",
  "stageCGetWorkspaceLog", "stageCCheckpoint", "stageCRestore", "stageCSync",
  "stageCPublish", "stageCGetPublicationTarget", "stageCGetWorkspacePullRequest", "stageCPreserve", "stageCRelease", "stageCGetCommandReceipt",
  "stageCGetRuntimeObjectContent", "stageCTaskHostOptions", "stageCFlowHostOptions",
  "stageCCreateIntent", "stageCCreateConcurrentIntents", "stageCReadIntent",
  "stageCReplaceIntent", "stageCCancelIntent",
  "stageCReadProjectHostSettings", "stageCUpdateProjectHostSettings",
].sort();
const STAGE_C_REFUSALS = {
  invalid_request: [400, "PRECONDITION"],
  request_too_large: [413, "PRECONDITION"],
  workspace_protocol_unsupported: [503, "EXECUTOR_UNAVAILABLE"],
  host_identity_mismatch: [409, "EXECUTOR_UNAVAILABLE"],
  stale_assignment_epoch: [409, "FENCED"],
  stale_workspace_generation: [409, "FENCED"],
  stale_workspace_claim: [409, "FENCED"],
  resource_not_found: [404, "NOT_FOUND"],
  source_commit_unavailable: [409, "PRECONDITION"],
  source_ref_unapproved: [409, "PRECONDITION"],
  workspace_rejected: [409, "PRECONDITION"],
  tool_not_declared: [409, "PRECONDITION"],
  command_digest_mismatch: [409, "CONFLICT"],
  retained_disposition_required: [409, "PRECONDITION"],
  target_ref_changed: [409, "CONFLICT"],
  publication_provider_unavailable: [409, "PRECONDITION"],
  head_changed: [409, "CONFLICT"],
  workspace_writer_active: [409, "PRECONDITION"],
  launch_request_key_conflict: [409, "CONFLICT"],
  host_ineligible: [409, "PRECONDITION"],
  launch_settings_changed: [409, "CONFLICT"],
  settings_revision_mismatch: [409, "CONFLICT"],
  insufficient_project_role: [403, "UNAUTHORIZED"],
};

function canonicalSha256(value) {
  return createHash("sha256").update(canonicalCommandJson(value)).digest("hex");
}

function stageCRequestDigest(operationId, request, target) {
  return canonicalSha256({ operationId, hostKey: request.owner.hostKey, target, ...request });
}

export function validateStageCWorkspaceExamples(
  profile = readYaml("docs/api/stage-c-workspace.schema.yaml"),
  examples = readYaml("docs/api/stage-c-workspace-examples.yaml"),
) {
  const operations = profile["x-operations"];
  const cases = examples.operationCases;
  assertObject(profile, "x-operations", "Stage C schema");
  assertObject(examples, "operationCases", "Stage C examples");
  if (!isDeepStrictEqual(Object.keys(operations).sort(), STAGE_C_REQUIRED_OPERATIONS)) {
    throw new Error("Stage C profile is missing required operations or declares an unknown operation");
  }
  if (!isDeepStrictEqual(Object.keys(operations).sort(), Object.keys(cases).sort())) {
    throw new Error("Stage C examples must cover each operation exactly once");
  }
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv, ["date-time", "uri", "uuid"]);
  ajv.addSchema(profile);
  const validate = (name, value, valid, context) => {
    const check = ajv.getSchema(`${profile.$id}#/definitions/${name}`);
    if (!check || check(value) !== valid) {
      throw new Error(`${context}: ${name} example validity mismatch: ${ajv.errorsText(check?.errors)}`);
    }
  };
  const validateRefusal = (refusal, id) => {
    validate("Refusal", refusal?.body, true, id);
    const { code, details } = refusal.body;
    if (refusal.newEffects !== 0 ||
        !isDeepStrictEqual([refusal.status, code], STAGE_C_REFUSALS[details.reason])) {
      throw new Error(`${id}: invalid refusal status, code and reason or recorded effects`);
    }
  };
  const web = readYaml("docs/api/web.openapi.yaml");
  const supervisor = readYaml("docs/api/supervisor.openapi.yaml");
  const seenRoutes = new Set();
  for (const [id, operation] of Object.entries(operations)) {
    const { method, path, status, extension, request, response, result } = operation;
    const key = `${method} ${path}`;
    if (seenRoutes.has(key)) throw new Error(`Stage C duplicate operation: ${key}`);
    seenRoutes.add(key);
    const isWeb = path.startsWith("/api/");
    const existing = (isWeb ? web : supervisor).paths?.[path]?.[method.toLowerCase()];
    if (extension) {
      if (!existing?.responses?.[String(status)]) {
        throw new Error(`${id}: missing existing response ${key} ${status}`);
      }
    } else {
      const wrongSurface = (isWeb ? supervisor : web).paths?.[path]?.[method.toLowerCase()];
      const expectedSchema = `stage-c-workspace.schema.yaml#/definitions/${request ?? response}`;
      if (wrongSurface || (isWeb && !existing) || (!isWeb && !path.startsWith("/v1/")) ||
          (existing && (existing.operationId !== id ||
            existing["x-stage-c-schema"] !== expectedSchema ||
            !existing.responses?.[String(status)]))) {
        throw new Error(`${id}: new Stage C route must be versioned and distinct from legacy operations`);
      }
    }
    const example = cases[id];
    if (request === null) {
      if (example.request !== null) throw new Error(`${id}: unexpected request extension`);
    } else {
      validate(request, example.request, true, id);
      validate(request, example.invalidRequest, false, id);
    }
    validate(response, example.response, true, id);
    validateRefusal(example.refusal, id);
    if (result) validate(result, example.result, true, id);
    if (operation.replay) {
      const replay = example.replay;
      if (replay?.newEffects !== 0 ||
          !isDeepStrictEqual(replay.request, example.request) ||
          !isDeepStrictEqual(replay.response, example.response)) {
        throw new Error(`${id}: replay must retain the original request and response`);
      }
    }
    if (operation.replay === "sameCommand") {
      validate("CommandTarget", example.target, true, id);
      const kind = path.includes("{commandId}") ? "cancelWorkload" :
        path.includes("{id}") ? "workspace" : "prepare";
      const location = `/v1/commands/${example.request.command.id}`;
      if (example.location !== location || example.replay.location !== location ||
          example.target.kind !== kind ||
          example.target.generation !== example.request.payload.generation ||
          (example.request.owner.kind === "workspaceOperation" &&
            example.target.handle !== example.request.owner.workspaceHandle) ||
          !isDeepStrictEqual(example.target, example.replay.target) ||
          example.request.command.id !== example.response.commandId ||
          stageCRequestDigest(id, example.request, example.target) !== example.requestSha256) {
        throw new Error(`${id}: replay must retain the exact command and resolved target`);
      }
    }
  }
  const readSettings = cases.stageCReadProjectHostSettings;
  const updatedSettings = cases.stageCUpdateProjectHostSettings;
  const projectSettingsETag = (settings) =>
    `"${settings.preferenceRevision}:${settings.eligibilityRevision}"`;
  for (const entry of [readSettings, updatedSettings]) {
    validate("ProjectHostSettingsETag", entry.etag, true, "settings ETag");
    if (entry.etag !== projectSettingsETag(entry.response))
      throw new Error("Stage C settings revision and ETag disagree");
  }
  validate("ProjectHostSettingsETag", updatedSettings.ifMatch, true, "settings If-Match");
  if (updatedSettings.ifMatch !== readSettings.etag ||
      updatedSettings.response.preferenceRevision !== readSettings.response.preferenceRevision + 1 ||
      updatedSettings.response.eligibilityRevision !== readSettings.response.eligibilityRevision ||
      updatedSettings.response.defaultExecutionHostId !== updatedSettings.request.defaultExecutionHostId) {
    throw new Error("Stage C settings update must advance the exact preference revision");
  }
  validateRefusal(examples.requestRefusals.malformed, "malformed request");
  validateRefusal(examples.requestRefusals.oversized, "oversized request");
  const differentCancel = examples.conflictExamples.differentCancelTarget;
  const originalCancel = cases.stageCCancelWorkload;
  validate("CommandTarget", differentCancel.target, true, "changed cancellation target");
  validateRefusal(differentCancel.refusal, "changed cancellation target");
  const { targetCommandId, ...workspace } = differentCancel.target;
  if (targetCommandId === originalCancel.target.targetCommandId ||
      !isDeepStrictEqual({ ...workspace, targetCommandId: originalCancel.target.targetCommandId }, originalCancel.target) ||
      differentCancel.refusal.body.details.reason !== "command_digest_mismatch" ||
      stageCRequestDigest("stageCCancelWorkload", originalCancel.request, differentCancel.target) === originalCancel.requestSha256) {
    throw new Error("Stage C changed cancellation target must conflict on the original command ID");
  }
  if (!Array.isArray(examples.conditionalCases) || examples.conditionalCases.length === 0) {
    throw new Error("Stage C contract is missing conditional examples");
  }
  for (const example of examples.conditionalCases) {
    validate(example.schema, example.value, example.valid, example.id);
  }
  const completed = cases.stageCGetCommandReceipt.response;
  const prepare = cases.stageCPrepare;
  const { accepted, rejected, indeterminate } = examples.receiptExamples;
  for (const [phase, receipt] of Object.entries({ accepted, completed, rejected, indeterminate })) {
    validate("WorkspaceCommandReceipt", receipt, true, phase);
    if (receipt.phase !== phase ||
        receipt.operationId !== "stageCPrepare" ||
        receipt.commandId !== prepare.request.command.id ||
        receipt.requestSha256 !== prepare.requestSha256 ||
        !isDeepStrictEqual(receipt.owner, prepare.request.owner) ||
        !isDeepStrictEqual(receipt.target, prepare.target)) {
      throw new Error(`Stage C ${phase} receipt must correlate to the accepted request`);
    }
  }
  const outcomes = [
    [completed, { result: completed.result }],
    [rejected, { refusal: rejected.refusal }],
    [indeterminate, { condition: indeterminate.condition }],
  ];
  if (!isDeepStrictEqual(accepted.acceptance, prepare.response) ||
      !isDeepStrictEqual(completed.result, prepare.result) ||
      outcomes.some(([receipt, outcome]) => receipt.outcomeSha256 !== canonicalSha256(outcome))) {
    throw new Error("Stage C receipt must preserve original acceptance and exact terminal outcomes");
  }
  const { terminalEvent: event, wrongReceiptHost: foreign, draftWithPrivatePath } = examples.eventExamples;
  validate("WorkspaceTerminalEvent", event, true, "terminal event");
  validate("WorkspaceTerminalEvent", foreign, true, "foreign receipt shape");
  validate("WorkspaceTerminalEvent", draftWithPrivatePath, false, "private path");
  const { result: _result, streamId, eventId, ...expectedPayload } = completed;
  if (event.hostKey !== completed.owner.hostKey ||
      event.streamId !== streamId || event.eventId !== eventId ||
      BigInt(event.sequence) > 9223372036854775807n ||
      !isDeepStrictEqual(event.payload, expectedPayload) ||
      foreign.hostKey === foreign.payload.owner.hostKey) {
    throw new Error("Stage C receipt and canonical stream evidence must agree");
  }
  return seenRoutes.size;
}

export async function validateContracts({ log = true } = {}) {
  for (const file of OPENAPI_FILES) await validateOpenApi(file, { log });
  for (const file of ASYNCAPI_FILES) await validateAsyncApi(file, { log });
  const count = validateCompanyBrainExamples();
  if (log) console.log(`validate-contracts: ${count} Company Brain surface examples and schema parity ok`);
  const stageCCount = validateStageCWorkspaceExamples();
  if (log) console.log(`validate-contracts: ${stageCCount} Stage C designed operations and examples ok`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await validateContracts();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
