import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeAll, expect, it } from "vitest";

import { buildProductionWeb } from "@/test-support/real-web";
import { poll } from "@/test-support/durable-workers-ledger";
import {
  startProductionFaultFixture,
  type ProductionFaultFixture,
} from "@/test-support/production-fault-fixture";
import {
  invocationFromEnvironment,
  processIdentity,
} from "@/test-support/process-invocation";
import { mkdtempReal } from "@/test-support/worktree-test-root";

let fixture: ProductionFaultFixture | undefined;

beforeAll(async () => {
  const logs =
    process.env.MAISTER_TEST_EVIDENCE_DIR ??
    (await mkdtempReal("s52-death-build-"));

  await buildProductionWeb(path.join(logs, "death-next-build.log"));
}, 600_000);

afterEach(async (context) => {
  if (context.task.result?.state === "fail") {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(await fixture?.tails()));
  }
  await fixture?.close();
  fixture = undefined;
}, 90_000);

type Command = {
  id: string;
  run_id: string;
  state: string;
  create_intent: { requestSha256: string; operationKey: string } | null;
  completion_applied_at: Date | null;
  terminal_event_id: string | null;
  application_state: string;
  request_sha256: string | null;
  target_session_id: string | null;
  assignment_epoch: number;
};
async function commands(runId: string, kind: string): Promise<Command[]> {
  return (
    await fixture!.database.pool.query<Command>(
      "SELECT * FROM execution_commands WHERE run_id = $1 AND kind = $2 ORDER BY created_at",
      [runId, kind],
    )
  ).rows;
}
async function completedPrompt(runId: string): Promise<Command> {
  return poll(
    async () =>
      (await commands(runId, "session.prompt")).find(
        (row) => row.completion_applied_at,
      ) ?? null,
    180_000,
    "production prompt owner completion",
  );
}
async function assertOneApply(command: Command): Promise<void> {
  const audit = await fixture!.database.pool.query<{
    owner: string;
    old_applied: Date | null;
  }>(
    "SELECT owner, old_applied FROM s52_application_audit WHERE command_id = $1",
    [command.id],
  );

  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]!.owner).toBeTruthy();
  expect(audit.rows[0]!.old_applied).toBeNull();
}
async function bindingAudit(): Promise<void> {
  await fixture!.database.pool
    .query(`CREATE TABLE s52_binding_audit(run_id text, session_id text, assignment_id text);
    CREATE FUNCTION s52_audit_binding() RETURNS trigger LANGUAGE plpgsql AS $audit$
    BEGIN IF NEW.host_session_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.host_session_id IS DISTINCT FROM OLD.host_session_id) THEN
      INSERT INTO s52_binding_audit VALUES(NEW.run_id, NEW.host_session_id, NEW.execution_assignment_id);
    END IF; RETURN NEW; END $audit$;
    CREATE TRIGGER s52_audit_binding AFTER INSERT OR UPDATE ON run_sessions FOR EACH ROW EXECUTE FUNCTION s52_audit_binding()`);
}
async function assertOneBinding(runId: string): Promise<string> {
  const row = await poll(
    async () => {
      const result = await fixture!.database.pool.query<{ session_id: string }>(
        "SELECT session_id FROM s52_binding_audit WHERE run_id = $1",
        [runId],
      );

      return result.rows.length ? result.rows : null;
    },
    180_000,
    "one production create binding",
  );

  expect(row).toHaveLength(1);
  expect(row[0]!.session_id).toBeTruthy();

  return row[0]!.session_id;
}
async function adapterInvocations(): Promise<
  Array<{ pid: number; sessionId: string }>
> {
  try {
    return (await readFile(fixture!.adapterLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { pid: number; sessionId: string });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function releaseAdapter(pid: number): Promise<void> {
  const identity = await processIdentity(invocationFromEnvironment()!, pid);

  expect(identity?.owned).toBe(true);
  expect(identity?.ppid).toBe(fixture!.supervisor.pid);
  process.kill(pid, "SIGUSR1");
}

it("D2a: supervisor restart before create effect reissues the original durable intent once", async () => {
  fixture = await startProductionFaultFixture();
  await bindingAudit();
  const held = fixture.proxy.arm(
    { caseId: "D2a-create", method: "POST", path: /^\/sessions$/ },
    "hold-request",
  );
  const runId = await fixture.launchFlow();
  const reached = await held.awaitReached();
  const [before] = await commands(runId, "session.create");

  expect(before!.id).toBe(reached.commandId);
  expect(before!.create_intent?.requestSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (await fetch(`${fixture.supervisor.url}/commands/${reached.commandId}`))
      .status,
  ).toBe(404);
  const boot = (await (
    await fetch(`${fixture.supervisor.url}/health`)
  ).json()) as { host: { hostKey: string; bootId: string } };

  await fixture.restartSupervisor();
  held.cut();
  const sessionId = await assertOneBinding(runId);
  const [after] = await commands(runId, "session.create");

  expect(after!.create_intent).toEqual(before!.create_intent);
  expect(after!.id).toBe(before!.id);
  expect(await commands(runId, "session.create")).toHaveLength(1);
  // `traffic` records the REQUEST witness and the response is a separate copy,
  // so a `status === null` clause here would match every entry and prove
  // nothing. Count the creates that reached the host instead.
  expect(
    fixture.proxy.traffic.filter(
      (row) => row.method === "POST" && row.path === "/sessions",
    ),
  ).toHaveLength(2);
  const prompt = await completedPrompt(runId);

  expect(prompt.state).toBe("succeeded");
  expect(prompt.target_session_id).toBe(sessionId);
  await assertOneApply(prompt);
  expect(await adapterInvocations()).toHaveLength(1);
  const restarted = (await (
    await fetch(`${fixture.supervisor.url}/health`)
  ).json()) as { host: { hostKey: string; bootId: string } };

  expect(restarted.host.hostKey).toBe(boot.host.hostKey);
  expect(restarted.host.bootId).not.toBe(boot.host.bootId);
}, 240_000);

it("D2b: supervisor restart after create commit folds its receipt without another create", async () => {
  fixture = await startProductionFaultFixture();
  await bindingAudit();
  const held = fixture.proxy.arm(
    { caseId: "D2b-create-ACK", method: "POST", path: /^\/sessions$/ },
    "hold-response",
  );
  const created = fixture.proxy.arm(
    {
      caseId: "D2b-created-event",
      method: "GET",
      path: /^\/runtime-events$/,
      eventType: "session.created",
    },
    "hold-events",
  );
  const runId = await fixture.launchFlow();
  const reached = await held.awaitReached();

  expect(reached.status).toBe(201);
  await created.awaitReached();
  const [before] = await commands(runId, "session.create");
  const receiptResponse = await fetch(
    `${fixture.supervisor.url}/commands/${reached.commandId}`,
  );

  expect(receiptResponse.status).toBe(200);
  const receipt = (await receiptResponse.json()) as {
    body: { sessionId: string };
  };

  expect(
    (
      await fixture.database.pool.query(
        "SELECT * FROM s52_binding_audit WHERE run_id = $1",
        [runId],
      )
    ).rows,
  ).toEqual([]);
  const beforeBoot = (await (
    await fetch(`${fixture.supervisor.url}/health`)
  ).json()) as { host: { hostKey: string; bootId: string } };

  await fixture.restartSupervisor();
  const afterBoot = (await (
    await fetch(`${fixture.supervisor.url}/health`)
  ).json()) as { host: { hostKey: string; bootId: string } };

  expect(afterBoot.host.hostKey).toBe(beforeBoot.host.hostKey);
  expect(afterBoot.host.bootId).not.toBe(beforeBoot.host.bootId);
  held.cut();
  created.release();
  expect(await assertOneBinding(runId)).toBe(receipt.body.sessionId);
  const creates = await poll(
    async () => {
      const rows = await commands(runId, "session.create");

      return rows[0]?.state === "succeeded" ? rows : null;
    },
    60_000,
    "create receipt folded into durable command settlement",
  );

  expect(creates).toHaveLength(1);
  expect(creates[0]!.create_intent).toEqual(before!.create_intent);
  expect(creates[0]!.state).toBe("succeeded");
  // `traffic` records the REQUEST witness and the response is a separate copy,
  // so a `status === null` clause here would match every entry and prove
  // nothing. Count the creates that reached the host instead.
  expect(
    fixture.proxy.traffic.filter(
      (row) => row.method === "POST" && row.path === "/sessions",
    ),
  ).toHaveLength(1);
}, 240_000);

it("D4: web dies after durable create ACK and before first host prompt; restart sends one prompt", async () => {
  fixture = await startProductionFaultFixture();
  await bindingAudit();
  const held = fixture.proxy.arm(
    {
      caseId: "D4-first-prompt",
      method: "POST",
      path: /^\/sessions\/[^/]+\/prompts$/,
    },
    "hold-request",
  );
  const runId = await fixture.launchFlow();
  const reached = await held.awaitReached();
  const sessionId = await assertOneBinding(runId);
  const [create] = await commands(runId, "session.create");

  expect(create!.state).toBe("succeeded");
  expect(create!.create_intent).toBeTruthy();
  expect(await adapterInvocations()).toEqual([]);
  expect(
    (await fetch(`${fixture.supervisor.url}/commands/${reached.commandId}`))
      .status,
  ).toBe(404);
  await fixture.web.kill("SIGKILL");
  held.ownedProcessKilled();
  await fixture.restartWeb();
  const prompt = await completedPrompt(runId);

  expect(prompt.id).toBe(reached.commandId);
  expect(prompt.state).toBe("succeeded");
  expect(prompt.target_session_id).toBe(sessionId);
  await assertOneApply(prompt);
  expect(await commands(runId, "session.create")).toHaveLength(1);
  expect(await commands(runId, "session.prompt")).toHaveLength(1);
  expect(await assertOneBinding(runId)).toBe(sessionId);
  expect(await adapterInvocations()).toHaveLength(1);
}, 240_000);

it("L1: active scratch cancellation settles once and the same session accepts a later turn", async () => {
  fixture = await startProductionFaultFixture({
    fixtureArgs: ["--controlled-prompt"],
  });
  const launched = fixture.launchScratch();

  void launched.catch(() => undefined);
  const first = await poll(
    async () => (await adapterInvocations())[0] ?? null,
    60_000,
    "adapter owns held prompt",
  );
  const [command] = (
    await fixture.database.pool.query<Command>(
      "SELECT * FROM execution_commands WHERE kind = 'session.prompt'",
    )
  ).rows;

  expect(command!.completion_applied_at).toBeNull();
  const response = await fixture.api(
    `/api/scratch-runs/${command!.run_id}/interrupt`,
    { method: "POST" },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ cancelled: true });
  const settled = await completedPrompt(command!.run_id);

  await assertOneApply(settled);
  const receiptResponse = await fetch(
    `${fixture.supervisor.url}/commands/${settled.id}`,
  );

  expect(receiptResponse.status).toBe(200);
  const receipt = (await receiptResponse.json()) as {
    terminal: { result: { stopReason: string } };
  };

  expect(receipt.terminal.result.stopReason).toBe("cancelled");
  // The cancel already resolved the held prompt, and one ACP prompt yields
  // exactly ONE response — so this signal cannot manufacture a late SUCCESS
  // through this seam, and claiming it does would be claiming a window the
  // protocol has no room for. What it does exercise is the adjacent property:
  // a stray post-settlement adapter signal overwrites nothing already applied.
  await releaseAdapter(first.pid);

  const afterSignal = await poll(
    async () =>
      (await commands(command!.run_id, "session.prompt")).find(
        (row) => row.id === settled.id,
      ) ?? null,
    30_000,
    "settled prompt re-read after the stray adapter signal",
  );

  expect({
    state: afterSignal.state,
    applied: afterSignal.completion_applied_at,
    terminalEventId: afterSignal.terminal_event_id,
    applicationState: afterSignal.application_state,
  }).toEqual({
    state: settled.state,
    applied: settled.completion_applied_at,
    terminalEventId: settled.terminal_event_id,
    applicationState: settled.application_state,
  });
  await assertOneApply(afterSignal);
  expect(
    (
      (await (
        await fetch(`${fixture.supervisor.url}/commands/${settled.id}`)
      ).json()) as { terminal: { result: { stopReason: string } } }
    ).terminal.result.stopReason,
  ).toBe("cancelled");
  expect(await launched).toBe(command!.run_id);
  const next = fixture.api(`/api/scratch-runs/${command!.run_id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: 'fixture-output:{"bytes":0,"text":"after cancellation"}',
      attachments: [],
    }),
  });
  const second = await poll(
    async () => (await adapterInvocations())[1] ?? null,
    60_000,
    "same adapter owns next prompt",
  );

  expect(second.sessionId).toBe(first.sessionId);
  expect(second.pid).toBe(first.pid);
  await releaseAdapter(second.pid);
  expect((await next).status).toBe(202);
  const rows = await commands(command!.run_id, "session.prompt");

  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.completion_applied_at).toBeTruthy();
    await assertOneApply(row);
  }
  const messages = await fixture.database.pool.query<{ content: string }>(
    "SELECT content FROM run_messages WHERE run_id = $1 AND role = 'assistant'",
    [command!.run_id],
  );

  expect(messages.rows).toEqual([{ content: "after cancellation" }]);
}, 240_000);

it("D3: connection loss after projection claim rolls back effect and cursor; a successor projects once without a new event", async () => {
  fixture = await startProductionFaultFixture();
  const runId = await fixture.launchScratch();

  await completedPrompt(runId);
  const upload = fixture.proxy.arm(
    {
      caseId: "D3-upload",
      method: "PUT",
      path: /^\/runtime-objects\/[^/]+\/content$/,
    },
    "hold-request",
  );
  const form = new FormData();

  form.append(
    "payload",
    JSON.stringify({
      content: 'fixture-output:{"bytes":0,"text":"uploaded"}',
      attachments: [],
    }),
  );
  form.append("files", new Blob(["D3 durable object\n"]), "d3.txt");
  const request = fixture.api(`/api/scratch-runs/${runId}/messages`, {
    method: "POST",
    body: form,
  });

  void request.catch(() => undefined);
  const selected = await upload.awaitReached();
  const objectId = selected.path.split("/")[2]!;
  const ack = fixture.proxy.arm(
    {
      caseId: "D3-upload-ACK",
      method: "PUT",
      path: /^\/runtime-objects\/[^/]+\/content$/,
      objectId,
    },
    "hold-responses",
  );
  const seal = fixture.proxy.arm(
    {
      caseId: "D3-seal",
      method: "GET",
      path: /^\/runtime-events$/,
      eventType: "runtime_object.available",
      objectId,
    },
    "hold-events",
  );
  const barrier = await fixture.holdWrite({
    caseId: "B3-D3-projector",
    table: "execution_runtime_objects",
    matches: { id: objectId, state: "available" },
  });

  await fixture.database.pool
    .query(`CREATE TABLE s52_object_audit(object_id text, consumer_owner text);
    CREATE FUNCTION s52_audit_object() RETURNS trigger LANGUAGE plpgsql AS $audit$
    BEGIN IF NEW.state = 'available' AND OLD.state <> 'available' THEN
      INSERT INTO s52_object_audit SELECT NEW.id, claim_owner FROM execution_event_consumers
        WHERE run_id = '${runId}' AND consumer_name = 'canonical-runtime-object-v1';
    END IF; RETURN NEW; END $audit$;
    CREATE TRIGGER s52_audit_object AFTER UPDATE ON execution_runtime_objects FOR EACH ROW WHEN (NEW.id = '${objectId}') EXECUTE FUNCTION s52_audit_object()`);
  upload.release();
  await ack.awaitReached();
  const event = await seal.awaitReached();

  seal.release();
  const backend = await barrier.awaitReached();
  const consumer = async (): Promise<{
    claim_owner: string | null;
    last_run_sequence: string | null;
    last_error: unknown;
  }> =>
    (
      await fixture!.database.pool.query(
        "SELECT claim_owner, last_run_sequence, last_error FROM execution_event_consumers WHERE run_id=$1 AND consumer_name='canonical-runtime-object-v1'",
        [runId],
      )
    ).rows[0];
  const before = await consumer();

  expect(before.claim_owner).toBeTruthy();
  expect(before.last_run_sequence).toBeTruthy();
  expect(await barrier.terminateWriter()).toBe(backend);
  await poll(
    async () =>
      (
        await fixture!.database.pool.query(
          "SELECT pid FROM pg_stat_activity WHERE pid=$1",
          [backend],
        )
      ).rows.length === 0
        ? true
        : null,
    15_000,
    "terminated projection connection disappeared",
  );
  const rolledBack = await consumer();

  expect(rolledBack.last_run_sequence).toBe(before.last_run_sequence);
  // `before` is read with the writer ALREADY blocked, so equality alone would
  // also hold for a projector that had committed this cursor in an earlier
  // transaction. Anchor it to the sealed event instead: a cursor that rolled
  // back must still sit BELOW the sequence whose projection was torn down.
  expect(event.sequence).toBeTruthy();
  expect(Number(rolledBack.last_run_sequence)).toBeLessThan(
    Number(event.sequence),
  );
  expect(
    (
      await fixture.database.pool.query(
        "SELECT state FROM execution_runtime_objects WHERE id=$1",
        [objectId],
      )
    ).rows,
  ).toEqual([{ state: "pending" }]);
  expect(
    (await fixture.database.pool.query("SELECT * FROM s52_object_audit")).rows,
  ).toEqual([]);
  await barrier.release();
  const applied = await poll(
    async () => {
      const rows = (
        await fixture!.database.pool.query<{
          object_id: string;
          consumer_owner: string;
        }>("SELECT * FROM s52_object_audit")
      ).rows;

      return rows.length ? rows : null;
    },
    90_000,
    "successor projection application without new event",
  );

  expect(applied).toHaveLength(1);
  expect(applied[0]!.object_id).toBe(objectId);
  expect(applied[0]!.consumer_owner).toBeTruthy();
  expect(applied[0]!.consumer_owner).not.toBe(before.claim_owner);
  const after = await consumer();

  expect(BigInt(after.last_run_sequence!)).toBeGreaterThan(
    BigInt(before.last_run_sequence!),
  );
  const canonical = await fixture.database.pool.query<{ count: string }>(
    "SELECT count(*) FROM execution_events WHERE run_id=$1 AND event_type='runtime_object.available' AND payload->>'objectId'=$2",
    [runId, objectId],
  );

  expect(canonical.rows[0]!.count).toBe("1");
  expect(event.sequence).toBeTruthy();
  expect(await fixture.web.logTail(4 * 1024 * 1024)).toMatch(
    /projection.*(failed|failure|unavailable)|terminated|connection.*closed/i,
  );
  ack.release();
  expect((await request).status).toBe(202);
  expect(
    (await fixture.database.pool.query("SELECT * FROM s52_object_audit")).rows,
  ).toHaveLength(1);
}, 240_000);

it("D1: supervisor death during NeedsInput preserves the 503 response intent and resumes through checkpoint idle", async () => {
  const journal = await mkdtempReal("s52-permission-journal-");

  fixture = await startProductionFaultFixture({
    fixture: "mock-acp-adapter-resumable.mjs",
    fixtureEnv: {
      MOCK_ACP_REQUEST_PERMISSION: "1",
      MOCK_ACP_STATE_DIR: journal,
    },
  });
  const runId = await fixture.launchFlow();
  const pending = await poll(
    async () => {
      const rows = await fixture!.database.pool.query<{
        id: string;
        status: string;
        acp_session_id: string;
      }>(
        "SELECT h.id, r.status, s.acp_session_id FROM hitl_requests h JOIN runs r ON r.id=h.run_id JOIN run_sessions s ON s.run_id=r.id WHERE r.id=$1 AND h.kind='permission' AND h.responded_at IS NULL",
        [runId],
      );

      return rows.rows[0]?.status === "NeedsInput" ? rows.rows[0] : null;
    },
    60_000,
    "production permission request and NeedsInput",
  );

  expect(pending.acp_session_id).toBeTruthy();
  const checkpoint = fixture.proxy.arm(
    {
      caseId: "D1-checkpoint",
      method: "POST",
      path: /^\/sessions\/[^/]+\/checkpoint$/,
    },
    "hold-request",
  );

  await fixture.supervisor.kill("SIGKILL");
  const respond = (): Promise<Response> =>
    fixture!.api(`/api/runs/${runId}/hitl/${pending.id}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: "allow" }),
    });
  const unavailable = await respond();

  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({
    code: "EXECUTOR_UNAVAILABLE",
  });
  const intent = await fixture.database.pool.query<{
    response: { optionId: string };
    responded_at: Date | null;
  }>("SELECT response, responded_at FROM hitl_requests WHERE id=$1", [
    pending.id,
  ]);

  expect(intent.rows[0]).toMatchObject({
    response: { optionId: "allow" },
    responded_at: null,
  });
  await fixture.database.pool.query(
    "UPDATE runs SET keepalive_until = clock_timestamp() - interval '1 second' WHERE id=$1",
    [runId],
  );
  const unavailableSweep = fixture.requestSweep();

  void unavailableSweep.catch(() => undefined);
  await checkpoint.awaitReached();
  checkpoint.release();
  await poll(
    async () =>
      (await fixture!.web.logTail(4 * 1024 * 1024)).includes(
        "sweeper pass1 supervisor 5xx",
      )
        ? true
        : null,
    60_000,
    "unavailable checkpoint is explicitly retriable",
  );
  expect(
    (
      await fixture.database.pool.query("SELECT status FROM runs WHERE id=$1", [
        runId,
      ])
    ).rows,
  ).toEqual([{ status: "NeedsInput" }]);
  expect([200, 207]).toContain((await unavailableSweep).status);
  await fixture.restartSupervisor();
  const restartedSweep = fixture.requestSweep();

  void restartedSweep.catch(() => undefined);
  const idle = await poll(
    async () => {
      const result = await fixture!.database.pool.query<{
        status: string;
        checkpoint_at: Date | null;
      }>("SELECT status, checkpoint_at FROM runs WHERE id=$1", [runId]);

      return result.rows[0]?.status === "NeedsInputIdle"
        ? result.rows[0]
        : null;
    },
    90_000,
    "missing-session checkpoint reaches resumable idle",
  );

  expect(idle.checkpoint_at).toBeTruthy();
  expect([200, 207]).toContain((await restartedSweep).status);
  expect(
    (
      await fixture.database.pool.query(
        "SELECT epoch, state FROM execution_assignments WHERE run_id=$1",
        [runId],
      )
    ).rows,
  ).toEqual([{ epoch: 1, state: "released" }]);
  const delivery = await fixture.database.pool.query<{ command_id: string }>(
    "SELECT response->'_delivery'->>'commandId' AS command_id FROM hitl_requests WHERE id=$1",
    [pending.id],
  );
  const missingInput = delivery.rows[0]!.command_id;
  const receiptPartition = fixture.proxy.arm(
    {
      caseId: "D1-input-receipt-unavailable",
      method: "GET",
      path: /^\/commands\/[^/]+$/,
      commandId: missingInput,
    },
    "block-receipts",
  );
  const refused = respond();

  await receiptPartition.awaitReached();
  expect((await refused).status).toBe(503);
  expect(
    (
      await fixture.database.pool.query(
        "SELECT epoch, state FROM execution_assignments WHERE run_id=$1",
        [runId],
      )
    ).rows,
  ).toEqual([{ epoch: 1, state: "released" }]);
  receiptPartition.release();
  const missingReceipt = fixture.proxy.arm(
    {
      caseId: "D1-input-generation-race",
      method: "GET",
      path: /^\/commands\/[^/]+$/,
      commandId: missingInput,
    },
    "hold-response",
  );
  const staleResume = respond();
  const missingWitness = await missingReceipt.awaitReached();

  expect(missingWitness.status).toBe(404);
  const inputBeforeRace = await fixture.database.pool.query<{
    attempts: number;
  }>("SELECT attempts FROM execution_commands WHERE id=$1", [missingInput]);

  await fixture.database.pool.query(
    "UPDATE execution_commands SET attempts=attempts+1 WHERE id=$1",
    [missingInput],
  );
  missingReceipt.release();
  const staleResult = await staleResume;

  expect(staleResult.status).toBe(409);
  expect(await staleResult.json()).toMatchObject({ code: "CONFLICT" });
  expect(
    (
      await fixture.database.pool.query("SELECT status FROM runs WHERE id=$1", [
        runId,
      ])
    ).rows,
  ).toEqual([{ status: "NeedsInputIdle" }]);
  expect(
    (
      await fixture.database.pool.query(
        "SELECT epoch, state FROM execution_assignments WHERE run_id=$1",
        [runId],
      )
    ).rows,
  ).toEqual([{ epoch: 1, state: "released" }]);
  await fixture.database.pool.query(
    "UPDATE execution_commands SET attempts=$2 WHERE id=$1",
    [missingInput, inputBeforeRace.rows[0]!.attempts],
  );
  const resumed = await respond();

  expect(resumed.status).toBe(202);
  const delivered = await poll(
    async () => {
      const result = await fixture!.database.pool.query<{
        response: { optionId: string; _audit: { deliveredViaResume: boolean } };
        responded_at: Date | null;
      }>("SELECT response, responded_at FROM hitl_requests WHERE id=$1", [
        pending.id,
      ]);

      return result.rows[0]?.responded_at ? result.rows[0] : null;
    },
    120_000,
    "stored permission delivered after supervisor restart",
  );

  expect(delivered.response).toMatchObject({
    optionId: "allow",
    _audit: { deliveredViaResume: true },
  });
  await poll(
    async () => {
      const row = (
        await fixture!.database.pool.query<{ status: string }>(
          "SELECT status FROM runs WHERE id=$1",
          [runId],
        )
      ).rows[0];

      return row?.status === "Review" || row?.status === "Done" ? true : null;
    },
    90_000,
    "resumed permission turn finishes",
  );
  expect(
    (
      await fixture.database.pool.query(
        "SELECT acp_session_id FROM run_sessions WHERE run_id=$1",
        [runId],
      )
    ).rows,
  ).toEqual([{ acp_session_id: pending.acp_session_id }]);
  expect(await commands(runId, "session.create")).toHaveLength(2);
  const prompts = await commands(runId, "session.prompt");

  expect(prompts).toHaveLength(2);
  const resumedPrompt = prompts.find(
    (command) => command.assignment_epoch === 2,
  )!;

  expect(resumedPrompt.state).toBe("succeeded");
  expect(resumedPrompt.application_state).toBe("applied");
  await assertOneApply(resumedPrompt);
  const historicalInput = await commands(runId, "session.input");

  expect(
    historicalInput.find((command) => command.id === missingInput)?.state,
  ).toBe("failed");
}, 300_000);
