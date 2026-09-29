import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import YAML from "yaml";

const workflowPath = fileURLToPath(
  new URL("../.github/workflows/ci.yml", import.meta.url),
);
const workflow = YAML.parse(readFileSync(workflowPath, "utf8"));
const cleanup = workflow.jobs["execution-isolation"].steps.find(
  (step) => step.name === "Stop the job-owned container runtime",
);

assert(cleanup, "isolation workflow must retain its cleanup step");

function runCleanup({ timingWritable, deleteStatus }) {
  const root = mkdtempSync(join(tmpdir(), "maister-ci-cleanup-"));
  const evidenceDir = join(root, "evidence");
  const runtimeDir = join(root, "maister-isolation-runtime");
  const binDir = join(runtimeDir, "bin");
  const deleteLog = join(root, "delete.log");

  try {
    mkdirSync(evidenceDir);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(runtimeDir, "maister-s52.start-attempted"), "1\n");
    const colima = join(binDir, "colima");

    writeFileSync(
      colima,
      '#!/bin/sh\nprintf \'deleted\\n\' >> "$DELETE_LOG"\nexit "$DELETE_STATUS"\n',
    );
    chmodSync(colima, 0o755);
    if (!timingWritable) mkdirSync(join(evidenceDir, "timing.txt"));
    const script = cleanup.run.replaceAll(
      "${{ steps.isolation_reports.outcome }}",
      "success",
    );
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        MAISTER_TEST_EVIDENCE_DIR: evidenceDir,
        S52_JOB_STARTED_AT: String(Math.floor(Date.now() / 1000)),
        DELETE_LOG: deleteLog,
        DELETE_STATUS: String(deleteStatus),
      },
    });

    return {
      status: result.status,
      stderr: result.stderr,
      deleted: existsSync(deleteLog) ? readFileSync(deleteLog, "utf8") : null,
      timing: timingWritable
        ? readFileSync(join(evidenceDir, "timing.txt"), "utf8")
        : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("isolation cleanup deletes the owned profile even when timing cannot be written", () => {
  const result = runCleanup({ timingWritable: false, deleteStatus: 0 });

  assert.equal(result.deleted, "deleted\n");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Failed to record container runtime cleanup outcome/u,
  );
});

test("isolation cleanup preserves a Colima deletion failure in its timing and exit code", () => {
  const result = runCleanup({ timingWritable: true, deleteStatus: 42 });

  assert.equal(result.deleted, "deleted\n");
  assert.equal(result.status, 42);
  assert.match(result.timing, /reports_upload_outcome=success/u);
  assert.match(result.timing, /runtime_cleanup_exit_code=42/u);
});
