import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { readLaunchResult } from "@/e2e/_seed/launch-stream";
import { poll } from "@/test-support/durable-workers-ledger";
import { type DatabaseFaultBarrier } from "@/test-support/fault-barriers";
import { type StartedPostgresTestDb } from "@/test-support/pg-container";
import { type RealSupervisor } from "@/test-support/real-supervisor";
import { buildProductionWeb, type RealWeb } from "@/test-support/real-web";
import {
  type FaultBarrier,
  type SupervisorFaultProxy,
} from "@/test-support/supervisor-fault-proxy";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  processIdentity,
  invocationFromEnvironment,
} from "@/test-support/process-invocation";
import {
  startProductionFaultFixture,
  type ProductionFaultFixture,
} from "@/test-support/production-fault-fixture";

let fixture: ProductionFaultFixture | undefined;

type CommandRow = {
  id: string;
  run_id: string;
  state: string;
  transport_state: string;
  application_state: string;
  completion_applied_at: Date | null;
  request_sha256: string;
  terminal_evidence_sha256: string | null;
  attempts: number;
};

let database: StartedPostgresTestDb | undefined;
let supervisor: RealSupervisor | undefined;
let web: RealWeb | undefined;
let proxy: SupervisorFaultProxy | undefined;
let dbBarrier: DatabaseFaultBarrier | undefined;
let projectId = "";
let cookie = "";
let adapterLog = "";

function hostHighWater(): bigint {
  const state = new DatabaseSync(
    path.join(supervisor!.stateDir, "state.sqlite"),
    { readOnly: true },
  );

  try {
    const row = state
      .prepare(
        "SELECT next_sequence FROM runtime_event_streams ORDER BY created_at DESC LIMIT 1",
      )
      .get();

    if (!row || typeof row.next_sequence !== "string")
      throw new Error("host stream high-water is unavailable");

    return BigInt(row.next_sequence) - 1n;
  } finally {
    state.close();
  }
}

async function api(route: string, init: RequestInit = {}): Promise<Response> {
  if (!web) throw new Error("production web has not started");

  return fetch(`${web.url}${route}`, {
    ...init,
    headers: { ...init.headers, cookie },
  });
}

async function launch(upload?: string): Promise<string> {
  const form = new FormData();

  form.append(
    "payload",
    JSON.stringify({
      projectId,
      baseBranch: "main",
      name: `partition-${randomUUID()}`,
      prompt: 'fixture-output:{"bytes":0,"text":"partition result"}',
      reasoningEffort: "high",
      attachments: [],
    }),
  );
  if (upload)
    form.append("files", new Blob(["sealed partition bytes\n"]), upload);
  const response = await api("/api/scratch-runs", {
    method: "POST",
    body: form,
  });

  if (response.status !== 200)
    throw new Error(`launch ${response.status}: ${await response.text()}`);

  return (await readLaunchResult(response)).runId;
}

async function command(id: string): Promise<CommandRow> {
  const result = await database!.pool.query<CommandRow>(
    "SELECT * FROM execution_commands WHERE id = $1",
    [id],
  );

  if (!result.rows[0]) throw new Error(`missing command ${id}`);

  return result.rows[0];
}

async function applied(id: string): Promise<CommandRow> {
  return poll(
    async () => {
      const row = await command(id);

      return row.completion_applied_at ? row : null;
    },
    180_000,
    "one production owner application",
    100,
  );
}

async function assertOneApplication(id: string): Promise<void> {
  const row = await applied(id);

  expect(row.state).toBe("succeeded");
  expect(row.terminal_evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
  const audit = await database!.pool.query<{
    owner: string;
    old_applied: Date | null;
  }>(
    "SELECT owner, old_applied FROM s52_application_audit WHERE command_id = $1",
    [id],
  );

  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]?.owner).toBeTruthy();
  expect(audit.rows[0]?.old_applied).toBeNull();
  const duplicate = await database!.pool.query<{ count: string }>(
    "SELECT count(*) FROM execution_commands WHERE run_id = $1 AND kind = 'session.prompt'",
    [row.run_id],
  );

  expect(duplicate.rows[0]?.count).toBe("1");
  const invocations = (await readFile(adapterLog, "utf8")).trim().split("\n");

  expect(invocations).toHaveLength(1);
  expect(JSON.parse(invocations[0]!)).toMatchObject({
    method: "session/prompt",
  });
  const detailResponse = await api(`/api/scratch-runs/${row.run_id}`);

  expect(detailResponse.status).toBe(200);
  expect(await detailResponse.json()).toMatchObject({
    scratch: { dialogStatus: "WaitingForUser" },
  });
  const messages = await poll(
    async () => {
      const result = await database!.pool.query<{ content: string }>(
        "SELECT content FROM run_messages WHERE run_id = $1 AND role = 'assistant'",
        [row.run_id],
      );

      return result.rows.length ? result.rows : null;
    },
    30_000,
    "canonical transcript result",
  );

  expect(messages).toEqual([{ content: "partition result" }]);
}

beforeAll(async () => {
  const logs =
    process.env.MAISTER_TEST_EVIDENCE_DIR ??
    (await mkdtempReal("s52-partition-build-"));

  await buildProductionWeb(path.join(logs, "partition-next-build.log"));
}, 600_000);

describe("S5.2 production-boot fault partitions", () => {
  beforeEach(async () => {
    fixture = await startProductionFaultFixture();
    ({ database, supervisor, proxy, web, projectId, adapterLog, cookie } =
      fixture);
  }, 120_000);

  afterEach(async (context) => {
    if (context.task.result?.state === "fail") {
      // eslint-disable-next-line no-console
      console.error(await fixture?.tails());
    }
    await fixture?.close();
    fixture = undefined;
    dbBarrier = undefined;
  }, 60_000);

  it("B4: sealed host object remains pending until the scoped catalogue barrier releases", async () => {
    // HTTP ACK loss alone cannot hold the catalogue: the independent seal
    // event must still publish it. This positive control identifies the bypass.
    const ackOnly = proxy!.arm(
      {
        caseId: "B4-HTTP-only",
        method: "PUT",
        path: /^\/runtime-objects\/[^/]+\/content$/,
      },
      "hold-response",
    );
    const ackOnlyLaunch = launch("http-only-upload.txt");

    void ackOnlyLaunch.catch(() => undefined);
    const ackOnlyWitness = await ackOnly.awaitReached();
    const ackOnlyObjectId = ackOnlyWitness.path.split("/")[2]!;

    await poll(
      async () => {
        const result = await database!.pool.query<{ state: string }>(
          "SELECT state FROM execution_runtime_objects WHERE id=$1",
          [ackOnlyObjectId],
        );

        return result.rows[0]?.state === "available" ? true : null;
      },
      30_000,
      "SSE publishes catalogue while only the HTTP ACK is held",
    );
    ackOnly.release();
    await ackOnlyLaunch;
    const upload = proxy!.arm(
      {
        caseId: "B4-upload",
        method: "PUT",
        path: /^\/runtime-objects\/[^/]+\/content$/,
      },
      "hold-request",
    );
    const launched = launch("barrier-upload.txt");

    void launched.catch(() => undefined);
    const request = await upload.awaitReached();
    const objectId = request.path.split("/")[2]!;

    dbBarrier = await fixture!.holdWrite({
      caseId: "B4",
      table: "execution_runtime_objects",
      matches: { id: objectId, state: "available" },
    });
    upload.release();
    const writer = await dbBarrier.awaitReached();

    expect(writer).toBeGreaterThan(0);
    const pending = await database!.pool.query<{ id: string; state: string }>(
      "SELECT id, state FROM execution_runtime_objects WHERE id = $1",
      [objectId],
    );

    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]?.state).toBe("pending");
    const metadata = await fetch(
      `${supervisor!.url}/runtime-objects/${pending.rows[0]!.id}`,
    );

    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ state: "available" });
    await dbBarrier.release();
    const runId = await launched;

    await poll(
      async () => {
        const rows = await database!.pool.query<{ state: string }>(
          "SELECT state FROM execution_runtime_objects WHERE id = $1",
          [pending.rows[0]!.id],
        );

        return rows.rows[0]?.state === "available" ? true : null;
      },
      60_000,
      "catalogue ACK after release",
    );
    const response = await api(
      `/api/runs/${runId}/runtime-objects/${pending.rows[0]!.id}/content`,
    );

    expect(await response.text()).toBe("sealed partition bytes\n");
  }, 180_000);

  it("P1: ACK dropped after host commit → web SIGKILL + restart → exactly one result, no duplicate session.prompt", async () => {
    const admission = proxy!.arm(
      {
        caseId: "P1-command",
        method: "POST",
        path: /^\/sessions\/[^/]+\/prompts$/,
      },
      "hold-request",
    );
    const launched = launch();

    void launched.catch(() => undefined);
    const selected = await admission.awaitReached();

    dbBarrier = await fixture!.holdWrite({
      caseId: "B2-P1-owner",
      table: "execution_commands",
      matches: { id: selected.commandId!, application_state: "applied" },
    });
    const ack = proxy!.arm(
      {
        caseId: "P1-ACK",
        commandId: selected.commandId!,
        method: "POST",
        path: /^\/sessions\/[^/]+\/prompts$/,
      },
      "hold-response",
    );
    const events = proxy!.arm(
      {
        caseId: "P1-evidence",
        commandId: selected.commandId!,
        method: "GET",
        path: /^\/runtime-events$/,
        eventType: "session.command",
      },
      "hold-events",
    );

    admission.release();
    const reached = await ack.awaitReached();

    expect(reached.status).toBe(202);
    expect(reached.commandId).toBeTruthy();
    const receipt = await fetch(
      `${supervisor!.url}/commands/${reached.commandId}`,
    );

    expect(receipt.status).toBe(200);
    const before = await command(reached.commandId!);

    expect(await receipt.json()).toMatchObject({
      commandId: reached.commandId,
      requestSha256: before.request_sha256,
    });

    expect(before.completion_applied_at).toBeNull();
    await events.awaitReached();
    const receiptProbe = proxy!.arm(
      {
        caseId: "P1-ACK-loss-observed",
        method: "GET",
        path: /^\/commands\/[^/]+$/,
        commandId: reached.commandId!,
      },
      "hold-request",
    );

    ack.cut();
    const ackClose = await poll(
      async () => ack.responseClosures[0] ?? null,
      15_000,
      "selected prompt ACK response closes",
    );

    expect(ackClose, "P1 dropped ACK sends no downstream response").toEqual({
      commandId: reached.commandId,
      headersSent: false,
      writableFinished: false,
    });
    await receiptProbe.awaitReached(15_000);
    await web!.kill("SIGKILL");
    receiptProbe.ownedProcessKilled();
    events.ownedProcessKilled();
    web = await fixture!.restartWeb();
    // A killed consumer retains its 30-second claim; allow lease expiry and
    // reconnect before requiring the actual blocked application writer.
    await dbBarrier.awaitReached(90_000);
    const claimed = await database!.pool.query<{
      terminal_event_id: string | null;
      application_claim_owner: string | null;
      completion_applied_at: Date | null;
    }>(
      "SELECT terminal_event_id, application_claim_owner, completion_applied_at FROM execution_commands WHERE id = $1",
      [reached.commandId],
    );

    expect(claimed.rows[0]?.terminal_event_id).toBeTruthy();
    expect(claimed.rows[0]?.application_claim_owner).toBeTruthy();
    expect(claimed.rows[0]?.completion_applied_at).toBeNull();
    await dbBarrier.release();
    await assertOneApplication(reached.commandId!);
    const after = await command(reached.commandId!);

    expect(after.request_sha256).toBe(before.request_sha256);
    const writer = await database!.pool.query<{ owner: string }>(
      "SELECT owner FROM s52_application_audit WHERE command_id = $1",
      [reached.commandId],
    );

    expect(writer.rows).toEqual([
      { owner: claimed.rows[0]!.application_claim_owner },
    ]);
    const next = await api(`/api/scratch-runs/${after.run_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: 'fixture-output:{"bytes":0,"text":"next reply"}',
        attachments: [],
      }),
    });

    expect(next.status).toBe(202);
    const history = await database!.pool.query<{
      role: string;
      content: string;
    }>(
      "SELECT role, content FROM run_messages WHERE run_id = $1 ORDER BY sequence",
      [after.run_id],
    );

    expect(history.rows).toEqual([
      {
        role: "user",
        content: 'fixture-output:{"bytes":0,"text":"partition result"}',
      },
      { role: "assistant", content: "partition result" },
      {
        role: "user",
        content: 'fixture-output:{"bytes":0,"text":"next reply"}',
      },
      { role: "assistant", content: "next reply" },
    ]);
    expect(
      (await readFile(adapterLog, "utf8")).trim().split("\n"),
    ).toHaveLength(2);
    await launched.catch(() => undefined);
    proxy!.assertDrained();
  }, 240_000);

  it("P2: receipt partition exhausts real budgets as recoverable unknown; evidence release applies once", async () => {
    const admission = proxy!.arm(
      {
        caseId: "P2-command",
        method: "POST",
        path: /^\/sessions\/[^/]+\/prompts$/,
      },
      "hold-request",
    );
    const launched = launch();

    void launched.catch(() => undefined);
    const selected = await admission.awaitReached();
    const ack = proxy!.arm(
      {
        caseId: "P2-first-ACK",
        commandId: selected.commandId!,
        method: "POST",
        path: /^\/sessions\/[^/]+\/prompts$/,
      },
      "hold-response",
    );
    const events = proxy!.arm(
      {
        caseId: "P2-accepted-and-terminal",
        commandId: selected.commandId!,
        method: "GET",
        path: /^\/runtime-events$/,
        eventType: "session.command",
      },
      "hold-events",
    );

    admission.release();
    const reached = await ack.awaitReached();
    const id = reached.commandId!;
    const drops = proxy!.arm(
      {
        caseId: "P2-retry-ACKs",
        method: "POST",
        path: /^\/sessions\/[^/]+\/prompts$/,
        commandId: id,
      },
      "drop-responses",
    );
    const receipts = proxy!.arm(
      {
        caseId: "P2-receipts",
        method: "GET",
        path: /^\/commands\/[^/]+$/,
        commandId: id,
      },
      "block-receipts",
    );

    await events.awaitReached();
    ack.cut();
    await receipts.awaitReached();
    const before = await command(id);
    const unknown = await poll(
      async () => {
        const row = await command(id);

        expect(row.state).not.toBe("failed");
        expect(row.completion_applied_at).toBeNull();

        return row.transport_state === "reconciliation_required" &&
          row.attempts >= 3
          ? row
          : null;
      },
      300_000,
      "three dispatches and their real five-probe budgets",
      100,
    );

    expect(unknown.state).toBe("queued");
    expect(receipts.observations.length).toBeGreaterThanOrEqual(15);
    expect(drops.observations.length).toBeGreaterThanOrEqual(2);
    expect(unknown.request_sha256).toBe(before.request_sha256);
    // Only this receipt route is partitioned: host identity and an unrelated missing receipt still respond.
    expect((await fetch(`${proxy!.url}/health`)).status).toBe(200);
    expect((await fetch(`${proxy!.url}/commands/${randomUUID()}`)).status).toBe(
      404,
    );
    expect((await fetch(`${supervisor!.url}/commands/${id}`)).status).toBe(200);
    receipts.release();
    drops.release();
    events.release();
    await assertOneApplication(id);
    await launched.catch(() => undefined);
    proxy!.assertDrained();
  }, 420_000);

  async function assertReplayRecovery(cut: FaultBarrier): Promise<void> {
    const reached = await cut.awaitReached();

    expect(reached.sequence).toMatch(/^[1-9][0-9]*$/);
    const sequence = BigInt(reached.sequence!);
    const before = await poll(
      async () => {
        const result = await database!.pool.query<{
          last_contiguous_sequence: string;
          last_seen_at: Date;
        }>(
          "SELECT last_contiguous_sequence, last_seen_at FROM execution_event_streams WHERE state = 'active'",
        );

        return result.rows[0] &&
          BigInt(result.rows[0].last_contiguous_sequence) === sequence - 1n
          ? result.rows[0]
          : null;
      },
      30_000,
      "exclusive prefix before the incomplete frame",
      50,
    );
    const connections = proxy!.traffic.filter(
      (entry) => entry.path === "/runtime-events",
    ).length;
    const duplicate = proxy!.arm(
      {
        caseId: "P3-explicit-duplicate",
        method: "GET",
        path: /^\/runtime-events$/,
        sequence: reached.sequence!,
      },
      "duplicate-frame",
    );

    cut.cut();
    const reconnect = await poll(
      async () => {
        const streams = proxy!.traffic.filter(
          (entry) => entry.path === "/runtime-events",
        );

        return streams.length > connections ? streams[connections] : null;
      },
      90_000,
      "runtime-event consumer reconnects after the cut",
    );

    expect(
      reconnect.lastEventId,
      "reconnect uses the committed exclusive cursor",
    ).toBe(before.last_contiguous_sequence);
    await duplicate.awaitReached(90_000);
    expect(duplicate.observations[0]!.lastEventId).toBe(
      before.last_contiguous_sequence,
    );
    expect(
      proxy!.traffic.filter((entry) => entry.path === "/runtime-events").length,
    ).toBeGreaterThan(connections);
    await poll(
      async () => {
        const result = await database!.pool.query<{
          last_contiguous_sequence: string;
          last_seen_at: Date;
          first_gap_sequence: string | null;
        }>(
          "SELECT last_contiguous_sequence, last_seen_at, first_gap_sequence FROM execution_event_streams WHERE state = 'active'",
        );
        const row = result.rows[0];

        return row &&
          BigInt(row.last_contiguous_sequence) >= sequence &&
          row.last_seen_at > before.last_seen_at &&
          row.first_gap_sequence === null
          ? row
          : null;
      },
      90_000,
      "contiguous replay and advanced stream liveness",
      100,
    );
    await poll(
      async () => {
        const log = await web!.logTail(4 * 1024 * 1024);

        return log
          .split("\n")
          .some(
            (line) =>
              line.includes('"disposition":"duplicate"') &&
              line.includes(`"sequence":"${reached.sequence}"`),
          )
          ? true
          : null;
      },
      30_000,
      "the duplicate frame classified by production ingest",
      100,
    );
    // The log line above carries the CLASSIFICATION; this carries the durable
    // EFFECT. `execution_events.ingest_disposition` has no `duplicate` value
    // (`schema.ts`) — ingest only bumps the stream's `last_seen_at` — so the
    // durable proof that the replayed frame was treated as a duplicate is that
    // it produced no second row for its sequence.
    const ingested = await database!.pool.query<{ count: string }>(
      `SELECT count(*) FROM execution_events e
         JOIN execution_event_streams s ON s.id = e.event_stream_id
        WHERE s.state = 'active' AND e.host_sequence = $1`,
      [reached.sequence],
    );

    expect(ingested.rows[0]?.count).toBe("1");
    await assertOneApplication(reached.commandId!);
  }

  it("P3-live: cut a partial live frame; reconnect from the exclusive cursor without a gap or duplicated effect", async () => {
    await poll(
      async () =>
        proxy!.traffic.find((entry) => entry.path === "/runtime-events") ??
        null,
      30_000,
      "live stream established before command production",
    );
    const highWater = hostHighWater();
    const cut = proxy!.arm(
      {
        caseId: "P3-live",
        method: "GET",
        path: /^\/runtime-events$/,
        eventType: "session.command",
      },
      "cut-frame",
    );
    const launched = launch();

    void launched.catch(() => undefined);
    expect(BigInt((await cut.awaitReached()).sequence!)).toBeGreaterThan(
      highWater,
    );
    await assertReplayRecovery(cut);
    await launched;
    proxy!.assertDrained();
  }, 240_000);

  it("P3-replay: cut replay of a durably completed command; replay resumes without a gap or duplicated effect", async () => {
    const hold = proxy!.arm(
      {
        caseId: "P3-create-replay-backlog",
        method: "GET",
        path: /^\/runtime-events$/,
        eventType: "session.command",
      },
      "hold-events",
    );
    const launched = launch();

    void launched.catch(() => undefined);
    const reached = await hold.awaitReached();

    await poll(
      async () => {
        const response = await fetch(
          `${supervisor!.url}/commands/${reached.commandId}`,
        );
        const receipt = (await response.json()) as { phase?: string };

        return receipt.phase === "completed" ? receipt : null;
      },
      30_000,
      "host terminal receipt proves a durable replay backlog",
      100,
    );
    const highWater = hostHighWater();
    const cut = proxy!.arm(
      {
        caseId: "P3-replay",
        method: "GET",
        path: /^\/runtime-events$/,
        sequence: reached.sequence!,
      },
      "cut-frame",
    );

    hold.cut();
    expect(
      BigInt((await cut.awaitReached(90_000)).sequence!),
    ).toBeLessThanOrEqual(highWater);
    await assertReplayRecovery(cut);
    await launched;
    proxy!.assertDrained();
  }, 240_000);
});

it("P4: delayed checkpoint ACK reaches its original handler after successor epoch without a current-owner write", async () => {
  // Outside the shared describe so this control can select a held ACP prompt.
  const stack = await startProductionFaultFixture({
    fixtureArgs: ["--controlled-prompt"],
  });

  onTestFinished(() => stack.close());

  try {
    const admission = stack.proxy.arm(
      {
        caseId: "P4-prompt",
        method: "POST",
        path: /^\/sessions\/[^/]+\/prompts$/,
      },
      "hold-request",
    );
    const runId = await stack.launchFlow();
    const selected = await admission.awaitReached();
    const ack = stack.proxy.arm(
      {
        caseId: "P4-prompt-ACK",
        method: "POST",
        path: /^\/sessions\/[^/]+\/prompts$/,
        commandId: selected.commandId!,
      },
      "hold-response",
    );
    const events = stack.proxy.arm(
      {
        caseId: "P4-old-evidence",
        method: "GET",
        path: /^\/runtime-events$/,
        eventType: "session.command",
        commandId: selected.commandId!,
      },
      "hold-events",
    );
    const receipt = stack.proxy.arm(
      {
        caseId: "P4-old-receipt",
        method: "GET",
        path: /^\/commands\/[^/]+$/,
        commandId: selected.commandId!,
      },
      "block-receipts",
    );

    admission.release();
    await ack.awaitReached();
    await events.awaitReached();
    ack.cut();
    await receipt.awaitReached();
    const checkpointRequest = stack.proxy.arm(
      {
        caseId: "P4-checkpoint-request",
        method: "POST",
        path: /^\/sessions\/[^/]+\/checkpoint$/,
      },
      "hold-request",
    );
    let oldResponseSettled = false;
    const oldResponse = stack
      .api(`/api/runs/${runId}/node-interrupt`, {
        method: "POST",
      })
      .then((response) => {
        oldResponseSettled = true;

        return response;
      });
    const request = await checkpointRequest.awaitReached();
    const oldAck = stack.proxy.arm(
      {
        caseId: "P4-stale-ACK",
        method: "POST",
        path: /^\/sessions\/[^/]+\/checkpoint$/,
        commandId: request.commandId!,
      },
      "hold-response",
    );

    checkpointRequest.release();
    const held = await oldAck.awaitReached();

    expect(held.status).toBe(200);
    expect(
      oldResponseSettled,
      "old handler remains pending at its held ACK",
    ).toBe(false);
    const interrupt = await stack.api(`/api/runs/${runId}/node-interrupt`, {
      method: "POST",
    });

    expect(interrupt.status).toBe(202);
    const { hitlRequestId } = (await interrupt.json()) as {
      hitlRequestId: string;
    };
    const successorPrompt = stack.proxy.arm(
      {
        caseId: "P4-successor",
        method: "POST",
        path: /^\/sessions\/[^/]+\/prompts$/,
        assignmentEpoch: 2,
      },
      "hold-request",
    );
    const restart = await stack.api(
      `/api/runs/${runId}/hitl/${hitlRequestId}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          optionId: "restart_node",
          workspacePolicy: "keep",
        }),
      },
    );

    expect(restart.status).toBe(202);
    events.release();
    receipt.release();
    const successor = await successorPrompt.awaitReached();

    expect(successor.assignmentEpoch).toBe(2);
    expect(
      oldResponseSettled,
      "successor commits before old handler settles",
    ).toBe(false);
    const snapshot = async (): Promise<unknown> =>
      (
        await stack.database.pool.query(
          `SELECT jsonb_build_object(
      'run', (SELECT jsonb_build_object('status',status,'step',current_step_id) FROM runs WHERE id=$1),
      'assignments', (SELECT jsonb_agg(jsonb_build_object('id',id,'epoch',epoch,'state',state) ORDER BY epoch) FROM execution_assignments WHERE run_id=$1),
      'sessions', (SELECT jsonb_agg(jsonb_build_object('id',id,'host',host_session_id,'assignment',execution_assignment_id) ORDER BY id) FROM run_sessions WHERE run_id=$1),
      'incarnations', (SELECT jsonb_agg(jsonb_build_object('id',id,'state',state,'session',host_session_id) ORDER BY id) FROM run_session_incarnations WHERE run_id=$1 AND assignment_epoch=2),
      'attempts', (SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'attempt',attempt) ORDER BY attempt) FROM node_attempts WHERE run_id=$1)
    ) AS state`,
          [runId],
        )
      ).rows[0].state;
    const before = await snapshot();
    const currentAttempts = await stack.database.pool.query<{ id: string }>(
      "SELECT id FROM node_attempts WHERE run_id=$1 AND status='Running'",
      [runId],
    );

    expect(currentAttempts.rows).toHaveLength(1);
    const currentAttemptId = currentAttempts.rows[0]!.id;

    await stack.database.pool
      .query(`CREATE TABLE s52_stale_writes(table_name text);
      CREATE FUNCTION s52_audit_stale() RETURNS trigger LANGUAGE plpgsql AS $audit$
      BEGIN IF to_jsonb(NEW) - ARRAY['updated_at','flow_driver_lease_expires_at'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['updated_at','flow_driver_lease_expires_at'] THEN
        INSERT INTO s52_stale_writes VALUES(TG_TABLE_NAME); END IF; RETURN NEW; END $audit$;
      CREATE TRIGGER s52_audit_stale AFTER UPDATE ON runs FOR EACH ROW WHEN (NEW.id = '${runId}') EXECUTE FUNCTION s52_audit_stale();
      CREATE TRIGGER s52_audit_stale AFTER UPDATE ON execution_assignments FOR EACH ROW WHEN (NEW.run_id = '${runId}' AND NEW.epoch = 2) EXECUTE FUNCTION s52_audit_stale();
      CREATE TRIGGER s52_audit_stale AFTER UPDATE ON run_sessions FOR EACH ROW WHEN (NEW.run_id = '${runId}') EXECUTE FUNCTION s52_audit_stale();
      CREATE TRIGGER s52_audit_stale AFTER UPDATE ON run_session_incarnations FOR EACH ROW WHEN (NEW.run_id = '${runId}' AND NEW.assignment_epoch = 2) EXECUTE FUNCTION s52_audit_stale();
      CREATE TRIGGER s52_audit_stale AFTER UPDATE ON node_attempts FOR EACH ROW WHEN (NEW.id = '${currentAttemptId}') EXECUTE FUNCTION s52_audit_stale()`);
    oldAck.release();
    const stale = await oldResponse;

    expect(
      await snapshot(),
      "stale evidence cannot mutate current owner state",
    ).toEqual(before);
    expect(
      (await stack.database.pool.query("SELECT * FROM s52_stale_writes")).rows,
    ).toEqual([]);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "CONFLICT" });
    successorPrompt.release();
    const second = await poll(
      async () => {
        const rows = (await readFile(stack.adapterLog, "utf8"))
          .trim()
          .split("\n");

        return rows.length === 2
          ? (JSON.parse(rows[1]!) as { pid: number })
          : null;
      },
      60_000,
      "successor ACP prompt held",
    );
    const identity = await processIdentity(
      invocationFromEnvironment()!,
      second.pid,
    );

    expect(identity?.owned).toBe(true);
    expect(identity?.ppid).toBe(stack.supervisor.pid);
    process.kill(second.pid, "SIGUSR1");
    const applied = await poll(
      async () => {
        const result = await stack.database.pool.query<{
          completion_applied_at: Date | null;
          application_state: string;
        }>(
          "SELECT completion_applied_at, application_state FROM execution_commands WHERE id=$1",
          [successor.commandId],
        );

        return result.rows[0]?.completion_applied_at ? result.rows[0] : null;
      },
      60_000,
      "successor application",
    );

    expect(applied.application_state).toBe("applied");
    const audit = await stack.database.pool.query<{ count: string }>(
      "SELECT count(*) FROM s52_application_audit WHERE command_id=$1",
      [successor.commandId],
    );

    expect(audit.rows[0]!.count).toBe("1");
    stack.proxy.assertDrained();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(await stack.tails()));
    throw error;
  }
}, 240_000);
