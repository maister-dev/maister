#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import SwaggerParser from "@apidevtools/swagger-parser";
import { DiagnosticSeverity, Parser } from "@asyncapi/parser";
import { parse } from "yaml";

const OPENAPI_FILES = [
  "docs/api/external/operations.openapi.yaml",
  "docs/api/web.openapi.yaml",
  "docs/api/supervisor.openapi.yaml",
];

const ASYNCAPI_FILES = [
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

export async function validateContracts({ log = true } = {}) {
  for (const file of OPENAPI_FILES) await validateOpenApi(file, { log });
  for (const file of ASYNCAPI_FILES) await validateAsyncApi(file, { log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await validateContracts();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
