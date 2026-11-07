import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { aggregateIsolationEvidence, evidenceSha256, finishIsolationEvidence, isolationCiIdentity, isolationReceiptSchema, isolationStageFiles, validateIsolationReceipt } from "./isolation-ci-evidence.mjs";
import { requiredIsolationCases } from "./run-stage-ab-tests.mjs";

const identity = { sourceSha: "a".repeat(40), repository: "maister-dev/maister", runId: "123", runAttempt: "1" };

function stageEvidence(stage, part) {
  const files = isolationStageFiles(stage, part);
  const cases = files.reduce((total, file) => total + requiredIsolationCases[file].length, 0);
  const report = {
    success: true, numTotalTests: cases, numPassedTests: cases, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: files.map((file) => ({ name: `/repo/web/${file}`, status: "passed", assertionResults: requiredIsolationCases[file].map((title) => ({ title, status: "passed" })) })),
  };
  const bytes = Buffer.from(JSON.stringify(report));
  const receipt = {
    schema: isolationReceiptSchema, identity, stage, part, parts: 2,
    platform: "darwin", arch: "x64", node: "24.19.0", concurrency: 1,
    runnerImage: { os: "macos15", version: "20261019.14" },
    invocationId: `00000000-0000-4000-8000-00000000000${part * 2 + (stage === "part" ? 1 : 0)}`,
    files, cases, reportSha256: evidenceSha256(bytes), outcome: { code: 0, signal: null },
    cleanup: { outcome: "clean", errors: 0 }, durationSeconds: 1, budgetSeconds: stage === "part" ? 2340 : 600,
  };

  return { receipt, bytes, report };
}

async function completeEvidence(context) {
  const directory = await mkdtemp(join(tmpdir(), "maister-isolation-receipts-"));

  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const part of [1, 2]) {
    for (const stage of ["preflight", "part"]) {
      const root = join(directory, `part-${part}`, stage);
      const { receipt, bytes } = stageEvidence(stage, part);

      await mkdir(root, { recursive: true });
      await writeFile(join(root, "receipt.json"), JSON.stringify(receipt));
      await writeFile(join(root, "vitest.json"), bytes);
    }
  }

  return directory;
}

test("combined isolation validates two independent preflights and exactly all 51 required cases", async (context) => {
  const directory = await completeEvidence(context);
  const nested = join(directory, "part-1", "maister-ab-isolation-negative");

  await mkdir(nested);
  await writeFile(join(nested, "vitest.json"), JSON.stringify({ success: false }));
  const combined = await finishIsolationEvidence(directory, identity, "success");

  assert.equal(combined.outcome, "passed");
  assert.equal(combined.files.length, 7);
  assert.equal(combined.cases, 51);
  assert.equal(combined.preflights, 2);
  assert.equal(combined.stages.length, 4);
  assert.deepEqual(combined.stages.filter((row) => row.stage === "part").map((row) => row.cases), [19, 32]);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "combined.json"), "utf8")), combined);
});

test("combined isolation rejects a tampered actual reporter", async (context) => {
  const directory = await completeEvidence(context);
  const report = join(directory, "part-2", "part", "vitest.json");

  await writeFile(report, `${await readFile(report, "utf8")} `);
  await assert.rejects(aggregateIsolationEvidence(directory, identity, "success"), /report hash differs/u);
});

test("combined isolation rejects a duplicated part receipt", async (context) => {
  const directory = await completeEvidence(context);
  const bytes = await readFile(join(directory, "part-1", "part", "receipt.json"));

  await writeFile(join(directory, "part-2", "part", "receipt.json"), bytes);
  await assert.rejects(aggregateIsolationEvidence(directory, identity, "success"), /duplicated isolation part/u);
});

test("combined isolation records failure when either independent preflight is missing", async (context) => {
  const directory = await completeEvidence(context);

  await rm(join(directory, "part-2", "preflight", "receipt.json"));
  await assert.rejects(finishIsolationEvidence(directory, identity, "success"), /ENOENT/u);
  assert.equal(JSON.parse(await readFile(join(directory, "combined.json"), "utf8")).outcome, "failed");
});

test("combined isolation refuses failed jobs including report upload and runtime cleanup failures", async (context) => {
  const directory = await completeEvidence(context);

  for (const result of ["failure", "cancelled", "skipped", undefined])
    await assert.rejects(aggregateIsolationEvidence(directory, identity, result), /jobs, uploads and runtime cleanups must succeed/u);
});

test("stage receipts reject wrong source, platform, run, Node, seriality, outcome and leak evidence", () => {
  const { receipt, bytes } = stageEvidence("part", 1);
  const changes = [
    { identity: { ...identity, sourceSha: "b".repeat(40) } },
    { identity: { ...identity, runAttempt: "2" } },
    { platform: "linux" }, { arch: "arm64" }, { node: "24.15.0" }, { concurrency: 2 },
    { outcome: { code: 1, signal: null } }, { cleanup: { outcome: "leak-reaped", errors: 1 } },
    { budgetSeconds: 2341 }, { durationSeconds: 2341 }, { files: receipt.files.slice(1) },
    { files: [...receipt.files, "test-support/__tests__/linux-isolation-driver.integration.test.ts"] },
    { runnerImage: { os: "macos15", version: null } },
  ];

  for (const change of changes)
    assert.throws(() => validateIsolationReceipt({ ...receipt, ...change }, bytes, { identity, stage: "part", part: 1 }));
});

test("exact isolation case sets reject missing, extra, skipped and afterAll-failed controls", () => {
  const { receipt, report } = stageEvidence("part", 1);
  const controls = [
    (row) => row.testResults[0].assertionResults.pop(),
    (row) => row.testResults[0].assertionResults.push({ title: "unexpected control", status: "passed" }),
    (row) => { row.testResults[0].assertionResults[0].status = "pending"; },
    (row) => { row.testResults[0].status = "failed"; },
    (row) => { row.success = false; },
  ];

  for (const mutate of controls) {
    const changed = structuredClone(report);

    mutate(changed);
    const bytes = Buffer.from(JSON.stringify(changed));

    assert.throws(() => validateIsolationReceipt({ ...receipt, reportSha256: evidenceSha256(bytes) }, bytes, { identity, stage: "part", part: 1 }));
  }
});

test("CI identity fails before evidence can be published without exact run metadata", () => {
  const env = { GITHUB_SHA: identity.sourceSha, GITHUB_REPOSITORY: identity.repository, GITHUB_RUN_ID: identity.runId, GITHUB_RUN_ATTEMPT: identity.runAttempt };

  assert.deepEqual(isolationCiIdentity(env), identity);
  for (const key of Object.keys(env)) assert.throws(() => isolationCiIdentity({ ...env, [key]: "" }), /requires/u);
});
