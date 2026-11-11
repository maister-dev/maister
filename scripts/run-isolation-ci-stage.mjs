import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { evidenceSha256, isolationCiIdentity, isolationReceiptSchema, isolationStageFiles, validateIsolationReport, writeIsolationEvidence } from "./isolation-ci-evidence.mjs";
import { runStageAbLane } from "./run-stage-ab-tests.mjs";

export async function runIsolationCiStage(stage, part) {
  const identity = isolationCiIdentity(process.env);
  const files = isolationStageFiles(stage, part);
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const actualSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

  assert.equal(actualSha, identity.sourceSha, "isolation checkout differs from GITHUB_SHA");
  assert(process.env.MAISTER_TEST_EVIDENCE_DIR, "isolation CI requires a private evidence directory");
  const output = join(process.env.MAISTER_TEST_EVIDENCE_DIR, "ci-reports");

  await mkdir(output, { recursive: true });
  const stageDirectory = join(output, stage);

  await mkdir(stageDirectory);
  const budgetSeconds = stage === "part" ? Number(process.env.S52_SUITE_BUDGET_SECONDS) : 600;

  assert(Number.isFinite(budgetSeconds) && budgetSeconds > 0 && budgetSeconds <= (stage === "part" ? 2340 : 600), "isolation CI stage budget is invalid");
  const started = performance.now();
  const completed = await runStageAbLane({ slice: "isolation", files });
  const durationSeconds = (performance.now() - started) / 1000;
  const reportBytes = await readFile(completed.reportPath);
  const cases = validateIsolationReport(JSON.parse(reportBytes.toString("utf8")), files);

  assert.deepEqual(completed.status, { code: 0, signal: null }, "isolation outer runner failed");
  assert(durationSeconds < budgetSeconds, "isolation stage exceeded its budget");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(), identity.sourceSha, "isolation checkout changed during execution");
  await writeFile(join(stageDirectory, "vitest.json"), reportBytes, { flag: "wx", mode: 0o600 });
  const receipt = {
    schema: isolationReceiptSchema, identity, stage, part, parts: 3,
    platform: process.platform, arch: process.arch, node: process.versions.node, concurrency: 1,
    runnerImage: { os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null },
    invocationId: completed.invocation.id, originalReportPath: completed.reportPath,
    files, cases, reportSha256: evidenceSha256(reportBytes), outcome: completed.status,
    cleanup: { outcome: "clean", errors: 0 }, durationSeconds, budgetSeconds,
  };

  await writeIsolationEvidence(join(stageDirectory, "receipt.json"), receipt);

  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, "usage: run-isolation-ci-stage.mjs preflight|part 1|2|3");
  await runIsolationCiStage(process.argv[2], Number(process.argv[3]));
}
