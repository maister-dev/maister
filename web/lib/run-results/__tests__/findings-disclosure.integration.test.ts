import type { EvidenceFindingsV1 } from "@/lib/run-results/findings-types";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { OpenAiCompatibleClient } from "@/lib/brain/openai-compatible";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { recordNativeRunSources } from "@/lib/brain/knowledge-execution-access";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import { buildAgentProfileContract } from "@/lib/run-results/contract";
import { issueToken, issueUserAccessToken } from "@/lib/tokens/issue";
import { domainEvents, executionEvents } from "@/lib/db/schema";
import { harvestEvents } from "@/lib/domain-events/memory-harvest";
import { seedNativeFindingsExecution } from "@/test-support/native-findings-seed";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let sessionUserId: string | null = null;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
// Only the session's authenticated identity is injected; current account, project and source grants remain real DB policy.
vi.mock("@/auth", () => ({
  auth: async () =>
    sessionUserId === null ? null : { user: { id: sessionUserId } },
}));

const contract = buildAgentProfileContract({
  profileName: "findings",
  flowRefId: "native-disclosure",
  resolvedRevision: "a".repeat(40),
  sourceFlowRevisionId: "pinned-findings",
  schemaStem: "findings.v1",
  nativeContract: "evidence_findings_v1",
  schemaVersion: 1,
  schema: { schemaVersion: 1, fields: [] },
  sha256: "b".repeat(64),
});

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "native_findings_disclosure",
  });
}, 180000);
afterEach(() => {
  sessionUserId = null;
});
afterAll(async () => {
  await database?.stop();
});

it("IT-CBE-06 actual native completion cannot enter the legacy automatic Brain distiller", async () => {
  const source = await completedRun();

  await database.pool.query(
    "UPDATE projects SET brain_enabled=true WHERE id=$1",
    [source.projectId],
  );
  const [event] = await database.db
    .select()
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.runId, source.runId),
        eq(domainEvents.kind, "run.done"),
      ),
    );

  if (!event)
    throw new Error(
      "The native finalizer did not retain its actual completion event",
    );
  const resolveClient = vi.fn(async (): Promise<OpenAiCompatibleClient> => {
    throw new Error(
      "Native source-controlled work reached the legacy distiller",
    );
  });

  await expect(
    harvestEvents([event], { db: database.db, resolveClient }),
  ).resolves.toBeUndefined();
  expect(resolveClient).not.toHaveBeenCalled();
  expect(
    (
      await database.pool.query(
        "SELECT id FROM brain_items WHERE project_id=$1",
        [source.projectId],
      )
    ).rows,
  ).toEqual([]);
});

it.each(["run summary", "readiness", "activity", "hitl"] as const)(
  "IT-CBE-06 external %s requires the receiving token's current source authority",
  async (kind) => {
    const source = await completedRun();
    const userId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [userId, `${userId}@example.test`],
    );
    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
      [randomUUID(), source.projectId, userId],
    );
    const token = await issueUserAccessToken(
      {
        ownerUserId: userId,
        name: "Native source reader",
        scopes: ["runs:read", "readiness:read", "knowledge:read", "hitl:read"],
      },
      database.db,
    );
    const read = async (secret: string = token.secret): Promise<Response> => {
      const request = new NextRequest(
        `http://localhost/api/v1/ext/runs/${source.runId}${kind === "run summary" ? "" : `/${kind}`}`,
        { headers: { Authorization: `Bearer ${secret}` } },
      );
      const params = { params: Promise.resolve({ runId: source.runId }) };

      if (kind === "run summary")
        return (await import("@/app/api/v1/ext/runs/[runId]/route")).GET(
          request,
          params,
        );
      if (kind === "readiness")
        return (
          await import("@/app/api/v1/ext/runs/[runId]/readiness/route")
        ).GET(request, params);

      if (kind === "hitl")
        return (await import("@/app/api/v1/ext/runs/[runId]/hitl/route")).GET(
          request,
          params,
        );

      return (await import("@/app/api/v1/ext/runs/[runId]/activity/route")).GET(
        request,
        params,
      );
    };
    const refused = await read();

    expect(refused.status).toBe(409);
    expect(await refused.text()).not.toContain(source.witness.id);
    await createCompanyGrants(database.db, source.submitterId, {
      principalKind: "user",
      principalId: userId,
      actions: ["knowledge:read"],
      idempotencyKey: `external-source-reader:${source.runId}`,
    });
    expect((await read()).status).toBe(200);
    const constrained = await issueToken(
      {
        projectId: source.projectId,
        tokenKind: "user",
        ownerUserId: userId,
        name: "Project-only read authority",
        scopes: ["runs:read", "readiness:read", "knowledge:read", "hitl:read"],
      },
      database.db,
    );

    expect((await read(constrained.secret)).status).toBe(409);
  },
);

it("IT-CBE-06 result DTO assembly rechecks a grant revoked after initial admission", async () => {
  const source = await completedRun();
  let firstAdmission = true;
  const racedDb = {
    select: database.db.select.bind(database.db),
    async transaction<T>(
      action: (tx: SqlTransaction) => Promise<T>,
    ): Promise<T> {
      const result = await database.db.transaction(action);

      if (firstAdmission) {
        firstAdmission = false;
        const grant = (
          await database.pool.query<{ id: string; revision: number }>(
            "SELECT id,revision FROM company_grants WHERE principal_type='user' AND principal_id=$1 AND action='knowledge:read' AND revoked_at IS NULL",
            [source.submitterId],
          )
        ).rows[0]!;

        await revokeCompanyGrant(database.db, source.submitterId, grant.id, {
          expectedRevision: grant.revision,
          reason:
            "Revoke after initial DTO admission and before delayed projection reads.",
          idempotencyKey: `dto-assembly-revoke:${grant.id}`,
        });
      }

      return result;
    },
  };
  const { loadRunPublicResult } = await import("@/lib/runs/run-result-dto");

  await expect(
    loadRunPublicResult(racedDb, source.runId, {
      kind: "user",
      userId: source.submitterId,
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
});

it.each(["task", "comment"] as const)(
  "IT-CBE-06 native source-derived %s cannot be laundered into an unclassified project store",
  async (kind) => {
    const source = await seedNativeFindingsExecution(database, contract);
    const record = await getKnowledgeRecord(
      database.db,
      { kind: "token", tokenId: source.tokenId },
      { recordId: source.recordId },
    );
    const privateText = record.assertion;
    const project = (
      await database.pool.query<{ slug: string }>(
        "SELECT slug FROM projects WHERE id=$1",
        [source.projectId],
      )
    ).rows[0]!;
    const taskId = randomUUID();

    await database.pool.query(
      "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES($1,$2,1,'Assignment input','Perform bounded diagnosis.')",
      [taskId, source.projectId],
    );
    const request = new NextRequest(
      `http://localhost/api/v1/ext/projects/${project.slug}/tasks${kind === "comment" ? `/${taskId}/comments` : ""}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${source.tokenSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          kind === "comment"
            ? { body: privateText }
            : { title: "Source-derived task", prompt: privateText },
        ),
      },
    );
    const response =
      kind === "comment"
        ? await (
            await import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/comments/route")
          ).POST(request, {
            params: Promise.resolve({ slug: project.slug, taskId }),
          })
        : await (
            await import("@/app/api/v1/ext/projects/[slug]/tasks/route")
          ).POST(request, { params: Promise.resolve({ slug: project.slug }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "PRECONDITION",
      details: { reason: "native_unclassified_sink" },
    });
    expect(
      (
        await database.pool.query(
          "SELECT id FROM tasks WHERE project_id=$1 AND prompt=$2",
          [source.projectId, privateText],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await database.pool.query(
          "SELECT id FROM task_comments WHERE task_id=$1",
          [taskId],
        )
      ).rows,
    ).toEqual([]);
  },
);

async function completedRun(): Promise<
  Awaited<ReturnType<typeof seedNativeFindingsExecution>>
> {
  const source = await seedNativeFindingsExecution(database, contract);

  await recordNativeRunSources(database.db, source.runId, [
    { kind: "project_context", projectId: source.projectId },
  ]);
  const value: EvidenceFindingsV1 = {
    schemaVersion: 1,
    findings: [
      {
        id: "health",
        assertion:
          "The source reported a healthy observation, with current applicability unknown.",
        basis: "observed",
        supporting: [{ kind: "witness", id: source.witness.id }],
        contradicting: [],
        missingEvidence: [],
        limitations: [],
        openQuestions: [],
        sourceFindings: [],
      },
    ],
    knowledgeProposals: [],
    selection: [],
  };
  const { finalizeAgentRun } = await import("@/lib/agents/launch");

  expect(
    await finalizeAgentRun(source.runId, "Done", {
      db: database.db,
      finalOutput: { kind: "value", value },
    }),
  ).toMatchObject({ finalized: true, status: "Done" });

  return source;
}

async function artifactRead(
  kind: "list" | "payload",
  runId: string,
  artifactId: string,
): Promise<Response> {
  if (kind === "list")
    return (await import("@/app/api/runs/[runId]/artifacts/route")).GET(
      new Request(`http://localhost/api/runs/${runId}/artifacts`),
      { params: Promise.resolve({ runId }) },
    );

  return (
    await import("@/app/api/runs/[runId]/artifacts/[artifactId]/payload/route")
  ).GET(
    new Request(
      `http://localhost/api/runs/${runId}/artifacts/${artifactId}/payload`,
    ),
    { params: Promise.resolve({ runId, artifactId }) },
  );
}

it.each(["list", "payload"] as const)(
  "IT-CBE-06 actual artifact %s withholds source-controlled content and rechecks current user grants",
  async (kind) => {
    const source = await completedRun();
    const privateText = `Source-controlled artifact ${randomUUID()}`;
    const artifactId = randomUUID();

    await database.pool.query(
      "INSERT INTO artifact_instances(id,run_id,artifact_def_id,kind,producer,locator,validity,uri) VALUES($1,$2,'source-output','log','runner',$3::jsonb,'current',$4)",
      [
        artifactId,
        source.runId,
        JSON.stringify({ kind: "inline", text: privateText }),
        privateText,
      ],
    );
    const userId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [userId, `${userId}@example.test`],
    );
    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
      [randomUUID(), source.projectId, userId],
    );
    sessionUserId = userId;
    const refused = await artifactRead(kind, source.runId, artifactId);

    expect(refused.status).toBe(409);
    expect(await refused.text()).not.toContain(privateText);
    await createCompanyGrants(database.db, source.submitterId, {
      principalKind: "user",
      principalId: userId,
      actions: ["knowledge:read"],
      idempotencyKey: `artifact-reader:${source.runId}`,
    });
    const accepted = await artifactRead(kind, source.runId, artifactId);

    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain(privateText);
    const grant = (
      await database.pool.query<{ id: string; revision: number }>(
        "SELECT id,revision FROM company_grants WHERE principal_type='user' AND principal_id=$1 AND action='knowledge:read' AND revoked_at IS NULL",
        [userId],
      )
    ).rows[0]!;

    await revokeCompanyGrant(database.db, source.submitterId, grant.id, {
      expectedRevision: grant.revision,
      reason: "Recheck source access before artifact disclosure.",
      idempotencyKey: `artifact-revoke:${grant.id}`,
    });
    const revoked = await artifactRead(kind, source.runId, artifactId);

    expect(revoked.status).toBe(409);
    expect(await revoked.text()).not.toContain(privateText);
  },
);

it.each([
  "transcript",
  "paged transcript",
  "event stream",
  "inbox context",
] as const)(
  "IT-CBE-06 actual %s requires current source authority in addition to project membership",
  async (kind) => {
    const source = await completedRun();
    const privateText = `Private diagnostic finding ${randomUUID()}`;

    await database.db.insert(executionEvents).values({
      id: randomUUID(),
      source: "manager",
      sourceKey: `native-disclosure:${source.runId}`,
      runId: source.runId,
      eventType: "session.update",
      payloadSchema: "maister.session.update.v1",
      payload: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: privateText },
        },
      },
      occurredAt: new Date(),
      receivedAt: new Date(),
      runSequence: 1n,
      ingestDisposition: "accepted",
    });
    const userId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [userId, `${userId}@example.test`],
    );
    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
      [randomUUID(), source.projectId, userId],
    );
    sessionUserId = userId;
    const read = async (): Promise<Response> => {
      const request = new NextRequest(
        `http://localhost/api/runs/${source.runId}/${kind === "inbox context" ? "inbox-context" : kind === "event stream" ? "stream?replay=1" : kind === "paged transcript" ? "transcript?limit=10" : "transcript"}`,
      );
      const params = { params: Promise.resolve({ runId: source.runId }) };

      if (kind === "inbox context")
        return (await import("@/app/api/runs/[runId]/inbox-context/route")).GET(
          request,
          params,
        );

      return kind === "event stream"
        ? (await import("@/app/api/runs/[runId]/stream/route")).GET(
            request,
            params,
          )
        : (await import("@/app/api/runs/[runId]/transcript/route")).GET(
            request,
            params,
          );
    };
    const refused = await read();

    expect(refused.status).toBe(409);
    expect(await refused.text()).not.toContain(privateText);
    await createCompanyGrants(database.db, source.submitterId, {
      principalKind: "user",
      principalId: userId,
      actions: ["knowledge:read"],
      idempotencyKey: `transcript-reader:${source.runId}`,
    });
    const accepted = await read();

    expect(accepted.status).toBe(200);
    if (kind === "event stream") {
      const reader = accepted.body!.getReader();
      const chunk = await reader.read();

      expect(new TextDecoder().decode(chunk.value)).toContain(
        '"runSequence":"1"',
      );
      expect(new TextDecoder().decode(chunk.value)).not.toContain(privateText);
      await reader.cancel();
    } else expect(await accepted.text()).toContain(privateText);
  },
);

it.each(["grant revocation", "project deletion"] as const)(
  "IT-CBE-06 protected streaming stops before another chunk after %s and releases its upstream",
  async (change) => {
    const source = await completedRun();
    const { protectRunKnowledgeStream } =
      await import("@/lib/brain/knowledge-run-disclosure");
    let upstream: ReadableStreamDefaultController<Uint8Array> | null = null;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
      },
      cancel() {
        cancelled = true;
      },
    });
    const guarded = await protectRunKnowledgeStream(
      database.db,
      { kind: "user", userId: source.submitterId },
      source.runId,
      body,
    );
    const reader = guarded.getReader();
    const encoder = new TextEncoder();
    const first = reader.read();

    if (upstream === null)
      throw new Error("The real stream did not initialize its controller");
    const controller: ReadableStreamDefaultController<Uint8Array> = upstream;

    controller.enqueue(encoder.encode("Authorized first chunk."));
    expect(new TextDecoder().decode((await first).value)).toBe(
      "Authorized first chunk.",
    );
    if (change === "grant revocation") {
      const grant = (
        await database.pool.query<{ id: string; revision: number }>(
          "SELECT id,revision FROM company_grants WHERE principal_type='user' AND principal_id=$1 AND action='knowledge:read' AND revoked_at IS NULL",
          [source.submitterId],
        )
      ).rows[0]!;

      await revokeCompanyGrant(database.db, source.submitterId, grant.id, {
        expectedRevision: grant.revision,
        reason: "Revoke between streamed source chunks.",
        idempotencyKey: `stream-revoke:${grant.id}`,
      });
    } else {
      await database.pool.query("DELETE FROM projects WHERE id=$1", [
        source.projectId,
      ]);
      expect(
        (
          await database.pool.query("SELECT id FROM brain_items WHERE id=$1", [
            source.recordId,
          ])
        ).rows,
      ).toEqual([{ id: source.recordId }]);
    }
    const next = reader.read();

    controller.enqueue(encoder.encode("This chunk must be withheld."));
    await expect(next).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(cancelled).toBe(true);
    reader.releaseLock();
  },
);
