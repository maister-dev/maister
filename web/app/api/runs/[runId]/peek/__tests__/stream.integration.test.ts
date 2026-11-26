import type { SessionUser } from "@/lib/authz";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import Ajv from "ajv";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { parse } from "yaml";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { executionEvents } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  notifyContinuationAttentionChanged,
  subscribePeekChanges,
  type PeekHint,
} from "@/lib/runs/peek-wake";
import { contextUsageOnlySql } from "@/lib/runs/stream-options";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
const readModelSpies = vi.hoisted(() => ({
  authorizePeekRun: vi.fn(),
  peekPath: vi.fn(),
}));
let database: StartedPostgresTestDb;

vi.mock("@/lib/runs/peek-read-model", async (original) => {
  const actual = await original<typeof import("@/lib/runs/peek-read-model")>();

  readModelSpies.authorizePeekRun.mockImplementation(actual.authorizePeekRun);
  readModelSpies.peekPath.mockImplementation(actual.peekPath);

  return {
    ...actual,
    authorizePeekRun: (...args: Parameters<typeof actual.authorizePeekRun>) =>
      readModelSpies.authorizePeekRun(...args),
    peekPath: (...args: Parameters<typeof actual.peekPath>) =>
      readModelSpies.peekPath(...args),
  };
});

vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  getDb: () => database.db,
  createDbNotificationClient: async () => {
    const { Client } = await import("pg");

    return new Client({ connectionString: database.databaseUrl });
  },
}));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => {
    if (!session.user) throw new MaisterError("UNAUTHENTICATED", "No session");

    return session.user;
  },
}));

let streamGet: typeof import("../stream/route").GET;
let projectId: string;
let root: string;
let child: string;

let userId: string;

async function seedRun(
  parentId: string | null,
  project = projectId,
  rootId: string | null = parentId ? root : null,
): Promise<string> {
  const id = randomUUID();

  await database.pool.query(
    `INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,parent_run_id,root_run_id,agent_workspace)
     VALUES ($1,$2,'agent','Running','v1','revision',$3,$4,'none')`,
    [id, project, parentId, rootId],
  );

  return id;
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "run_peek_wire" });
  ({ GET: streamGet } = await import("../stream/route"));
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

beforeEach(async () => {
  await database.pool.query("DELETE FROM projects");
  await database.pool.query("DELETE FROM users");
  userId = randomUUID();
  projectId = randomUUID();
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@test.invalid`],
  );
  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,main_branch,branch_prefix,maister_yaml_path,task_key) VALUES($1,$2,'Peek',$3,'main','maister/','/tmp/maister.yaml',$4)",
    [
      projectId,
      `peek-${projectId}`,
      `/tmp/peek-${projectId}`,
      `K${projectId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    ],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,user_id,project_id,role) VALUES($3,$1,$2,'member')",
    [userId, projectId, randomUUID()],
  );
  session.user = {
    id: userId,
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  };
  root = await seedRun(null);
  child = await seedRun(root);
  await seedRun(child);
});

const document = parse(
  readFileSync(
    resolve(process.cwd(), "../docs/api/async/web-runs.asyncapi.yaml"),
    "utf8",
  ),
) as { components: { schemas: Record<string, object> } };
const validateFrame = new Ajv({
  strict: false,
  validateFormats: false,
}).compile({
  components: document.components,
  oneOf: [
    "RunPeekReady",
    "RunPeekChanged",
    "RunPeekRunChanged",
    "RunPeekResync",
    "RunPeekSelectionUnavailable",
  ].map((name) => ({ $ref: `#/components/schemas/${name}` })),
});

async function frame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Record<string, unknown>> {
  const result = await reader.read();

  if (result.done) throw new Error("SSE ended before expected frame");

  const text = new TextDecoder().decode(result.value);

  expect(text).not.toMatch(/^id:/m);
  const value: Record<string, unknown> = JSON.parse(
    text.split("data: ")[1].split("\n")[0],
  );

  expect(validateFrame(value), JSON.stringify(validateFrame.errors)).toBe(true);

  return value;
}
it("IT-PKD-08 IT-PKD-09 IT-PKD-10: one framed stream isolates selected ticks, discovers descendants and releases cancellation", async () => {
  const response = await streamGet(
    new NextRequest(
      `http://localhost/api/runs/${root}/peek/stream?selected=${child}`,
    ),
    { params: Promise.resolve({ runId: root }) },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();

  try {
    expect(await frame(reader)).toEqual({
      type: "peek.ready",
      anchorRunId: root,
      selectedRunId: child,
      selectionState: "ready",
    });
    for (const runId of [root, child]) {
      await database.pool.query(
        "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','Live message')",
        [randomUUID(), runId],
      );
      expect(await frame(reader)).toEqual({
        type: "run.changed",
        runId,
        kind: "transcript",
      });
    }
    await database.pool.query("UPDATE runs SET status='Done' WHERE id=$1", [
      child,
    ]);
    const received = [await frame(reader), await frame(reader)];

    expect(received).toContainEqual({
      type: "run.changed",
      runId: child,
      kind: "summary",
    });
    expect(received).toContainEqual({ type: "peek.changed" });
    await database.db.transaction((tx) =>
      notifyContinuationAttentionChanged(tx, child),
    );
    expect(await frame(reader)).toEqual({
      type: "run.changed",
      runId: child,
      kind: "summary",
    });
    expect(await frame(reader)).toEqual({ type: "peek.changed" });
    await seedRun(child);
    expect(await frame(reader)).toEqual({ type: "peek.changed" });
    await database.pool.query("DELETE FROM project_members WHERE user_id=$1", [
      userId,
    ]);
    await database.pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
      root,
    ]);
    expect((await frame(reader)).type).toBe("peek.resync");
    expect((await reader.read()).done).toBe(true);
  } finally {
    await reader.cancel();
  }
});
it("IT-PKD-09: an unrelated selected Run is unavailable while the authorized parent stays live", async () => {
  const response = await streamGet(
    new NextRequest(
      `http://localhost/api/runs/${root}/peek/stream?selected=${randomUUID()}`,
    ),
    { params: Promise.resolve({ runId: root }) },
  );

  expect(response.status).toBe(200);
  const reader = response.body!.getReader();

  try {
    expect(await frame(reader)).toMatchObject({
      type: "peek.ready",
      selectionState: "unavailable",
    });
    await database.pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
      root,
    ]);
    const frames = [await frame(reader), await frame(reader)];

    expect(frames).toContainEqual({
      type: "run.changed",
      runId: root,
      kind: "summary",
    });
  } finally {
    await reader.cancel();
  }
});

it("IT-PKD-09 IT-PKD-10: revoking only the selected child's grant clears that channel while parent frames continue", async () => {
  const foreign = randomUUID();

  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,main_branch,branch_prefix,maister_yaml_path,task_key) VALUES($1,$2,'Other',$3,'main','maister/','/tmp/maister.yaml',$4)",
    [
      foreign,
      `peek-${foreign}`,
      `/tmp/peek-${foreign}`,
      `F${foreign.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    ],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,user_id,project_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), userId, foreign],
  );
  const selected = await seedRun(root, foreign);
  const response = await streamGet(
    new NextRequest(
      `http://localhost/api/runs/${root}/peek/stream?selected=${selected}`,
    ),
    { params: Promise.resolve({ runId: root }) },
  );
  const reader = response.body!.getReader();

  try {
    expect(await frame(reader)).toMatchObject({
      type: "peek.ready",
      selectionState: "ready",
    });
    await database.pool.query(
      "DELETE FROM project_members WHERE user_id=$1 AND project_id=$2",
      [userId, foreign],
    );
    await database.pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
      root,
    ]);
    const frames = [
      await frame(reader),
      await frame(reader),
      await frame(reader),
    ];

    expect(frames).toContainEqual({ type: "peek.selection_unavailable" });
    expect(frames).toContainEqual({
      type: "run.changed",
      runId: root,
      kind: "summary",
    });
    expect(frames).not.toContainEqual(
      expect.objectContaining({ runId: selected }),
    );
  } finally {
    await reader.cancel();
  }
});

it("IT-PKD-09: request abort and database shutdown terminate owned streams and allow a new listener", async () => {
  const aborted = new AbortController();
  const first = await streamGet(
    new NextRequest(`http://localhost/api/runs/${root}/peek/stream`, {
      signal: aborted.signal,
    }),
    { params: Promise.resolve({ runId: root }) },
  );
  const reader = first.body!.getReader();

  await frame(reader);
  aborted.abort();
  expect((await reader.read()).done).toBe(true);
  await reader.cancel();
  const second = await streamGet(
    new NextRequest(`http://localhost/api/runs/${root}/peek/stream`),
    { params: Promise.resolve({ runId: root }) },
  );
  const next = second.body!.getReader();

  await frame(next);
  const { closeDb } = await import("@/lib/db/client");

  await closeDb();
  expect(await frame(next)).toMatchObject({ type: "peek.resync" });
  expect((await next.read()).done).toBe(true);
  await next.cancel();
  const third = await streamGet(
    new NextRequest(`http://localhost/api/runs/${root}/peek/stream`),
    { params: Promise.resolve({ runId: root }) },
  );
  const fresh = third.body!.getReader();

  expect(await frame(fresh)).toMatchObject({ type: "peek.ready" });
  await fresh.cancel();
});

it("unrelated transcript, execution_events, top-level root and foreign-root hints emit 0 frames and 0 DB auth/ancestry calls", async () => {
  const otherRoot = await seedRun(null, projectId, null);
  const otherChild = await seedRun(otherRoot, projectId, otherRoot);
  const response = await streamGet(
    new NextRequest(
      `http://localhost/api/runs/${root}/peek/stream?selected=${child}`,
    ),
    { params: Promise.resolve({ runId: root }) },
  );

  expect(response.status).toBe(200);
  const reader = response.body!.getReader();

  try {
    expect(await frame(reader)).toEqual({
      type: "peek.ready",
      anchorRunId: root,
      selectedRunId: child,
      selectionState: "ready",
    });

    readModelSpies.authorizePeekRun.mockClear();
    readModelSpies.peekPath.mockClear();

    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','unrelated transcript')",
      [randomUUID(), otherRoot],
    );
    const pendingGapEventId = randomUUID();

    await database.pool.query(
      "INSERT INTO execution_events(id,source,source_key,run_id,event_type,payload_schema,payload,occurred_at,received_at,ingest_disposition) VALUES($1,'manager',$1,$2,'session.update','maister.session.update.v1','{}',now(),now(),'pending_gap')",
      [pendingGapEventId, otherRoot],
    );
    await database.pool.query(
      "INSERT INTO execution_events(id,source,source_key,run_id,run_sequence,event_type,payload_schema,payload,occurred_at,received_at,ingest_disposition) VALUES($1,'manager',$1,$2,1,'session.update','maister.session.update.v1','{}',now(),now(),'accepted')",
      [randomUUID(), otherRoot],
    );
    await database.pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
      otherRoot,
    ]);
    await database.pool.query("UPDATE runs SET status='Done' WHERE id=$1", [
      otherChild,
    ]);

    // Committed relevant transcript hint acts as a strict FIFO barrier:
    // every preceding unrelated NOTIFY has already been drained before this frame arrives.
    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','barrier message')",
      [randomUUID(), child],
    );

    expect(await frame(reader)).toEqual({
      type: "run.changed",
      runId: child,
      kind: "transcript",
    });
    expect(readModelSpies.authorizePeekRun).toHaveBeenCalledTimes(0);
    expect(readModelSpies.peekPath).toHaveBeenCalledTimes(0);
  } finally {
    await reader.cancel();
  }
});

it("peek triggers omit to_jsonb, filter pending_gap at WHEN and preserve execution_events/run_messages semantics", async () => {
  const procRows = (
    await database.pool.query<{ proname: string; def: string }>(
      `SELECT p.proname, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = ANY(ARRAY['maister_execution_events_peek_hint', 'maister_run_messages_peek_hint'])
        ORDER BY p.proname`,
    )
  ).rows;

  expect(procRows.map((row) => row.proname)).toEqual([
    "maister_execution_events_peek_hint",
    "maister_run_messages_peek_hint",
  ]);
  for (const row of procRows) {
    expect(row.def.toLowerCase()).not.toContain("to_jsonb");
  }

  const triggerRows = (
    await database.pool.query<{ tgname: string; def: string }>(
      `SELECT tgname, pg_get_triggerdef(oid) AS def
         FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname = ANY(ARRAY['execution_events_peek_hint', 'run_messages_peek_hint'])
        ORDER BY tgname`,
    )
  ).rows;

  expect(triggerRows.map((row) => row.tgname)).toEqual([
    "execution_events_peek_hint",
    "run_messages_peek_hint",
  ]);
  const executionTriggerDef = triggerRows[0].def;

  expect(executionTriggerDef).toMatch(/\bWHEN\b/i);
  expect(executionTriggerDef).toContain("ingest_disposition");
  expect(executionTriggerDef).toContain("run_sequence");
  expect(executionTriggerDef).not.toMatch(/\bDELETE\b/i);

  const hints: PeekHint[] = [];
  const release = await subscribePeekChanges(
    (hint) => {
      if (hint.runId === child) hints.push(hint);
    },
    () => {},
  );

  try {
    const eventId = randomUUID();

    // 1. pending_gap INSERT -> 0 hints (filtered at WHEN)
    await database.pool.query(
      "INSERT INTO execution_events(id,source,source_key,run_id,event_type,payload_schema,payload,occurred_at,received_at,ingest_disposition) VALUES($1,'manager',$1,$2,'session.update','maister.session.update.v1','{}',now(),now(),'pending_gap')",
      [eventId, child],
    );
    // 2. pending_gap -> accepted UPDATE -> 1 execution hint
    await database.pool.query(
      "UPDATE execution_events SET run_sequence=1,ingest_disposition='accepted' WHERE id=$1",
      [eventId],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(1));
    expect(hints[0]).toEqual({
      source: "execution_events",
      topic: "execution",
      runId: child,
      parentRunId: null,
      previousParentRunId: null,
      rootRunId: null,
    });

    // 3. Duplicate accepted UPDATE with identical (run_sequence, run_id) -> 0 hints
    await database.pool.query(
      "UPDATE execution_events SET payload='{\"noop\":true}'::jsonb WHERE id=$1",
      [eventId],
    );
    // 4. execution_events DELETE -> 0 hints
    await database.pool.query("DELETE FROM execution_events WHERE id=$1", [
      eventId,
    ]);

    // 5. run_messages INSERT -> 1 transcript hint (also acts as barrier for steps 3 & 4)
    const messageId = randomUUID();

    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','initial')",
      [messageId, child],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(2));
    expect(hints[1]).toEqual({
      source: "run_messages",
      topic: "transcript",
      runId: child,
      parentRunId: null,
      previousParentRunId: null,
      rootRunId: null,
    });

    // 6. run_messages unwatched-column UPDATE -> 0 hints
    await database.pool.query(
      "UPDATE run_messages SET projection_tool_key='tool-noop' WHERE id=$1",
      [messageId],
    );
    // 7. run_messages watched-column UPDATE -> 1 transcript hint (barrier for step 6)
    await database.pool.query(
      "UPDATE run_messages SET content='edited' WHERE id=$1",
      [messageId],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(3));
    expect(hints[2]).toEqual({
      source: "run_messages",
      topic: "transcript",
      runId: child,
      parentRunId: null,
      previousParentRunId: null,
      rootRunId: null,
    });

    // 8. run_messages DELETE -> 1 transcript hint
    await database.pool.query("DELETE FROM run_messages WHERE id=$1", [
      messageId,
    ]);
    await vi.waitFor(() => expect(hints).toHaveLength(4));
    expect(hints[3]).toEqual({
      source: "run_messages",
      topic: "transcript",
      runId: child,
      parentRunId: null,
      previousParentRunId: null,
      rootRunId: null,
    });
  } finally {
    await release();
  }
});

it("reparenting a grandchild to another root is not dropped by foreign_root_run and emits peek.changed", async () => {
  const grandchild = await seedRun(child, projectId, root);
  const otherRoot = await seedRun(null, projectId, null);
  const response = await streamGet(
    new NextRequest(
      `http://localhost/api/runs/${root}/peek/stream?selected=${child}`,
    ),
    { params: Promise.resolve({ runId: root }) },
  );

  expect(response.status).toBe(200);
  const reader = response.body!.getReader();

  try {
    expect(await frame(reader)).toEqual({
      type: "peek.ready",
      anchorRunId: root,
      selectedRunId: child,
      selectionState: "ready",
    });

    await database.pool.query(
      "UPDATE runs SET parent_run_id=$1, root_run_id=$1 WHERE id=$2",
      [otherRoot, grandchild],
    );

    // Barrier frame on child guarantees FIFO ordering if the reparent hint were dropped.
    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','reparent barrier')",
      [randomUUID(), child],
    );

    expect(await frame(reader)).toEqual({ type: "peek.changed" });
    expect(await frame(reader)).toEqual({
      type: "run.changed",
      runId: child,
      kind: "transcript",
    });
  } finally {
    await reader.cancel();
  }
});

it("same-burst node_attempts and execution_events on a non-selected descendant preserve peek.changed", async () => {
  const grandchild = await seedRun(child, projectId, root);
  const blockerRoot = await seedRun(null, projectId, null);
  const response = await streamGet(
    new NextRequest(
      `http://localhost/api/runs/${root}/peek/stream?selected=${child}`,
    ),
    { params: Promise.resolve({ runId: root }) },
  );

  expect(response.status).toBe(200);
  const reader = response.body!.getReader();

  try {
    expect(await frame(reader)).toEqual({
      type: "peek.ready",
      anchorRunId: root,
      selectedRunId: child,
      selectionState: "ready",
    });

    // Single transaction delivers all 3 NOTIFY payloads in one flush:
    // 1. node_attempts on blockerRoot (rootRunId = null) suspends drain() on belongs().
    // 2. node_attempts on grandchild queues in pending while drain() is busy.
    // 3. execution_events on grandchild queues in pending right after it;
    //    must NOT overwrite node_attempts due to missing hint.source in the pending key.
    const client = await database.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO node_attempts(id,run_id,node_id,node_type,attempt,status) VALUES($1,$2,'plan','ai_coding',1,'Running')",
        [randomUUID(), blockerRoot],
      );
      await client.query(
        "INSERT INTO node_attempts(id,run_id,node_id,node_type,attempt,status) VALUES($1,$2,'plan','ai_coding',1,'Running')",
        [randomUUID(), grandchild],
      );
      await client.query(
        "INSERT INTO execution_events(id,source,source_key,run_id,run_sequence,event_type,payload_schema,payload,occurred_at,received_at,ingest_disposition) VALUES($1,'manager',$1,$2,1,'session.update','maister.session.update.v1','{}',now(),now(),'accepted')",
        [randomUUID(), grandchild],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    // Barrier frame on child guarantees we detect a dropped peek.changed immediately.
    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','burst barrier')",
      [randomUUID(), child],
    );

    expect(await frame(reader)).toEqual({ type: "peek.changed" });
    expect(await frame(reader)).toEqual({
      type: "run.changed",
      runId: child,
      kind: "transcript",
    });
  } finally {
    await reader.cancel();
  }
});

it("governed run bypasses 2,500 ms auth coalesce on transcript hints and revokes immediately", async () => {
  await database.pool.query(
    `UPDATE runs
        SET knowledge_access = '{"schemaVersion":1,"state":"complete","generation":1,"restrictions":[]}'::jsonb
      WHERE id = $1`,
    [root],
  );
  const response = await streamGet(
    new NextRequest(
      `http://localhost/api/runs/${root}/peek/stream?selected=${child}`,
    ),
    { params: Promise.resolve({ runId: root }) },
  );

  expect(response.status).toBe(200);
  const reader = response.body!.getReader();

  try {
    expect(await frame(reader)).toEqual({
      type: "peek.ready",
      anchorRunId: root,
      selectedRunId: child,
      selectionState: "ready",
    });

    // Immediately revoke access (well inside 2,500 ms) and emit a transcript hint.
    await database.pool.query("DELETE FROM project_members WHERE user_id=$1", [
      userId,
    ]);
    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','after revoke')",
      [randomUUID(), root],
    );

    expect(await frame(reader)).toEqual({
      type: "peek.resync",
      reason: "transport",
    });
    expect((await reader.read()).done).toBe(true);
  } finally {
    await reader.cancel();
  }
});

it("burst of >128 unrelated hints from another project does not overflow pending or emit peek.resync", async () => {
  const otherProject = randomUUID();

  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,main_branch,branch_prefix,maister_yaml_path,task_key) VALUES($1,$2,'Noisy',$3,'main','maister/','/tmp/maister.yaml',$4)",
    [
      otherProject,
      `noisy-${otherProject}`,
      `/tmp/noisy-${otherProject}`,
      `N${otherProject.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    ],
  );

  const response = await streamGet(
    new NextRequest(
      `http://localhost/api/runs/${root}/peek/stream?selected=${child}`,
    ),
    { params: Promise.resolve({ runId: root }) },
  );

  expect(response.status).toBe(200);
  const reader = response.body!.getReader();

  try {
    expect(await frame(reader)).toEqual({
      type: "peek.ready",
      anchorRunId: root,
      selectedRunId: child,
      selectionState: "ready",
    });

    readModelSpies.authorizePeekRun.mockClear();
    readModelSpies.peekPath.mockClear();

    // Deliver 135 distinct top-level run hints in a single transaction flush (>128 cap).
    await database.pool.query(
      `INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,parent_run_id,root_run_id,agent_workspace)
       SELECT gen_random_uuid()::text,$1,'agent','Running','v1','revision',NULL,NULL,'none'
         FROM generate_series(1, 135)`,
      [otherProject],
    );

    // Barrier transcript hint on selected child arrives next with no spurious peek.resync.
    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','after noisy burst')",
      [randomUUID(), child],
    );

    expect(await frame(reader)).toEqual({
      type: "run.changed",
      runId: child,
      kind: "transcript",
    });
    expect(readModelSpies.authorizePeekRun).toHaveBeenCalledTimes(0);
    expect(readModelSpies.peekPath).toHaveBeenCalledTimes(0);
  } finally {
    await reader.cancel();
  }
});

it("intermediate governed run on anchor -> mid -> selected enforces immediate pre-emit disclosure revocation", async () => {
  const midProject = randomUUID();

  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,main_branch,branch_prefix,maister_yaml_path,task_key) VALUES($1,$2,'Mid',$3,'main','maister/','/tmp/maister.yaml',$4)",
    [
      midProject,
      `mid-${midProject}`,
      `/tmp/mid-${midProject}`,
      `M${midProject.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    ],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,user_id,project_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), userId, midProject],
  );

  const mid = await seedRun(root, midProject, root);
  const leaf = await seedRun(mid, projectId, root);

  await database.pool.query(
    `UPDATE runs
        SET knowledge_access = '{"schemaVersion":1,"state":"complete","generation":1,"restrictions":[]}'::jsonb
      WHERE id = $1`,
    [mid],
  );

  const response = await streamGet(
    new NextRequest(
      `http://localhost/api/runs/${root}/peek/stream?selected=${leaf}`,
    ),
    { params: Promise.resolve({ runId: root }) },
  );

  expect(response.status).toBe(200);
  const reader = response.body!.getReader();

  try {
    expect(await frame(reader)).toEqual({
      type: "peek.ready",
      anchorRunId: root,
      selectedRunId: leaf,
      selectionState: "ready",
    });

    // Revoke membership on the intermediate governed run's project well inside 2,500 ms.
    await database.pool.query(
      "DELETE FROM project_members WHERE user_id=$1 AND project_id=$2",
      [userId, midProject],
    );

    // Emit a transcript hint on ungoverned leaf (would bypass auth for 2.5s if mid weren't tracked).
    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','leaf after mid revoke')",
      [randomUUID(), leaf],
    );
    await database.pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
      root,
    ]);

    const frames = [
      await frame(reader),
      await frame(reader),
      await frame(reader),
    ];

    expect(frames[0]).toEqual({ type: "peek.selection_unavailable" });
    expect(frames).toContainEqual({
      type: "run.changed",
      runId: root,
      kind: "summary",
    });
    expect(frames).toContainEqual({ type: "peek.changed" });
    expect(frames).not.toContainEqual(expect.objectContaining({ runId: leaf }));
  } finally {
    await reader.cancel();
  }
});

it("updating run_id on execution_events and run_messages notifies both old and new runs", async () => {
  const targetRun = await seedRun(root, projectId, root);
  const watched = new Set([child, targetRun]);
  const hints: PeekHint[] = [];
  const release = await subscribePeekChanges(
    (hint) => {
      if (watched.has(hint.runId)) hints.push(hint);
    },
    () => {},
  );

  try {
    const eventId = randomUUID();

    await database.pool.query(
      "INSERT INTO execution_events(id,source,source_key,run_id,run_sequence,event_type,payload_schema,payload,occurred_at,received_at,ingest_disposition) VALUES($1,'manager',$1,$2,1,'session.update','maister.session.update.v1','{}',now(),now(),'accepted')",
      [eventId, child],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(1));
    hints.length = 0;

    await database.pool.query(
      "UPDATE execution_events SET run_id=$1 WHERE id=$2",
      [targetRun, eventId],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(2));
    expect(hints).toContainEqual({
      source: "execution_events",
      topic: "execution",
      runId: targetRun,
      parentRunId: null,
      previousParentRunId: null,
      rootRunId: null,
    });
    expect(hints).toContainEqual({
      source: "execution_events",
      topic: "execution",
      runId: child,
      parentRunId: null,
      previousParentRunId: null,
      rootRunId: null,
    });

    hints.length = 0;
    const messageId = randomUUID();

    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','movable')",
      [messageId, child],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(1));
    hints.length = 0;

    await database.pool.query("UPDATE run_messages SET run_id=$1 WHERE id=$2", [
      targetRun,
      messageId,
    ]);
    await vi.waitFor(() => expect(hints).toHaveLength(2));
    expect(hints).toContainEqual({
      source: "run_messages",
      topic: "transcript",
      runId: targetRun,
      parentRunId: null,
      previousParentRunId: null,
      rootRunId: null,
    });
    expect(hints).toContainEqual({
      source: "run_messages",
      topic: "transcript",
      runId: child,
      parentRunId: null,
      previousParentRunId: null,
      rootRunId: null,
    });
  } finally {
    await release();
  }
});

it("shared contextUsageOnly SQL predicate handles malformed JSONB and SQL NULL payloads in real Postgres with zero 22P02 errors", async () => {
  const cases: Array<{
    seq: number;
    eventType: string;
    payloadSql: string;
    expected: boolean;
  }> = [
    {
      seq: 1,
      eventType: "session.line",
      payloadSql: `'"yes"'::jsonb`,
      expected: false,
    },
    {
      seq: 2,
      eventType: "session.line",
      payloadSql: `'123'::jsonb`,
      expected: false,
    },
    {
      seq: 3,
      eventType: "session.line",
      payloadSql: `'[]'::jsonb`,
      expected: false,
    },
    {
      seq: 4,
      eventType: "session.line",
      payloadSql: `'null'::jsonb`,
      expected: false,
    },
    {
      seq: 5,
      eventType: "session.line",
      payloadSql: `NULL`,
      expected: false,
    },
    {
      seq: 6,
      eventType: "session.line",
      payloadSql: `'{"contextUsageOnly": "true"}'::jsonb`,
      expected: false,
    },
    {
      seq: 7,
      eventType: "session.line",
      payloadSql: `'{"contextUsageOnly": true}'::jsonb`,
      expected: true,
    },
    {
      seq: 8,
      eventType: "session.update",
      payloadSql: `'{"update": 123}'::jsonb`,
      expected: false,
    },
    {
      seq: 9,
      eventType: "session.update",
      payloadSql: `'{"update": {"sessionUpdate": "usage_update"}}'::jsonb`,
      expected: true,
    },
    {
      seq: 10,
      eventType: "session.update",
      payloadSql: `'{"contextType": "usage_update"}'::jsonb`,
      expected: true,
    },
    {
      seq: 11,
      eventType: "session.update",
      payloadSql: `'[]'::jsonb`,
      expected: false,
    },
    {
      seq: 12,
      eventType: "session.update",
      payloadSql: `'"yes"'::jsonb`,
      expected: false,
    },
    {
      seq: 13,
      eventType: "session.update",
      payloadSql: `'null'::jsonb`,
      expected: false,
    },
    {
      seq: 14,
      eventType: "session.update",
      payloadSql: `NULL`,
      expected: false,
    },
  ];

  for (const row of cases) {
    await database.pool.query(
      `INSERT INTO execution_events(id,source,source_key,run_id,run_sequence,event_type,payload_schema,payload,occurred_at,received_at,ingest_disposition)
       VALUES($1,'manager',$1,$2,$3,$4,'maister.test.v1',${row.payloadSql},now(),now(),'accepted')`,
      [randomUUID(), root, row.seq, row.eventType],
    );
  }

  const projected = await database.db
    .select({
      runSequence: executionEvents.runSequence,
      contextUsageOnly: contextUsageOnlySql({
        eventType: executionEvents.eventType,
        payload: executionEvents.payload,
      }),
    })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.runId, root),
        isNotNull(executionEvents.runSequence),
      ),
    )
    .orderBy(asc(executionEvents.runSequence));

  expect(projected).toEqual(
    cases.map((row) => ({
      runSequence: BigInt(row.seq),
      contextUsageOnly: row.expected,
    })),
  );
});
