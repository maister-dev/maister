import type { FaultBarrier } from "@/test-support/supervisor-fault-proxy";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import {
  invocationFromEnvironment,
  processIdentity,
} from "@/test-support/process-invocation";
import {
  readScratchPromptIntent,
  type ScratchPromptIntent,
} from "@/lib/scratch-runs/prompt-intent";
import { initRepo, git } from "@/test-support/git-fixture";
import { WORKER_ADMIN } from "@/test-support/durable-workers-seed";
import { readLaunchResult } from "@/e2e/_seed/launch-stream";
import { localPackages } from "@/lib/db/schema";
import { serializeScaffoldManifest } from "@/lib/local-packages/manifest";
import { FLOW_ASSISTANT_ACTION_SCHEMA_VERSION } from "@/lib/studio/flow-assistant/protocol";
import { poll } from "@/test-support/durable-workers-ledger";
import {
  startProductionFaultSuite,
  type ProductionFaultSuite,
  type ProductionFaultFixture,
} from "@/test-support/production-fault-fixture";
import { buildProductionWeb } from "@/test-support/real-web";
import { mkdtempReal } from "@/test-support/worktree-test-root";

let fixture: ProductionFaultFixture | undefined;
let suite: ProductionFaultSuite;

beforeAll(async () => {
  const logs =
    process.env.MAISTER_TEST_EVIDENCE_DIR ??
    (await mkdtempReal("r9-s1-build-"));

  await buildProductionWeb(path.join(logs, "scratch-dispatch-next-build.log"));
  suite = await startProductionFaultSuite();
}, 600_000);

afterAll(async () => {
  await suite?.stop();
}, 90_000);

afterEach(async (context) => {
  if (context.task.result?.state === "fail") {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(await fixture?.tails()));
  }
  await fixture?.close();
  fixture = undefined;
}, 90_000);

async function restartUnadmittedTurn(
  dispatch: () => Promise<unknown>,
  releaseRestartedTurn: () => Promise<void> = async () => {},
  admissionMatch: Readonly<Record<string, string>> = {},
): Promise<{ runId: string; intent: ScratchPromptIntent }> {
  if (!fixture) throw new Error("S1 fixture is not started");
  const barrier = await fixture.holdWrite({
    caseId: "s1-launch-before-admission",
    table: "execution_commands",
    matches: {
      kind: "session.prompt",
      owner_kind: "scratch_message",
      ...admissionMatch,
    },
  });
  const launching = dispatch().then(
    (result) => ({ kind: "completed" as const, result }),
    (error: unknown) => ({ kind: "interrupted" as const, error }),
  );
  let released = false;
  let settled = false;

  try {
    await barrier.awaitReached(60_000);
    const { rows } = await fixture.database.pool.query<{
      run_id: string;
      dialog_status: string;
      active_prompt_intent: Record<string, unknown> | null;
      host_session_id: string;
    }>(`SELECT s.run_id, s.dialog_status, s.active_prompt_intent,
        i.host_session_id FROM scratch_runs s
        JOIN runs r ON r.id = s.run_id
        JOIN run_sessions rs ON rs.run_id = r.id
          AND rs.execution_assignment_id = r.execution_assignment_id
        JOIN run_session_incarnations i ON i.run_session_id = rs.id
          AND i.host_session_id = rs.host_session_id
        WHERE r.status = 'Running' AND s.dialog_status = 'Running'
          AND i.state IN ('created', 'active')`);

    expect(rows).toHaveLength(1);
    const before = rows[0]!;
    const count = await fixture.database.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM execution_commands WHERE run_id = $1 AND kind = 'session.prompt'",
      [before.run_id],
    );

    const previousCount = count.rows[0]!.count;

    // The bound is two eligible ticks. Keep the live driver's admission
    // blocked until the persisted wake threshold has actually passed.
    await poll(
      async () => {
        const age = await fixture!.database.pool.query<{ eligible: boolean }>(
          "SELECT updated_at < now() - interval '1 second' AS eligible FROM scratch_runs WHERE run_id=$1",
          [before.run_id],
        );

        return age.rows[0]?.eligible ? true : null;
      },
      3_000,
      "scratch intent age eligibility under the admission barrier",
    );
    await fixture.web.kill("SIGKILL");
    await barrier.release();
    released = true;
    await barrier.close();
    await launching;
    await fixture.restartWeb();
    await poll(
      async () => {
        const commands = await fixture!.database.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.prompt'",
          [before.run_id],
        );

        return commands.rows[0]!.count > previousCount ? true : null;
      },
      5_000,
      "scratch command admission after the eligible worker wake",
    );
    await releaseRestartedTurn();
    const completed = await poll(
      async () => {
        const result = await fixture!.database.pool.query<{
          id: string;
          request_canonical_json: string;
          logical_operation_key: string;
          target_session_id: string;
          state: string;
          completion_applied_at: Date | null;
        }>(
          "SELECT * FROM execution_commands WHERE run_id = $1 AND kind = 'session.prompt' ORDER BY created_at",
          [before.run_id],
        );

        return result.rows.length > previousCount &&
          result.rows
            .slice(previousCount)
            .some((row) => row.completion_applied_at !== null)
          ? result.rows.slice(previousCount)
          : null;
      },
      // The killed event consumer can retain its existing 30-second lease.
      // Admission has its separate bound above; completion waits for the
      // canonical transcript frontier after that lease is reclaimed.
      60_000,
      "scratch continuation after an unadmitted Running commit",
    );

    expect(completed).toHaveLength(1);
    expect(completed[0]!.state).toBe("succeeded");
    expect(completed[0]!.target_session_id).toBe(before.host_session_id);
    expect(before.active_prompt_intent).not.toBeNull();
    expect(completed[0]!.logical_operation_key).toBe(
      before.active_prompt_intent!.logicalOperationKey,
    );
    expect(JSON.parse(completed[0]!.request_canonical_json).payload).toEqual(
      before.active_prompt_intent!.payload,
    );
    const dialog = await fixture.database.pool.query<{ dialog_status: string }>(
      "SELECT dialog_status FROM scratch_runs WHERE run_id = $1",
      [before.run_id],
    );

    expect(dialog.rows[0]!.dialog_status).toBe("WaitingForUser");
    const workerLog = (await readFile(fixture.web.logFile, "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const boot = workerLog.findLast(
      (entry) => entry.msg === "agent-continuation-worker-started",
    );
    const visit = workerLog.find(
      (entry) =>
        entry.msg === "scratch-continuation-visit" &&
        entry.workerId === boot?.workerId &&
        entry.runId === before.run_id,
    );

    expect(
      visit?.tick,
      "age-eligible candidate on the restarted worker",
    ).toBeLessThanOrEqual(2);

    settled = true;

    return {
      runId: before.run_id,
      intent: readScratchPromptIntent(before.active_prompt_intent),
    };
  } catch (error) {
    const state = await fixture.database.pool.query(
      `SELECT json_build_object(
        'runs', (SELECT json_agg(json_build_object('id',id,'status',status,'assignment',execution_assignment_id)) FROM runs),
        'scratch', (SELECT json_agg(json_build_object('runId',run_id,'dialog',dialog_status)) FROM scratch_runs),
        'commands', (SELECT json_agg(json_build_object('id',id,'kind',kind,'state',state,'application',application_state,'session',target_session_id)) FROM execution_commands),
        'incarnations', (SELECT json_agg(json_build_object('id',id,'session',host_session_id,'state',state)) FROM run_session_incarnations),
        'streams', (SELECT json_agg(json_build_object('id',id,'owner',claim_owner,'expires',claim_expires_at,'contiguous',last_contiguous_sequence)) FROM execution_event_streams)
      ) AS state`,
    );

    await writeFile(
      "/private/tmp/r9-s1-last-failure.json",
      JSON.stringify({ state: state.rows, tails: await fixture.tails() }),
    );
    throw error;
  } finally {
    if (!settled) await fixture.web.kill("SIGKILL");
    if (!released) await barrier.release();
    await launching;
  }
}

function message(runId: string, content: string): Promise<Response> {
  return fixture!.api(`/api/scratch-runs/${runId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, attachments: [] }),
  });
}
const outputPrompt = 'fixture-output:{"bytes":0,"text":"dispatch recovered"}';

async function adapterPrompt(
  index: number,
): Promise<{ pid: number; sessionId: string }> {
  return poll(
    async () => {
      let data: string;

      try {
        data = await readFile(fixture!.adapterLog, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const rows = data
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              pid: number;
              sessionId: string;
              method: string;
            },
        )
        .filter((row) => row.method === "session/prompt");

      return rows[index] ?? null;
    },
    45_000,
    `adapter prompt ${index}`,
  );
}
async function signalAdapter(
  index: number,
  signal: NodeJS.Signals,
): Promise<void> {
  const row = await adapterPrompt(index);
  const identity = await processIdentity(invocationFromEnvironment()!, row.pid);

  expect(identity?.owned).toBe(true);
  expect(identity?.ppid).toBe(fixture!.supervisor.pid);
  process.kill(row.pid, signal);
}

it("S1 launch: a web death after Running commits and before prompt admission re-drives the original turn once", async () => {
  fixture = await suite.startFixture();
  const recovered = await restartUnadmittedTurn(() =>
    fixture!.launchScratch(outputPrompt),
  );

  expect(recovered.intent.owner.ref.variant).toBe("initial");
}, 240_000);

it("S1 direct message: a later turn on the same incarnation is recovered after an earlier completed prompt", async () => {
  fixture = await suite.startFixture();
  const runId = await fixture.launchScratch(outputPrompt);
  const recovered = await restartUnadmittedTurn(() =>
    message(runId, outputPrompt),
  );

  expect(recovered.runId).toBe(runId);
  expect(recovered.intent.owner.ref.variant).toBe("message");
}, 240_000);

it("S1 queue: death after FIFO queued-to-prompted commit re-drives that message", async () => {
  fixture = await suite.startFixture({
    fixtureArgs: ["--controlled-prompt"],
  });
  const runId = await fixture.launchScratch("");
  const first = message(runId, outputPrompt).then(
    (response) => response.status,
    (error: unknown) => error,
  );

  try {
    await adapterPrompt(0);
    const queued = await message(runId, outputPrompt);

    expect(queued.status).toBe(202);
    const accepted = (await queued.json()) as {
      delivery: string;
      messageId: string;
      sequence: number;
    };

    expect(accepted.delivery).toBe("queued");
    const recovered = await restartUnadmittedTurn(
      async () => {
        await signalAdapter(0, "SIGUSR1");

        return first;
      },
      () => signalAdapter(1, "SIGUSR1"),
      {
        logical_operation_key: `scratch_message:message:${accepted.messageId}:${accepted.sequence}`,
      },
    );

    expect(recovered.intent.owner.ref.variant).toBe("message");
  } finally {
    await fixture.web.kill("SIGKILL");
    await first;
  }
}, 240_000);

it("S1 Recover: death after the recovery generation's Running commit preserves its recovery key", async () => {
  fixture = await suite.startFixture({
    fixtureArgs: ["--controlled-prompt"],
  });
  const runId = await fixture.launchScratch("");
  const first = message(runId, outputPrompt).then(
    (response) => response.status,
    (error: unknown) => error,
  );

  try {
    await signalAdapter(0, "SIGKILL");
    await first;
    await poll(
      async () => {
        const result = await fixture!.database.pool.query<{ status: string }>(
          "SELECT status FROM runs WHERE id = $1",
          [runId],
        );

        return result.rows[0]?.status === "Crashed" ? true : null;
      },
      45_000,
      "scratch child crash before Recover",
    );
    const recovered = await restartUnadmittedTurn(
      () =>
        fixture!.api(`/api/scratch-runs/${runId}/recover`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: outputPrompt }),
        }),
      () => signalAdapter(1, "SIGUSR1"),
    );

    expect(recovered.intent.owner.ref.variant).toBe("recovery");
  } finally {
    await fixture.web.kill("SIGKILL");
    await first;
  }
}, 240_000);

it("S1 D-A8: death after a parked permission respawns preserves the generation turn and stored answer", async () => {
  fixture = await suite.startFixture({
    fixtureEnv: { MAISTER_PERMISSION_MAX_HOURS: "0.00222" },
  });
  const launching = fixture
    .launchScratch(
      'fixture-output:{"bytes":0,"text":"idle recovered","permission":true}',
    )
    .then(
      (runId) => runId,
      (error: unknown) => error,
    );
  let resumedPrompt: FaultBarrier | undefined;
  let resumedPromptReleased = false;

  try {
    const parked = await poll(
      async () => {
        const result = await fixture!.database.pool.query<{
          run_id: string;
          id: string;
        }>(
          `SELECT h.run_id, h.id FROM hitl_requests h JOIN runs r ON r.id = h.run_id WHERE r.status = 'NeedsInputIdle' AND h.kind = 'permission' AND h.responded_at IS NULL AND h.superseded_at IS NULL`,
        );

        return result.rows[0] ?? null;
      },
      60_000,
      "host cap parks scratch permission",
    );

    await launching;
    // The short cap creates the initial park. Do not start its second timer
    // while the restarted web is still booting on the hosted Intel runner.
    resumedPrompt = fixture.proxy.arm(
      {
        caseId: "s1-idle-resume-after-web-ready",
        method: "POST",
        path: /^\/sessions\/[^/]+\/prompts$/,
        assignmentEpoch: 2,
      },
      "hold-request",
    );
    const recovered = await restartUnadmittedTurn(
      () =>
        fixture!.api(`/api/runs/${parked.run_id}/hitl/${parked.id}/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ optionId: "allow" }),
        }),
      async () => {
        const witness = await resumedPrompt!.awaitReached();
        const admitted = await fixture!.database.pool.query<{ id: string }>(
          "SELECT id FROM execution_commands WHERE run_id=$1 AND kind='session.prompt' ORDER BY created_at DESC LIMIT 1",
          [parked.run_id],
        );

        expect(witness.assignmentEpoch).toBe(2);
        expect(witness.commandId).toBe(admitted.rows[0]!.id);
        resumedPrompt!.release();
        resumedPromptReleased = true;
      },
    );

    expect(recovered.intent.owner.ref.variant).toBe("recovery");
    const answer = await fixture.database.pool.query<{
      responded_at: Date | null;
    }>("SELECT responded_at FROM hitl_requests WHERE id = $1", [parked.id]);

    expect(answer.rows[0]!.responded_at).not.toBeNull();
    const permissions = await fixture.database.pool.query(
      "SELECT id FROM hitl_requests WHERE run_id = $1 AND kind = 'permission'",
      [parked.run_id],
    );

    expect(permissions.rows).toHaveLength(1);
  } finally {
    await fixture.web.kill("SIGKILL");
    if (resumedPrompt?.observations.length && !resumedPromptReleased)
      resumedPrompt.ownedProcessKilled();
    await launching;
  }
}, 240_000);

it("S1 legacy: a Running dialog without frozen intent exposes unknown delivery and sends nothing", async () => {
  fixture = await suite.startFixture();
  const runId = await fixture.launchScratch("");

  // Mixed-version writer fixture: the old writer could commit Running without
  // a recoverable intent. This is not proof that its host effect was unsent.
  await fixture.database.pool.query(
    "UPDATE scratch_runs SET dialog_status = 'Running', active_prompt_intent = NULL, updated_at = now() - interval '2 seconds' WHERE run_id = $1",
    [runId],
  );
  const detail = await poll(
    async () => {
      const response = await fixture!.api(`/api/scratch-runs/${runId}`);
      const body = (await response.json()) as {
        scratch: { errorMetadata: { reason?: string } | null };
      };

      return body.scratch.errorMetadata?.reason === "scratch_dispatch_unknown"
        ? body
        : null;
    },
    15_000,
    "legacy unknown-delivery notice",
  );

  expect(detail.scratch).not.toHaveProperty("activePromptIntent");
  const commands = await fixture.database.pool.query(
    "SELECT id FROM execution_commands WHERE run_id = $1 AND kind = 'session.prompt'",
    [runId],
  );

  expect(commands.rows).toHaveLength(0);
  const stopped = await fixture.api(`/api/scratch-runs/${runId}/stop`, {
    method: "POST",
  });

  expect(stopped.ok).toBe(true);
  const run = await fixture.database.pool.query<{ status: string }>(
    "SELECT status FROM runs WHERE id = $1",
    [runId],
  );

  expect(run.rows[0]!.status).toBe("Review");
}, 120_000);

it("S1 race: a live dispatcher paused at admission and the worker share one immutable command", async () => {
  fixture = await suite.startFixture();
  const runId = await fixture.launchScratch("");
  const barrier = await fixture.holdWrite({
    caseId: "s1-live-worker-race",
    table: "execution_commands",
    matches: { run_id: runId, kind: "session.prompt" },
  });
  const sending = message(runId, outputPrompt).then(
    (response) => response.status,
    (error: unknown) => error,
  );
  let released = false;

  try {
    const writerPid = await barrier.awaitReached();

    // A transaction waiting on the live driver's run lock proves that the
    // actual continuation worker visited this candidate before release.
    await poll(
      async () => {
        const result = await fixture!.database.pool.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE pid <> $1 AND datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%runs%for update%'`,
          [writerPid],
        );

        return result.rows[0] ?? null;
      },
      15_000,
      "continuation worker contends with live prompt admission",
    );
    await barrier.release();
    released = true;
    await barrier.close();
    expect(await sending).toBe(202);
    const commands = await poll(
      async () => {
        const result = await fixture!.database.pool.query<{
          id: string;
          completion_applied_at: Date | null;
        }>(
          "SELECT id, completion_applied_at FROM execution_commands WHERE run_id = $1 AND kind = 'session.prompt'",
          [runId],
        );

        return result.rows.some((row) => row.completion_applied_at !== null)
          ? result.rows
          : null;
      },
      25_000,
      "one application after admission contention",
    );

    expect(commands).toHaveLength(1);
  } finally {
    await fixture.web.kill("SIGKILL");
    if (!released) await barrier.release();
    await sending;
  }
}, 120_000);

async function packageEditor(): Promise<{
  id: string;
  sessionId: string;
  workingDir: string;
}> {
  const sessionId = randomUUID();
  const workingDir = await initRepo(path.join(fixture!.root, "local-package"));

  await writeFile(
    path.join(workingDir, "maister-package.yaml"),
    serializeScaffoldManifest("s1-package", "S1 package"),
  );
  await git(workingDir, "add", "maister-package.yaml");
  await git(workingDir, "commit", "-q", "-m", "scaffold");
  const user = await fixture!.database.pool.query<{ id: string }>(
    "SELECT id FROM users WHERE email = $1",
    [WORKER_ADMIN.email],
  );
  const [pkg] = await fixture!.database.db
    .insert(localPackages)
    .values({
      name: "S1 package",
      slug: `s1-${randomUUID()}`,
      workingDir,
      createdBy: user.rows[0]!.id,
    })
    .returning({ id: localPackages.id });

  if (!pkg) throw new Error("package seed did not return its identity");
  const lock = await fixture!.api(
    `/api/studio/local-packages/${pkg.id}/lock-refresh`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    },
  );

  expect(lock.ok).toBe(true);
  expect((await lock.json()).heldByMe).toBe(true);

  return { id: pkg.id, sessionId, workingDir };
}

function packageActionPrompt(file: string): string {
  const action = [
    "Prepared update.",
    "```maister-flow-assistant-action",
    JSON.stringify({
      schemaVersion: FLOW_ASSISTANT_ACTION_SCHEMA_VERSION,
      actionId: "recovered-action",
      summary: "Recover original package action",
      operations: [
        {
          op: "upsert_file",
          path: file,
          baseHash: null,
          content: "# Recovered original turn\n",
        },
      ],
    }),
    "```",
  ].join("\n");

  return `fixture-output:${JSON.stringify({ bytes: 0, text: action })}`;
}
async function launchPackage(
  pkg: { id: string; sessionId: string },
  prompt: string,
): Promise<string> {
  const response = await fixture!.api(
    `/api/studio/local-packages/${pkg.id}/assistant`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: pkg.sessionId,
        prompt,
        intent: "edit",
        focus: { path: "maister-package.yaml" },
      }),
    },
  );

  if (!response.ok)
    throw new Error(
      `package launch ${response.status}: ${await response.text()}`,
    );

  return (await readLaunchResult(response)).runId;
}
async function assertRecoveredPackageAction(
  runId: string,
  intent: ScratchPromptIntent,
  file: string,
): Promise<void> {
  const ref = intent.owner.ref;

  if (!("postprocessActionId" in ref))
    throw new Error("recovered package owner has no action identity");
  const action = await poll(
    async () => {
      const result = await fixture!.database.pool.query<{
        id: string;
        state: string;
        lock_generation: string;
      }>(
        "SELECT id, state, lock_generation FROM flow_assistant_actions WHERE run_id = $1",
        [runId],
      );

      return result.rows.some((row) => row.state === "applied")
        ? result.rows
        : null;
    },
    25_000,
    "original package action postprocess",
  );

  expect(action).toHaveLength(1);
  expect(action[0]!.id).toBe(ref.postprocessActionId);
  expect(action[0]!.lock_generation).toBe(ref.lockGeneration);
  expect(intent.payload.prompt).toContain("maister-package.yaml");
  expect(intent.payload.prompt).toContain("edit");
  expect(action[0]!.state).toBe("applied");
  const [pkg] = await fixture!.database.pool
    .query<{
      working_dir: string;
    }>("SELECT working_dir FROM local_packages WHERE id = $1", [
      ref.localPackageId,
    ])
    .then((result) => result.rows);

  expect(await readFile(path.join(pkg!.working_dir, file), "utf8")).toBe(
    "# Recovered original turn\n",
  );
}

it("S1 package launch: restart retains request context, edit-lock generation and exactly one postprocess action", async () => {
  fixture = await suite.startFixture();
  const pkg = await packageEditor();
  const recovered = await restartUnadmittedTurn(() =>
    launchPackage(pkg, packageActionPrompt("rules/launch-recovered.md")),
  );

  expect(recovered.intent.owner.ref.variant).toBe("package_initial");
  await assertRecoveredPackageAction(
    recovered.runId,
    recovered.intent,
    "rules/launch-recovered.md",
  );
}, 240_000);

it("S1 package message: restart retains request-only follow-up context and its original action ID", async () => {
  fixture = await suite.startFixture();
  const pkg = await packageEditor();
  const runId = await launchPackage(pkg, outputPrompt);
  const recovered = await restartUnadmittedTurn(() =>
    fixture!.api(
      `/api/studio/local-packages/${pkg.id}/assistant/${runId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: pkg.sessionId,
          content: packageActionPrompt("rules/message-recovered.md"),
          intent: "edit",
          focus: { path: "maister-package.yaml" },
        }),
      },
    ),
  );

  expect(recovered.intent.owner.ref.variant).toBe("package_message");
  await assertRecoveredPackageAction(
    runId,
    recovered.intent,
    "rules/message-recovered.md",
  );
}, 240_000);

it("S3 transport: a held parked exit is fenced before the canonical scratch consumer", async () => {
  fixture = await suite.startFixture({
    fixtureEnv: { MAISTER_PERMISSION_MAX_HOURS: "0.00222" },
  });
  const oldExit = fixture.proxy.arm(
    {
      caseId: "s3-parked-exit",
      method: "GET",
      path: /^\/runtime-events$/,
      eventType: "session.exited",
      assignmentEpoch: 1,
    },
    "hold-events",
  );
  const nextPrompt = fixture.proxy.arm(
    {
      caseId: "s3-successor-prompt",
      method: "POST",
      path: /^\/sessions\/[^/]+\/prompts$/,
      assignmentEpoch: 2,
    },
    "hold-request",
  );
  let oldReleased = false;
  let terminalReleased = false;
  let oldTerminal: FaultBarrier | undefined;
  let nextReleased = false;
  const launching = fixture
    .launchScratch(
      'fixture-output:{"bytes":0,"text":"successor result","permission":true}',
    )
    .catch((error: unknown) => error);

  try {
    const request = await poll(
      async () => {
        const result = await fixture!.database.pool.query<{
          run_id: string;
          id: string;
        }>(
          "SELECT h.run_id,h.id FROM hitl_requests h WHERE h.kind='permission' AND h.responded_at IS NULL AND h.superseded_at IS NULL",
        );

        return result.rows[0] ?? null;
      },
      10_000,
      "parked permission before its held exit",
    );
    const initialCommand = await fixture.database.pool.query<{ id: string }>(
      "SELECT id FROM execution_commands WHERE run_id=$1 AND kind='session.prompt'",
      [request.run_id],
    );

    // The accepted frame precedes the persisted permission. Hold only the
    // upcoming terminal of this known command so its observer stays alive.
    oldTerminal = fixture.proxy.arm(
      {
        caseId: "s3-parked-prompt-terminal",
        method: "GET",
        path: /^\/runtime-events$/,
        eventType: "session.command",
        commandId: initialCommand.rows[0]!.id,
      },
      "hold-events",
    );
    const [exitWitness] = await Promise.all([
      oldExit.awaitReached(60_000),
      oldTerminal.awaitReached(60_000),
    ]);
    const responding = fixture.api(
      `/api/runs/${request.run_id}/hitl/${request.id}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionId: "allow" }),
      },
    );

    expect((await responding).status).toBe(202);
    await nextPrompt.awaitReached(20_000);
    const before = await fixture.database.pool.query(
      `SELECT r.status,s.dialog_status,i.id AS incarnation FROM runs r
       JOIN scratch_runs s ON s.run_id=r.id
       JOIN run_sessions rs ON rs.run_id=r.id AND rs.execution_assignment_id=r.execution_assignment_id
       JOIN run_session_incarnations i ON i.run_session_id=rs.id AND i.host_session_id=rs.host_session_id
       WHERE r.id=$1`,
      [request.run_id],
    );

    expect(before.rows[0]).toMatchObject({
      status: "Running",
      dialog_status: "Running",
    });
    oldExit.release();
    oldReleased = true;
    oldTerminal.release();
    terminalReleased = true;
    await poll(
      async () => {
        const event = await fixture!.database.pool.query<{
          ingest_disposition: string;
        }>(
          "SELECT e.ingest_disposition FROM execution_events e JOIN execution_event_streams es ON es.id=e.event_stream_id WHERE es.stream_id=$1 AND e.host_sequence=$2",
          [exitWitness.streamId, exitWitness.sequence],
        );

        return event.rows[0]?.ingest_disposition === "stale_epoch"
          ? true
          : null;
      },
      10_000,
      "late exit is fenced at canonical ingestion",
    );
    const observed = await fixture.database.pool.query(
      "SELECT r.status,s.dialog_status FROM runs r JOIN scratch_runs s ON s.run_id=r.id WHERE r.id=$1",
      [request.run_id],
    );

    expect(observed.rows[0]).toEqual({
      status: "Running",
      dialog_status: "Running",
    });

    nextPrompt.release();
    nextReleased = true;
    await poll(
      async () => {
        const state = await fixture!.database.pool.query(
          "SELECT dialog_status FROM scratch_runs WHERE run_id=$1",
          [request.run_id],
        );

        return state.rows[0]?.dialog_status === "WaitingForUser" ? true : null;
      },
      60_000,
      "successor owns its completed turn",
    );
  } finally {
    await fixture.web.kill("SIGKILL");
    if (!oldReleased && oldExit.observations.length)
      oldExit.ownedProcessKilled();
    if (!terminalReleased && oldTerminal?.observations.length)
      oldTerminal.ownedProcessKilled();
    if (!nextReleased && nextPrompt.observations.length)
      nextPrompt.ownedProcessKilled();
    await launching;
  }
}, 240_000);
