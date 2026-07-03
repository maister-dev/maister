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

function validateOpenApi(file) {
  const doc = readYaml(file);

  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    throw new Error(`${file}: expected OpenAPI 3.x document`);
  }

  assertObject(doc, "info", file);
  assertObject(doc, "paths", file);
  assertObject(doc, "components", file);
  visitRefs(doc, doc);
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
