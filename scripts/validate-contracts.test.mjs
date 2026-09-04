import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
