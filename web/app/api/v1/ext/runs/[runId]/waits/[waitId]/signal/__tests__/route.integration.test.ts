import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";

import { dispatchDomainEvents } from "@/lib/domain-events/dispatch";
import { waitResolverConsumer } from "@/lib/domain-events/wait-resolver";
import { issueLibrarianTurnToken } from "@/lib/librarian/authority";
import { issueToken } from "@/lib/tokens/issue";
import { generateToken } from "@/lib/tokens/secret";
import { fakeGraphHosts } from "@/test-support/fake-execution-host";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  seedActiveUser,
  seedLibrarianTurn,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: vi.fn(),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "ext_wait_signal" });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("W08 records an exact grant once, rejects changed replay, and denies revoked replay", async () => {
  const { POST } = await import("../route");
  const { runFlow } = await import("@/lib/flows/runner");
  const { runId, runtimeRoot, worktreePath, projectId } = await seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "Signal wait",
      compat: { engine_min: "3.14.0" },
      nodes: [
        {
          type: "wait",
          id: "verification",
          timeout: 120,
          on: {
            kind: "signal",
            name: "build",
            outcomes: ["success", "failure"],
            payload_schema: {
              type: "object",
              required: ["tests"],
              properties: { tests: { type: "integer" } },
            },
          },
          transitions: {
            success: "done",
            failure: "done",
            timeout: "done",
            cancelled: "done",
          },
        },
      ],
    },
  );

  onTestFinished(async () => {
    await Promise.all(
      [runtimeRoot, worktreePath].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });

  const { hosts } = await fakeGraphHosts(database.db, runId);

  await runFlow(runId, { db: database.db, runtimeRoot, executionHosts: hosts });

  const {
    rows: [wait],
  } = await database.pool.query<{ id: string }>(
    "SELECT id FROM run_waits WHERE run_id=$1",
    [runId],
  );
  const issue = async (scopes: string[], ownerProjectId = projectId) => {
    const { secret, prefix, hash } = generateToken();
    const {
      rows: [issued],
    } = await database.pool.query<{ id: string }>(
      "INSERT INTO project_tokens (id,project_id,name,prefix,token_hash,scopes) VALUES (gen_random_uuid()::text,$1,'signal test',$2,$3,$4) RETURNING id",
      [ownerProjectId, prefix, hash, JSON.stringify(scopes)],
    );

    return { token: secret, id: issued.id };
  };
  const allowed = await issue(["waits:signal"]);
  const wildcard = await issue(["*"]);
  const sendRaw = (
    token: string,
    body: string,
    key = "build-123",
    targetRunId = runId,
  ) =>
    POST(
      new Request(
        `http://localhost/api/v1/ext/runs/${targetRunId}/waits/${wait.id}/signal`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body,
        },
      ),
      { params: Promise.resolve({ runId: targetRunId, waitId: wait.id }) },
    );
  const send = (token: string, body: unknown, key?: string) =>
    sendRaw(token, JSON.stringify(body), key);
  const payload = { name: "build", outcome: "success", payload: { tests: 42 } };

  expect((await send(wildcard.token, payload)).status).toBe(403);
  const foreignProjectId = randomUUID();
  const agentId = `fixture:${randomUUID()}`;

  await database.pool.query(
    `INSERT INTO projects (id,slug,name,repo_path,maister_yaml_path,task_key)
    VALUES ($1,$2,'Foreign fixture',$3,$4,$5)`,
    [
      foreignProjectId,
      `foreign-${foreignProjectId}`,
      `/tmp/${foreignProjectId}`,
      `/tmp/${foreignProjectId}/maister.yaml`,
      `F${foreignProjectId.slice(0, 6).toUpperCase()}`,
    ],
  );
  const foreign = await issue(["waits:signal"], foreignProjectId);

  expect((await send(foreign.token, payload)).status).toBe(404);
  await database.pool.query(
    `INSERT INTO agents (id,package_name,version_label,origin,name,description,
    workspace,mode,triggers,risk_tier,source_path)
    VALUES ($1,'fixture','v1','git',$1,'Fixture','none','session','["manual"]','read_only','/tmp/fixture.md')`,
    [agentId],
  );
  const agent = await issue(["waits:signal"]);

  await database.pool.query(
    "UPDATE project_tokens SET token_kind='agent',agent_id=$1 WHERE id=$2",
    [agentId, agent.id],
  );
  expect((await send(agent.token, payload)).status).toBe(403);
  const ownerUserId = await seedActiveUser(database.db);
  const personal = await issueToken(
    {
      projectId: null,
      ownerUserId,
      tokenKind: "user",
      name: "personal signal fixture",
      scopes: ["waits:signal"],
    },
    database.db,
  );
  const turnId = await seedLibrarianTurn(database.db, ownerUserId);
  const librarian = await issueLibrarianTurnToken(
    {
      ownerUserId,
      turnId,
      scopes: ["waits:signal"],
      expiresAt: new Date(Date.now() + 60_000),
    },
    database.db,
  );

  expect((await send(personal.secret, payload)).status).toBe(403);
  const librarianResponse = await send(librarian.secret, payload);

  expect(librarianResponse.status).toBe(403);
  expect(await librarianResponse.json()).toMatchObject({
    details: { reason: "librarian_not_admitted" },
  });
  expect((await sendRaw(allowed.token, "{invalid")).status).toBe(400);
  expect((await send(allowed.token, payload, " ")).status).toBe(422);
  expect(
    (await sendRaw(allowed.token, JSON.stringify(payload).padEnd(32_769, " ")))
      .status,
  ).toBe(413);
  expect(
    (
      await sendRaw(
        allowed.token,
        JSON.stringify(payload),
        "wrong-route",
        "missing-run",
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await send(
        allowed.token,
        { ...payload, payload: { tests: "42" } },
        "invalid-build",
      )
    ).status,
  ).toBe(422);
  expect((await send(allowed.token, payload, "invalid-build")).status).toBe(
    409,
  );

  const first = await sendRaw(
    allowed.token,
    JSON.stringify(payload).padEnd(32_768, " "),
  );

  expect(first.status).toBe(202);
  const receipt = await first.json();

  expect(receipt).toEqual({
    receiptId: expect.any(String),
    waitId: wait.id,
    disposition: "accepted",
    application: "pending",
  });
  expect(
    (await send(allowed.token, { ...payload, outcome: "failure" })).status,
  ).toBe(409);

  expect(
    (
      await dispatchDomainEvents({
        db: database.db,
        consumers: [waitResolverConsumer],
      })
    ).failures,
  ).toBe(0);
  const duplicate = await send(allowed.token, payload);

  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toEqual({
    ...receipt,
    disposition: "duplicate",
    application: "applied",
  });

  await database.pool.query(
    "UPDATE project_tokens SET revoked_at=clock_timestamp() WHERE id=$1",
    [allowed.id],
  );
  expect((await send(allowed.token, payload)).status).toBe(401);
});
