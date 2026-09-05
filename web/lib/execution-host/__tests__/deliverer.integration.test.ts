// ADR-166 T3.3 — the bound client through the REAL wire (D1–D2): a real
// supervisor child with the fake ACP adapter, real git worktree adoption.

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { listCommandsForRun } from "@/lib/execution-host/commands";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { publishRuntimeObject } from "@/lib/execution-host/runtime-objects";
import { scratchUploadLogicalName } from "@/lib/scratch-runs/attachments";
import {
  seedProjectRow,
  seedRun,
  seedWorkspace,
} from "@/test-support/execution-host-seed";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let sup: RealSupervisor;
let restoreUrl: () => void = () => {};
let hosts: ExecutionHosts;
let project: { id: string; slug: string; repoPath: string };
let hostId: string;

const CREATE_PAYLOAD = {
  stepId: "s1",
  executor: { agent: "claude" as const, model: "mock" },
};

async function seedFlowRun(name: string, status = "Running") {
  const runId = await seedRun(testDatabase.db, {
    projectId: project.id,
    status,
  });
  const worktreePath = await addWorktree(
    project.repoPath,
    `${sup.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );

  await seedWorkspace(testDatabase.db, {
    runId,
    projectId: project.id,
    worktreePath,
    parentRepoPath: project.repoPath,
  });

  return runId;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_deliverer_test",
  });
  db = testDatabase.db as unknown as Db;
  // `--hang` keeps the adapter alive after its prompt turn so cancel /
  // checkpoint / delete land on a LIVE session.
  sup = await startRealSupervisor({ fixtureArgs: ["--hang"] });
  restoreUrl = useRealSupervisorUrl(sup.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  project = await seedProjectRow(testDatabase.db, {
    repoPath: await initRepo(`${sup.runtimeRoot}/repo`),
  });
  hosts = createExecutionHosts({ db });
}, 180_000);

afterAll(async () => {
  restoreUrl();
  await sup?.kill();
  await testDatabase?.stop();
});

describe("bound client over the real wire", () => {
  it("D1: create / prompt / input / cancel / checkpoint / delete through the real supervisor", async () => {
    const runId = await seedFlowRun("d1");
    const client = await hosts.forRun(runId, { reason: "launch" });

    hostId = client.host.id;

    const created = await client.createSession(CREATE_PAYLOAD);
    const sessions = await hosts.local().listSessions();
    const [sessionRow] = (await db
      .select()
      .from(schema.runSessions)
      .where(eq(schema.runSessions.runId, runId))) as unknown as Array<{
      hostSessionId: string | null;
      acpSessionId: string | null;
    }>;

    expect(sessions.map((s) => s.sessionId)).toContain(created.sessionId);
    expect(sessionRow.hostSessionId).toBe(created.sessionId);
    expect(sessionRow.hostSessionId).toBe(
      sessions.find((s) => s.runId === runId)?.sessionId,
    );
    expect(sessionRow.acpSessionId).toBe(created.acpSessionId);

    const handle = await client.prompt(created.hostSessionId, {
      stepId: "s1",
      prompt: "hello",
    });

    expect((await client.waitForPrompt(handle)).stopReason).toBe("end_turn");

    // Input: the lifecycle fixture never asks for a permission, so the only
    // input a live session can take is the cancel of an unknown request —
    // the supervisor answers 410 → definitive HITL_TIMEOUT (one attempt).
    await expect(
      client.deliverInput(created.hostSessionId, {
        kind: "permission",
        action: "cancel",
        requestId: randomUUID(),
        reason: "test",
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "HITL_TIMEOUT",
    );

    // The hang fixture keeps the adapter alive, so whether the host still
    // counts a live turn is its call — the ledger outcome is what is pinned.
    expect(
      typeof (await client.cancelPrompt(created.hostSessionId)).cancelled,
    ).toBe("boolean");

    const checkpoint = await client.checkpoint(created.hostSessionId);

    expect(checkpoint.sessionId).toBe(created.sessionId);
    expect(checkpoint.alreadyCheckpointed).toBe(false);

    // The checkpointed session has exited: the host either still holds its
    // record (200 → terminated) or has dropped it (404 → gone) — both are
    // successful outcomes, never failures.
    expect(["terminated", "gone"]).toContain(
      (await client.deleteSession(created.hostSessionId)).outcome,
    );

    const second = await client.createSession({
      ...CREATE_PAYLOAD,
      sessionName: "second",
    });

    expect(await client.deleteSession(second.hostSessionId)).toEqual({
      outcome: "terminated",
    });

    const rows = await listCommandsForRun(db, runId);
    const byKind = Object.fromEntries(
      rows.map((r) => [
        `${r.kind}:${r.state}`,
        rows.filter((x) => x.kind === r.kind && x.state === r.state).length,
      ]),
    );

    expect(byKind).toMatchObject({
      "workspace.adopt:succeeded": 1,
      "session.create:succeeded": 2,
      "session.prompt:succeeded": 1,
      "session.input:failed": 1,
      "session.cancel:succeeded": 1,
      "session.checkpoint:succeeded": 1,
      "session.delete:succeeded": 2,
    });
    expect(rows.every((r) => r.completedAt !== null)).toBe(true);
    expect(rows.every((r) => r.executionHostId === hostId)).toBe(true);
  }, 120_000);

  it("D2: a second epoch fences the first assignment's command on the wire → row fenced + CONFLICT", async () => {
    const runId = await seedFlowRun("d2");
    const first = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
    );
    const clientOne = await hosts.forAssignment(first);
    const createdOne = await clientOne.createSession(CREATE_PAYLOAD);

    const second = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "resume" }),
    );

    expect(second.epoch).toBe(first.epoch + 1);
    const clientTwo = await hosts.forAssignment(second);

    // Any epoch-2 command advances the host's fence for the run.
    await clientTwo.createSession({ ...CREATE_PAYLOAD, sessionName: "epoch2" });

    // clientOne still holds its `active` snapshot → passes local admission →
    // the HOST refuses the stale epoch.
    await expect(
      clientOne.checkpoint(createdOne.hostSessionId),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "CONFLICT" &&
        err.details?.reason === "assignment_fenced" &&
        err.details?.local !== true,
    );

    const fenced = (await listCommandsForRun(db, runId)).filter(
      (r) => r.kind === "session.checkpoint",
    );

    expect(fenced).toHaveLength(1);
    expect(fenced[0].state).toBe("fenced");
    expect(fenced[0].assignmentEpoch).toBe(first.epoch);
  }, 120_000);

  it("D3: runtime-object reserve, upload, and delete use the assignment-bound command ledger", async () => {
    const runId = await seedFlowRun("runtime-object");
    const client = await hosts.forRun(runId, { reason: "launch" });
    const objectId = randomUUID();
    const bytes = new TextEncoder().encode("host-owned object");
    const published = await publishRuntimeObject({
      client,
      objectId,
      kind: "generated_artifact",
      logicalName: scratchUploadLogicalName({
        scope: `message:${randomUUID()}`,
        fileName: "result with spaces.txt",
      }),
      mimeType: "text/plain",
      retentionClass: "run",
      bytes,
    });

    expect(published.metadata).toMatchObject({
      objectId,
      state: "available",
      sizeBytes: bytes.byteLength,
      sha256:
        "ffd0fa81553b1c5d3b8c49b553605b64ed2be239e167f442ea8cdc77769a8a7a",
    });

    const nextAssignment = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, {
        runId,
        hostId: client.host.id,
        reason: "resume",
      }),
    );

    expect(nextAssignment.epoch).toBe(client.assignment.epoch + 1);
    await (
      await hosts.forAssignment(nextAssignment)
    ).createSession({
      ...CREATE_PAYLOAD,
      sessionName: "runtime-object-next-epoch",
    });

    // Runtime-object cleanup is object-scoped: the original assignment may
    // delete its own immutable object after a newer run epoch is active.
    await client.deleteRuntimeObject({ objectId, generation: 1 });

    const commands = await listCommandsForRun(db, runId);

    expect(
      commands
        .filter((row) => row.kind.startsWith("runtime_object."))
        .map((row) => [row.kind, row.state]),
    ).toEqual([
      ["runtime_object.reserve", "succeeded"],
      ["runtime_object.upload", "succeeded"],
      ["runtime_object.delete", "succeeded"],
    ]);
    expect(
      commands
        .filter((row) => row.kind.startsWith("runtime_object."))
        .every((row) => row.executionAssignmentId === client.assignment.id),
    ).toBe(true);
    const catalog = await testDatabase.pool.query(
      `select state, size_bytes, sha256, deleted_at is not null as has_deleted_at
       from execution_runtime_objects
       where id = $1 and run_id = $2`,
      [objectId, runId],
    );
    const reserveCommand = commands.find(
      (row) => row.kind === "runtime_object.reserve",
    );

    expect(catalog.rows).toEqual([
      {
        state: "deleted",
        size_bytes: String(bytes.byteLength),
        sha256: published.metadata.sha256,
        has_deleted_at: true,
      },
    ]);
    expect(reserveCommand?.payload).toMatchObject({
      objectId,
      sizeBytes: bytes.byteLength,
      sha256: published.metadata.sha256,
    });
  }, 120_000);
});
