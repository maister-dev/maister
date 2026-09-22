import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createInvocation, fixtureProcessEnvironment, FIXTURE_WATCHDOG, logInvocation, invocationRecords, fixtureLogTail, registerProcess, removeInvocationRoots, removeInvocationContainers, signalInvocationGroup, sweepInvocation } from "../web/test-support/process-invocation.ts";

import { assertSupportedNode } from "../runtime/node-version.ts";

// Explicit owning seams make a renamed or undiscovered suite fail the lane.
export const laneSuites = {
  supervisor: [
    "host-identity", "runtime-event-outbox", "runtime-event-ack",
    "runtime-storage", "runtime-file-budget", "runtime-event-pressure",
    "runtime-objects", "command-receipts", "lifecycle", "output-memory",
  ].map((name) => `src/__tests__/${name}.integration.test.ts`),
  web: [
    "lib/__tests__/supervisor-client-binary.integration.test.ts",
    "lib/agents/__tests__/prompt-owners.integration.test.ts",
    "lib/agents/__tests__/finalization-transaction.integration.test.ts",
    "lib/agents/__tests__/turn-admission.integration.test.ts",
    "lib/flows/graph/__tests__/prompt-owners.integration.test.ts",
    "lib/flows/graph/__tests__/consensus-prompt-owners.integration.test.ts",
    "lib/flows/graph/__tests__/permission-resume.integration.test.ts",
    "lib/flows/graph/__tests__/gate-permission-resume.integration.test.ts",
    "lib/flows/graph/__tests__/gate-permission-result.integration.test.ts",
    "lib/flows/graph/__tests__/permission-result-failure.integration.test.ts",
    "lib/flows/graph/__tests__/driver-claim.integration.test.ts",
    // ADR-176: the flow worker's crash-recover arm — the routed dispatch, the
    // budget and the two new racers.
    "lib/flows/graph/__tests__/crash-recover-continuation.integration.test.ts",
    "lib/scratch-runs/__tests__/prompt-owners.integration.test.ts",
    "lib/scratch-runs/__tests__/local-package-assistant.integration.test.ts",
    "lib/services/__tests__/gate-chat.integration.test.ts",
    "lib/runs/__tests__/sync-resolver.integration.test.ts",
    "lib/runs/__tests__/sync-recovery.integration.test.ts",
    "lib/runs/__tests__/resume-recovery.integration.test.ts",
    ...["commands", "immutable-commands", "command-recovery", "deliverer", "lifecycle-regression", "bounded-output", "runtime-object-retention", "runtime-object-lifecycle", "runtime-object-declarations-migration", "command-retirement", "prompt-owner-activation"]
      .map((name) => `lib/execution-host/__tests__/${name}.integration.test.ts`),
    ...["ingest", "event-claim-lock", "projection-worker"]
      .map((name) => `lib/execution-host/events/__tests__/${name}.integration.test.ts`),
  ],
  // AT-16: one real production web (fresh `next build`, `server.ts`) under a
  // kernel isolation driver against a real supervisor — runs alone because
  // the build and both process trees own the host.
  isolation: [
    "test-support/__tests__/execution-ab-process-cleanup.integration.test.ts",
    "test-support/__tests__/execution-ab-isolation.integration.test.ts",
    // P0-2: the three durable workers in the production boot. Same shape as
    // AT-16 — `next build` plus two process trees — so the same serial slice.
    "test-support/__tests__/durable-workers-boot.integration.test.ts",
    "test-support/__tests__/durable-workers-concurrency.integration.test.ts",
  ],
};
// The package directory each slice runs in.
export const lanePackages = { supervisor: "supervisor", web: "web", isolation: "web" };
// Slices whose suites own the whole host run one at a time regardless of parallelism.
const SERIAL_SLICES = new Set(["isolation"]);

// A lane suite owns a stack of host processes — its vitest worker, a PostgreSQL
// container, a real supervisor and at least one forked driver child — so the
// pool is sized from that budget. Vitest's default worker count admits one
// stack per core, and the resulting contention expires bounded waits inside
// healthy suites, which makes a zero-failure gate run unreproducible.
const SUITE_HOST_PROCESSES = 4;
const LANE_MAX_CONCURRENCY = 4;

export function laneConcurrency(parallelism, slice = "web") {
  if (SERIAL_SLICES.has(slice) || !(parallelism > 0)) return 1;

  return Math.max(1, Math.min(LANE_MAX_CONCURRENCY, Math.floor(parallelism / SUITE_HOST_PROCESSES)));
}

// The json reporter drops `error.cause`, and a lane failure wrapped for context
// (`new Error(msg, { cause })`) then reaches CI as the wrapper alone. Pair it
// with the default reporter so the console keeps the `Caused by:` chain; only
// json writes a file, so `--outputFile` stays unambiguous.
export function vitestArgs({ files, reportPath, concurrency }) {
  return [
    "node_modules/vitest/vitest.mjs", "run", ...files, "--project=integration",
    "--reporter=json", `--outputFile=${reportPath}`, "--reporter=default",
    `--maxWorkers=${concurrency}`, "--minWorkers=1",
  ];
}

export async function runStageAbLane({ slice, files = laneSuites[slice], workspace, evidenceDirectory = process.env.MAISTER_TEST_EVIDENCE_DIR }) {
  assertSupportedNode(process.versions.node);
  assert(Object.hasOwn(laneSuites, slice ?? ""), "usage: run-stage-ab-tests.mjs web|supervisor|isolation");
  const cwd = fileURLToPath(new URL(`../${lanePackages[slice]}/`, import.meta.url));

  await Promise.all(files.map((file) => access(join(cwd, file))));
  const directory = await mkdtemp(join(evidenceDirectory ?? tmpdir(), `maister-ab-${slice}-`));
  const invocation = await createInvocation(directory);
  const reportPath = join(directory, "vitest.json");
  const concurrency = laneConcurrency(availableParallelism(), slice);
  const env = { ...process.env, ...await fixtureProcessEnvironment(invocation), MAISTER_TEST_DOCKER_PROBE_TIMEOUT_MS: "30000" };
  const args = ["--import", FIXTURE_WATCHDOG, ...vitestArgs({ files, reportPath, concurrency })];

  if (workspace) args.push("--workspace", workspace);
  let child;
  let escalation;
  let caughtSignal;
  let failure;
  let status;
  const signalDeliveries = [];
  const onSignal = (signal) => {
    caughtSignal ??= signal;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    signalDeliveries.push(signalInvocationGroup(invocation, child.pid, signal).catch((error) => {
      failure = failure ? new AggregateError([failure, error], "A/B group signal failed") : error;
      // The direct child is still ours; a failed group check never authorizes wider signaling.
      child.kill("SIGKILL");
    }));
    escalation ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
  };
  const onInterrupt = () => onSignal("SIGINT");
  const onTerminate = () => onSignal("SIGTERM");

  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    await registerProcess(invocation, { role: "runner", caseName: slice, rootRole: "invocation", root: null, bootId: invocation.id, logFile: null }, process.pid);
    child = spawn(process.execPath, args, { cwd, stdio: "inherit", env, detached: true });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    // Registration failure must not leave a concurrently rejected exit promise unobserved.
    void exited.catch(() => {});
    await registerProcess(invocation, { role: "vitest", caseName: slice, rootRole: "invocation", root: null, bootId: invocation.id, logFile: null }, child.pid);
    status = await exited;
    console.log(JSON.stringify({ slice, invocationId: invocation.id, ledger: invocation.directory, node: process.versions.node, bundledUndici: process.versions.undici, concurrency, reportPath, ...status }));
    assert.equal(caughtSignal, undefined, `A/B runner interrupted by ${caughtSignal}`);
    assert.equal(status.code, 0, "A/B integration runner failed");
    const report = JSON.parse(await readFile(reportPath, "utf8"));

    assert.equal(report.testResults.length, files.length, "A/B discovery omitted an owning suite");
    for (const file of files) {
      const result = report.testResults.find((item) => item.name.endsWith(file));

      assert(result?.assertionResults.length > 0, `A/B discovery is empty: ${file}`);
      assert(result.assertionResults.every((item) => item.status === "passed"), `A/B case failed or was skipped: ${file}`);
    }
    assert.equal(report.numFailedTests, 0);
    assert.equal(report.numPendingTests, 0);
    assert.equal(report.numTodoTests ?? 0, 0);
    assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0, "A/B unhandled runtime error");
    assert.equal(report.success, true, "A/B reporter recorded errors");
    console.log(JSON.stringify({ slice, passed: report.numPassedTests, suites: files.length, concurrency, reportPath }));
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "A/B execution and signal failed") : error;
  } finally {
    if (escalation) clearTimeout(escalation);
    await Promise.all(signalDeliveries);
    try {
      const leaks = await sweepInvocation(invocation);
      const containers = await removeInvocationContainers(invocation);

      await removeInvocationRoots(invocation);
      assert.equal(leaks.length, 0, "A/B invocation leaked processes; sweep reaped them");
      assert.equal(containers.length, 0, "A/B invocation leaked containers; terminal cleanup removed them");
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], "A/B execution and cleanup failed") : error;
    }
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    logInvocation(invocation, "lane-complete", { role: "runner", caseName: slice, pid: process.pid, pgid: 0, rootRole: "invocation", bootId: invocation.id, outcome: failure ? "failed" : "passed", reportPath });
  }
  if (failure) {
    try {
      for (const record of await invocationRecords(invocation)) {
        if (record.kind === "process" && record.logFile) {
          logInvocation(invocation, "fixture-failure", { role: record.role, caseName: record.caseName, pid: record.identity.pid, pgid: record.identity.pgid, rootRole: record.rootRole, bootId: record.bootId, outcome: "failed", logTail: await fixtureLogTail(invocation, record.logFile) });
        }
      }
    } catch (diagnosticError) {
      throw new AggregateError([failure, diagnosticError], "A/B failure and fixture diagnostics failed");
    }
    throw failure;
  }

  return { directory, reportPath, invocation, status };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runStageAbLane({ slice: process.argv[2] });
