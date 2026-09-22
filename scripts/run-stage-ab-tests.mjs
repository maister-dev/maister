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
    "lib/scratch-runs/__tests__/transcript.integration.test.ts",
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
    "test-support/__tests__/execution-ab-partitions.integration.test.ts",
    "test-support/__tests__/execution-ab-process-death.integration.test.ts",
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

// Frozen acceptance case names make partial collection fail, even when the suite survives.
export const requiredIsolationCases = {
  "test-support/__tests__/durable-workers-boot.integration.test.ts": [
    "applies the flow_node_attempt owner after the production web restarts",
    "applies the agent_turn owner after the production web restarts",
    "applies the scratch_message owner after the production web restarts",
    "R1: a registry missing a schema kind refuses to compose with CONFIG and starts nothing",
    "R2: composing the agent registry beside the consensus-draft one is a CONFIG failure by design",
    "R4: stopping with nothing started resolves",
    "R5: a double start returns the same three handles",
    "R3: start refuses while the application is stopping"
  ],
  "test-support/__tests__/durable-workers-concurrency.integration.test.ts": [
    "D1: a live waiter and the durable worker on one command apply it exactly once",
    "D2: two production web instances on one database apply a dead instance's command exactly once",
    "E: SIGTERM while a claim is held either releases it in the drain or fails shutdown loudly"
  ],
  "test-support/__tests__/execution-ab-isolation.integration.test.ts": [
    "I1: the web identity is denied the host's private root while the harness and the host keep it",
    "I2: a launch with an upload completes through HTTP and Postgres, and the object and history read back",
    "I3: a SIGKILLed web restarts through production initialization under the same isolation and continues the run",
    "I4: the supervisor and its private root are untouched by the web's death and restart"
  ],
  "test-support/__tests__/execution-ab-process-cleanup.integration.test.ts": [
    "O-build-lock: a proved dead owner is reclaimed and the verified artifact is reused",
    "O-exit: 'success' retains the exact outcome and finishes cleanup",
    "O-exit: 'assertion failure' retains the exact outcome and finishes cleanup",
    "O-exit: 'missing reporter' retains the exact outcome and finishes cleanup",
    "O-exit: 'invalid reporter' retains the exact outcome and finishes cleanup",
    "O-roots: live users, foreign markers and replaced roots refuse deletion; terminal cleanup preserves the sibling",
    "O2-runner: runner SIGKILL makes the live Vitest worker and real fixture groups terminate themselves",
    "O-signal: runner SIGINT preserves failure and completes real-stack cleanup",
    "O-signal: runner SIGTERM preserves failure and completes real-stack cleanup",
    "O1: worker SIGKILL makes the real lane reap un-watched supervisor/web groups, remove roots and fail",
    "O1-default: worker SIGKILL remains a failed lane with both cleanup guards enabled",
    "O2: parent death kills the real supervisor and its TERM-resistant adapter without an exit sweep",
    "O-identity: exact environment tags exclude argv decoys and sibling invocations, and PID reuse refuses ownership"
  ],
  "test-support/__tests__/execution-ab-partitions.integration.test.ts": [
    "B4: sealed host object remains pending until the scoped catalogue barrier releases",
    "P1: ACK dropped after host commit → web SIGKILL + restart → exactly one result, no duplicate session.prompt",
    "P2: receipt partition exhausts real budgets as recoverable unknown; evidence release applies once",
    "P3-live: cut a partial live frame; reconnect from the exclusive cursor without a gap or duplicated effect",
    "P3-replay: cut replay of a durably completed command; replay resumes without a gap or duplicated effect",
    "P4: delayed checkpoint ACK reaches its original handler after successor epoch without a current-owner write"
  ],
  "test-support/__tests__/execution-ab-process-death.integration.test.ts": [
    "D2a: supervisor restart before create effect reissues the original durable intent once",
    "D2b: supervisor restart after create commit folds its receipt without another create",
    "D4: web dies after durable create ACK and before first host prompt; restart sends one prompt",
    "L1: active scratch cancellation settles once and the same session accepts a later turn",
    "D3: connection loss after projection claim rolls back effect and cursor; a successor projects once without a new event",
    "D1: supervisor death during NeedsInput preserves the 503 response intent and resumes through checkpoint idle"
  ],
  "test-support/__tests__/execution-ab-preflight.integration.test.ts": [
    "I-CI: the real driver denies the host root and the real PostgreSQL container is reachable"
  ]
};

export function validateLaneReport(report, files) {
  assert.equal(report.testResults.length, files.length, "A/B discovery omitted an owning suite");
  for (const file of files) {
    const result = report.testResults.find((item) => item.name.endsWith(file));

    assert(result?.assertionResults.length > 0, `A/B discovery is empty: ${file}`);
    assert(result.assertionResults.every((item) => item.status === "passed"), `A/B case failed or was skipped: ${file}`);
    for (const title of requiredIsolationCases[file] ?? []) {
      assert.equal(result.assertionResults.filter((item) => item.title === title).length, 1,
        `A/B required case missing or duplicated: ${file}: ${title}`);
    }
  }
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0, "A/B unhandled runtime error");
  assert.equal(report.success, true, "A/B reporter recorded errors");
}

export async function runStageAbLane({ slice, files = laneSuites[slice], workspace, evidenceDirectory = process.env.MAISTER_TEST_EVIDENCE_DIR }) {
  const startedAt = Date.now();
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
    logInvocation(invocation, "lane-suite-complete", { pid: process.pid, caseName: slice, durationMs: Date.now() - startedAt });
    console.log(JSON.stringify({ slice, invocationId: invocation.id, ledger: invocation.directory, node: process.versions.node, bundledUndici: process.versions.undici, concurrency, reportPath, ...status }));
    assert.equal(caughtSignal, undefined, `A/B runner interrupted by ${caughtSignal}`);
    assert.equal(status.code, 0, "A/B integration runner failed");
    const report = JSON.parse(await readFile(reportPath, "utf8"));

    validateLaneReport(report, files);
    console.log(JSON.stringify({ slice, passed: report.numPassedTests, suites: files.length, concurrency, reportPath }));
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "A/B execution and signal failed") : error;
  } finally {
    const cleanupStartedAt = Date.now();

    if (escalation) clearTimeout(escalation);
    await Promise.all(signalDeliveries);
    // S52-R6: each reclaimer owns a different resource class, so one throwing
    // must not skip the others — a failed process sweep used to leave every
    // container and root behind, which is the leak this runner exists to deny.
    const cleanupErrors = [];
    let leaks = [];
    let containers = [];

    for (const step of [
      async () => { leaks = await sweepInvocation(invocation); },
      async () => { containers = await removeInvocationContainers(invocation); },
      async () => { await removeInvocationRoots(invocation); },
      async () => {
        assert.equal(leaks.length, 0, "A/B invocation leaked processes; sweep reaped them");
        assert.equal(containers.length, 0, "A/B invocation leaked containers; terminal cleanup removed them");
      },
    ]) {
      try {
        await step();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      const cleanupFailure = cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "A/B terminal cleanup failed");

      failure = failure ? new AggregateError([failure, cleanupFailure], "A/B execution and cleanup failed") : cleanupFailure;
    }
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    logInvocation(invocation, "lane-complete", { role: "runner", caseName: slice, pid: process.pid, pgid: 0, rootRole: "invocation", bootId: invocation.id, outcome: failure ? "failed" : "passed", reportPath, cleanupDurationMs: Date.now() - cleanupStartedAt, durationMs: Date.now() - startedAt });
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
