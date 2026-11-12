import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { assertSupportedNode, RuntimeVersionError, SUPPORTED_NODE_RANGE } from "../runtime/node-version.ts";

test("runtime preflight accepts qualified patches and rejects unsupported versions", () => {
  for (const version of ["24.15.0", "24.22.3", "26.13.0", "26.13.1"]) assert.doesNotThrow(() => assertSupportedNode(version));
  for (const version of ["22.13.0", "24.14.9", "25.0.0", "26.3.0", "26.12.1", "27.0.0", "24.19.0-rc.1", "24.19", "garbage"])
    assert.throws(() => assertSupportedNode(version), RuntimeVersionError);
});

test("application manifests enforce the supported LTS ranges", async () => {
  for (const manifest of ["../package.json", "../web/package.json", "../supervisor/package.json"]) {
    const pkg = JSON.parse(await readFile(new URL(manifest, import.meta.url), "utf8"));

    assert.equal(pkg.engines?.node, SUPPORTED_NODE_RANGE, manifest);
  }
});

test("the container runtime is pinned to a concrete Node 24 image digest", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");

  assert.match(dockerfile, /ARG NODE_VERSION=24\.22\.2-bookworm-slim@sha256:[a-f0-9]{64}/);
});

test("the quickstart preflight enforces the same qualified Node range", async () => {
  const quickstart = await readFile(new URL("./quickstart.sh", import.meta.url), "utf8");

  assert.ok(quickstart.includes(`NODE_RANGE="${SUPPORTED_NODE_RANGE}"`), "NODE_RANGE mirrors SUPPORTED_NODE_RANGE");
  assert.ok(quickstart.includes("(major === 24 && minor >= 15) || (major === 26 && minor >= 13)"), "check_node mirrors assertSupportedNode");
});
