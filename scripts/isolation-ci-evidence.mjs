import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isolationPartFiles, laneSuites, requiredIsolationCases, validateLaneReport } from "./run-stage-ab-tests.mjs";

export const isolationPreflightFiles = ["test-support/__tests__/execution-ab-preflight.integration.test.ts"];
export const isolationReceiptSchema = "maister.isolation-ci-stage.v1";

/** @typedef {{sourceSha: string, repository: string, runId: string, runAttempt: string}} CiIdentity */

export function evidenceSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @returns {CiIdentity} */
export function isolationCiIdentity(env) {
  assert(/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? ""), "isolation evidence requires GITHUB_SHA");
  assert(/^[^/\s]+\/[^/\s]+$/u.test(env.GITHUB_REPOSITORY ?? ""), "isolation evidence requires GITHUB_REPOSITORY");
  assert(/^[1-9]\d*$/u.test(env.GITHUB_RUN_ID ?? ""), "isolation evidence requires GITHUB_RUN_ID");
  assert(/^[1-9]\d*$/u.test(env.GITHUB_RUN_ATTEMPT ?? ""), "isolation evidence requires GITHUB_RUN_ATTEMPT");

  return { sourceSha: env.GITHUB_SHA, repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT };
}

export function isolationStageFiles(stage, part) {
  const files = isolationPartFiles(part);

  assert(stage === "preflight" || stage === "part", "usage: isolation stage preflight|part");

  return stage === "preflight" ? isolationPreflightFiles : files;
}

export function validateIsolationReport(report, files) {
  validateLaneReport(report, files);
  const expectedCases = files.reduce((total, file) => total + requiredIsolationCases[file].length, 0);

  assert.equal(report.numTotalTests, expectedCases, "isolation report total differs from exact case manifest");
  assert.equal(report.numPassedTests, expectedCases, "isolation report passed total differs from exact case manifest");
  for (const file of files) {
    const result = report.testResults.find((row) => row.name.replaceAll("\\", "/").endsWith(`/${file}`));

    assert.equal(result.status, "passed", `isolation owning suite failed: ${file}`);
    assert.deepEqual(result.assertionResults.map((row) => row.title).sort(), [...requiredIsolationCases[file]].sort(), `isolation case names differ: ${file}`);
  }

  return expectedCases;
}

export async function writeIsolationEvidence(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;

  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

export function validateIsolationReceipt(receipt, reportBytes, { identity, stage, part }) {
  const files = isolationStageFiles(stage, part);

  assert.equal(receipt.schema, isolationReceiptSchema, "wrong isolation receipt schema");
  assert.deepEqual(receipt.identity, identity, "isolation SHA/repository/run identity differs");
  assert.equal(receipt.stage, stage, "wrong isolation stage");
  assert.equal(receipt.part, part, "wrong or duplicated isolation part");
  assert.equal(receipt.parts, 2, "wrong isolation part count");
  assert.equal(receipt.platform, "darwin", "isolation receipt is not macOS");
  assert.equal(receipt.arch, "x64", "isolation receipt is not Intel");
  assert.equal(receipt.node, "24.19.0", "wrong hosted isolation Node");
  assert(typeof receipt.runnerImage?.os === "string" && receipt.runnerImage.os.length > 0 &&
    typeof receipt.runnerImage.version === "string" && receipt.runnerImage.version.length > 0,
  "isolation receipt is missing its actual runner image/version");
  assert.equal(receipt.concurrency, 1, "isolation part must be serial");
  assert.deepEqual(receipt.files, files, "isolation selected suites differ");
  assert.deepEqual(receipt.outcome, { code: 0, signal: null }, "isolation runner did not succeed");
  assert.deepEqual(receipt.cleanup, { outcome: "clean", errors: 0 }, "isolation cleanup failed or reaped leaks");
  assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(receipt.invocationId), "missing isolation invocation identity");
  assert.equal(receipt.reportSha256, evidenceSha256(reportBytes), "isolation report hash differs");
  assert(Number.isFinite(receipt.durationSeconds) && receipt.durationSeconds > 0, "invalid isolation duration");
  assert(Number.isFinite(receipt.budgetSeconds) && receipt.budgetSeconds > 0 && receipt.budgetSeconds <= (stage === "part" ? 2340 : 600), "invalid isolation budget");
  assert(receipt.durationSeconds < receipt.budgetSeconds, "isolation stage exceeded its budget");
  const report = JSON.parse(reportBytes.toString("utf8"));
  const cases = validateIsolationReport(report, files);

  assert.equal(receipt.cases, cases, "isolation receipt case total differs");

  return { receipt, report, files, cases };
}

/** Only fixed outer-stage paths are accepted; nested failure-control reports are never discovered. */
export async function aggregateIsolationEvidence(directory, identity, jobResult) {
  assert.equal(jobResult, "success", "both isolation jobs, uploads and runtime cleanups must succeed");
  const stages = [];

  for (const part of [1, 2]) {
    for (const stage of ["preflight", "part"]) {
      const root = join(directory, `part-${part}`, stage);
      const receiptBytes = await readFile(join(root, "receipt.json"));
      const reportBytes = await readFile(join(root, "vitest.json"));
      const checked = validateIsolationReceipt(JSON.parse(receiptBytes.toString("utf8")), reportBytes, { identity, stage, part });

      stages.push({ ...checked, receiptSha256: evidenceSha256(receiptBytes) });
    }
  }
  assert.equal(new Set(stages.map(({ receipt }) => receipt.invocationId)).size, 4, "outer isolation invocations must be distinct");
  const parts = stages.filter(({ receipt }) => receipt.stage === "part");
  const files = parts.flatMap((row) => row.files);
  const cases = laneSuites.isolation.reduce((total, file) => total + requiredIsolationCases[file].length, 0);

  assert.deepEqual(files, laneSuites.isolation, "combined isolation inventory is incomplete or duplicated");
  assert.equal(parts.reduce((total, row) => total + row.cases, 0), cases, "combined isolation must retain the exact required case manifest");

  return {
    schema: "maister.isolation-ci-combined.v1", identity, outcome: "passed", platform: "darwin/x64", node: "24.19.0",
    files, cases, preflights: 2, jobResult,
    stages: stages.map(({ receipt, receiptSha256 }) => ({ ...receipt, receiptSha256 })),
  };
}

export async function finishIsolationEvidence(directory, identity, jobResult) {
  await mkdir(directory, { recursive: true });
  const output = join(directory, "combined.json");
  let receipt;

  try {
    receipt = await aggregateIsolationEvidence(directory, identity, jobResult);
  } catch (error) {
    await writeIsolationEvidence(output, { schema: "maister.isolation-ci-combined.v1", identity, outcome: "failed", error: String(error) });
    throw error;
  }
  await writeIsolationEvidence(output, receipt);

  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, "usage: isolation-ci-evidence.mjs <downloaded-parts-directory>");
  await finishIsolationEvidence(process.argv[2], isolationCiIdentity(process.env), process.env.MAISTER_ISOLATION_JOB_RESULT);
}
