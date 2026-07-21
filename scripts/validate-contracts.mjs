#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { parse } from "yaml";

const OPENAPI_FILES = [
  "docs/api/external/operations.openapi.yaml",
  "docs/api/web.openapi.yaml",
  "docs/api/supervisor.openapi.yaml",
];

const ASYNCAPI_FILES = [
  "docs/api/async/outbound-webhooks.asyncapi.yaml",
  "docs/api/async/supervisor-sse.asyncapi.yaml",
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

function validateOpenApi(file) {
  const doc = readYaml(file);

  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    throw new Error(`${file}: expected OpenAPI 3.x document`);
  }

  assertObject(doc, "info", file);
  assertObject(doc, "paths", file);
  assertObject(doc, "components", file);
  visitRefs(doc, doc);
  validateM43WebContract(doc, file);
  console.log(`validate-contracts: ${basename(file)} ok`);
}

function validateAsyncApi(file) {
  const doc = readYaml(file);

  if (typeof doc.asyncapi !== "string") {
    throw new Error(`${file}: expected AsyncAPI document`);
  }

  assertObject(doc, "info", file);
  assertObject(doc, "channels", file);
  visitRefs(doc, doc);
  console.log(`validate-contracts: ${basename(file)} ok`);
}

try {
  OPENAPI_FILES.forEach(validateOpenApi);
  ASYNCAPI_FILES.forEach(validateAsyncApi);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
