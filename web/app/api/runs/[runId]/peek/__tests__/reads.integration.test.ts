import type { TranscriptPage } from "@/lib/runs/transcript-page";
import type { SessionUser } from "@/lib/authz";
import type { RunPeekChildPage, RunPeekSnapshot } from "@/lib/runs/peek-types";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { parse } from "yaml";

import { MaisterError } from "@/lib/errors";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
let database: StartedPostgresTestDb;

vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  getDb: () => database.db,
}));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => {
    if (!session.user) throw new MaisterError("UNAUTHENTICATED", "No session");

    return session.user;
  },
}));

let childrenGet: typeof import("../../children/route").GET;
let snapshotGet: typeof import("../route").GET;
let projectId: string;
let root: string;
let child: string;
let grandchild: string;
let userId: string;

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!value || typeof value !== "object") return value;

  const record = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "nullable")
      .map(([key, item]) => [key, normalizeSchema(item)]),
  );

  return "nullable" in value && value.nullable === true
    ? { anyOf: [record, { type: "null" }] }
    : record;
}

async function seedRun(
  parentId: string | null,
  project = projectId,
): Promise<string> {
  const id = randomUUID();

  await database.pool.query(
    `INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,parent_run_id,root_run_id,agent_workspace)
     VALUES ($1,$2,'agent','Running','v1','revision',$3,$4,'none')`,
    [id, project, parentId, parentId ? root : null],
  );

  return id;
}

async function requestChildren(anchor: string, query = ""): Promise<Response> {
  return childrenGet(
    new NextRequest(`http://localhost/api/runs/${anchor}/children${query}`),
    { params: Promise.resolve({ runId: anchor }) },
  );
}

async function requestSnapshot(
  anchor: string,
  selected: string,
): Promise<Response> {
  return snapshotGet(
    new NextRequest(
      `http://localhost/api/runs/${anchor}/peek?selected=${selected}`,
    ),
    { params: Promise.resolve({ runId: anchor }) },
  );
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "run_peek_reads" });
  ({ GET: childrenGet } = await import("../../children/route"));
  ({ GET: snapshotGet } = await import("../route"));
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
  grandchild = await seedRun(child);
});

describe("authorized descendant projections", () => {
  it("IT-PKD-01 IT-PKD-04: serves a readable task-less child without a repository workspace", async () => {
    const response = await requestSnapshot(root, grandchild);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as RunPeekSnapshot;

    expect(body.breadcrumbs.map((item) => item.runId)).toEqual([
      root,
      child,
      grandchild,
    ]);
    expect(body.summary.label).toContain(grandchild.slice(0, 8));
    expect(body.workspace).toBe("none");
    expect(body.content).toEqual({
      kind: "conversation",
      availability: "ready",
    });
    expect(body.capabilities.canReadTranscript).toBe(true);
    expect(body.publicResult).toBeNull();
  });

  it("IT-PKD-02: validates against a nested main anchor rather than shared root identity", async () => {
    expect((await requestSnapshot(child, grandchild)).status).toBe(200);
    const sibling = await seedRun(root);

    expect((await requestSnapshot(child, sibling)).status).toBe(404);
    expect((await requestSnapshot(root, root)).status).toBe(404);
    expect((await requestSnapshot(root, randomUUID())).status).toBe(404);
  });

  it("IT-PKD-01: preserves viewer metadata while denying the conversation capability", async () => {
    await database.pool.query(
      "UPDATE project_members SET role='viewer' WHERE user_id=$1",
      [userId],
    );
    const response = await requestSnapshot(root, child);

    expect(response.status).toBe(200);
    expect(((await response.json()) as RunPeekSnapshot).capabilities).toEqual({
      canReadTranscript: false,
      canReadEvidence: false,
    });
  });

  it("IT-PKD-01 IT-PKD-02: conceals a foreign child and any inaccessible intermediate ancestor", async () => {
    const foreign = randomUUID();

    await database.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,main_branch,branch_prefix,maister_yaml_path,task_key) VALUES($1,$2,'Secret',$3,'main','maister/','/tmp/maister.yaml',$4)",
      [
        foreign,
        `secret-${foreign}`,
        `/tmp/secret-${foreign}`,
        `S${foreign.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      ],
    );
    const denied = await seedRun(root, foreign);
    const descendant = await seedRun(denied);

    expect((await requestSnapshot(root, denied)).status).toBe(404);
    expect((await requestSnapshot(root, descendant)).status).toBe(404);
    const body = (await (
      await requestChildren(root)
    ).json()) as RunPeekChildPage;

    expect(body.items.map((item) => item.runId)).toEqual([child]);
    expect(body.totalCount).toBe(1);
  });

  it("IT-PKD-05: pages equal/null launch keys without duplicates when a pending Run starts", async () => {
    const extra = await seedRun(root);
    const first = (await (
      await requestChildren(root, "?limit=1")
    ).json()) as RunPeekChildPage;

    expect(first.items).toHaveLength(1);
    expect(first.totalCount).toBe(2);
    expect(first.hasMore).toBe(true);
    await database.pool.query(
      "UPDATE runs SET started_at=now() WHERE id=ANY($1::text[])",
      [[child, extra]],
    );
    const second = (await (
      await requestChildren(root, `?limit=1&cursor=${first.nextCursor}`)
    ).json()) as RunPeekChildPage;

    expect(
      new Set([...first.items, ...second.items].map((item) => item.runId)).size,
    ).toBe(2);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(
      (await requestChildren(child, `?cursor=${first.nextCursor}`)).status,
    ).toBe(400);
  });

  it("IT-PKD-02: refuses a corrupt ancestor cycle with bounded traversal", async () => {
    await database.pool.query("UPDATE runs SET parent_run_id=$1 WHERE id=$2", [
      grandchild,
      child,
    ]);

    expect((await requestSnapshot(root, grandchild)).status).toBe(409);
  });

  it.each([
    "?limit=0",
    "?limit=51",
    "?limit=1.5",
    "?limit=1&limit=2",
    "?cursor=not-json",
    "?parent=bad",
    "?parent=",
    "?cursor=",
    "?limit=25&unknown=x",
  ])("IT-PKD-10: rejects invalid request %s explicitly", async (query) => {
    const response = await requestChildren(root, query);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("CONFIG");
  });

  it("IT-PKD-10: authenticates before parsing or looking up a Run", async () => {
    session.user = null;

    expect((await requestChildren("invalid")).status).toBe(401);
  });

  it.each(["disabled", "pending", "password"])(
    "IT-PKD-01 IT-PKD-10: denies inactive or password-gated principal %s",
    async (state) => {
      if (state === "password")
        await database.pool.query(
          "UPDATE users SET must_change_password=true WHERE id=$1",
          [userId],
        );
      else
        await database.pool.query(
          "UPDATE users SET account_status=$1 WHERE id=$2",
          [state, userId],
        );
      expect((await requestSnapshot(root, child)).status).toBe(403);
    },
  );

  it("IT-PKN-05: inspecting and navigating never changes lifecycle, keepalive or collection", async () => {
    const before = await database.pool.query(
      "SELECT id,status,keepalive_until,ended_at FROM runs ORDER BY id",
    );

    expect((await requestSnapshot(root, child)).status).toBe(200);
    expect((await requestChildren(root)).status).toBe(200);
    expect((await requestSnapshot(root, grandchild)).status).toBe(200);
    expect(
      (
        await database.pool.query(
          "SELECT id,status,keepalive_until,ended_at FROM runs ORDER BY id",
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (await database.pool.query("SELECT count(*)::int AS n FROM run_results"))
        .rows[0],
    ).toEqual({ n: 0 });
  });

  it("IT-PKD-06: bounded transcript pages preserve order, scope, previews and visible-window updates", async () => {
    const { GET } = await import("../../transcript/route");
    const get = (query: string) =>
      GET(
        new NextRequest(
          `http://localhost/api/runs/${child}/transcript?${query}`,
        ),
        { params: Promise.resolve({ runId: child }) },
      );

    for (let sequence = 1; sequence <= 205; sequence++) {
      await database.pool.query(
        "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) VALUES($1,$2,$3,'assistant',$4,'2026-01-01')",
        [
          randomUUID(),
          child,
          sequence,
          sequence === 205 ? "界".repeat(200000) : `message-${sequence}`,
        ],
      );
    }
    const response = await get("limit=100");

    expect(response.status).toBe(200);
    const page: TranscriptPage = await response.json();

    expect(page.messages).toHaveLength(100);
    expect("content" in page.messages[0] ? page.messages[0].content : null).toBe("message-106");
    expect(page.messages[99]).toMatchObject({
      kind: "bounded_preview",
      truncated: true,
      originalBytes: 600000,
    });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(512 * 1024);
    expect(page.hasEarlier).toBe(true);
    const earlier = await (
      await get(`limit=100&before=${page.beforeCursor}`)
    ).json();

    expect(earlier.messages[0].content).toBe("message-6");
    expect(earlier.messages.at(-1).content).toBe("message-105");
    await database.pool.query(
      "UPDATE run_messages SET content='updated' WHERE id=$1",
      [earlier.messages[0].id],
    );
    const refreshed = await (
      await get(
        `limit=100&windowBefore=${earlier.window.before}&windowAfter=${earlier.window.after}`,
      )
    ).json();

    expect(refreshed.messages[0].content).toBe("updated");
    expect(refreshed.messages.at(-1).id).toBe(earlier.messages.at(-1).id);
    expect((await get(`limit=100&after=${page.beforeCursor}`)).status).toBe(
      400,
    );
    expect((await get("limit=201")).status).toBe(400);
    await database.pool.query(
      "UPDATE project_members SET role='viewer' WHERE user_id=$1",
      [userId],
    );
    expect((await get("limit=100")).status).toBe(403);
  });

  it("IT-PKD-04 IT-PKD-06: Flow facts, empty attempts, prompt ties and changed-attempt cursors retain canonical semantics", async () => {
    const flowId = randomUUID();
    const manifest = {
      schemaVersion: 1,
      name: "peek-flow",
      nodes: [
        {
          id: "work",
          type: "ai_coding",
          action: { prompt: "Work" },
          transitions: { success: "done" },
        },
      ],
    };

    await database.pool.query(
      "INSERT INTO flows(id,project_id,flow_ref_id,source,version,installed_path,manifest,schema_version) VALUES($1,$2,'peek','test','v1','/tmp/peek',$3,1)",
      [flowId, projectId, manifest],
    );
    await database.pool.query(
      "UPDATE runs SET run_kind='flow',flow_id=$1 WHERE id=$2",
      [flowId, child],
    );
    const { GET } = await import("../../transcript/route");
    const get = (query: string) =>
      GET(
        new NextRequest(
          `http://localhost/api/runs/${child}/transcript?node=work&${query}`,
        ),
        { params: Promise.resolve({ runId: child }) },
      );

    expect((await (await get("limit=1")).json()).messages).toEqual([]);
    const attempt = randomUUID();

    await database.pool.query(
      "INSERT INTO node_attempts(id,run_id,node_id,node_type,attempt,status) VALUES($1,$2,'work','ai_coding',1,'Failed')",
      [attempt, child],
    );
    for (const [sequence, event, prompt, content, role] of [
      [1, "10", "dispatch", "prompt", "user"],
      [2, "10", null, "reply", "assistant"],
      [
        3,
        "11",
        null,
        '{\"kind\":\"usage\",\"used\":45,\"size\":100}',
        "system",
      ],
    ] as const) {
      await database.pool.query(
        "INSERT INTO run_messages(id,run_id,node_attempt_id,sequence,supervisor_event_id,prompt_dispatch_key,content,role) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [randomUUID(), child, attempt, sequence, event, prompt, content, role],
      );
    }
    const page = await (await get("limit=2")).json();

    expect(page.messages.map((m: { content: string }) => m.content)).toEqual([
      "prompt",
      '{"kind":"usage","used":45,"size":100}',
    ]);
    expect(page.usage).toEqual({ used: 45, size: 100 });
    const earlier = await (
      await get(`limit=2&before=${page.beforeCursor}`)
    ).json();

    expect(earlier.messages[0].content).toBe("reply");
    const snapshot = (await (
      await requestSnapshot(root, child)
    ).json()) as RunPeekSnapshot;

    expect(snapshot.content).toMatchObject({
      kind: "flow",
      availability: "ready",
      nodes: [{ id: "work", status: "Failed", attempt: 1 }],
    });
    await database.pool.query(
      "INSERT INTO node_attempts(id,run_id,node_id,node_type,attempt,status) VALUES($1,$2,'work','ai_coding',2,'Running')",
      [randomUUID(), child],
    );
    const changed = await get(`limit=2&before=${page.beforeCursor}`);

    expect(changed.status).toBe(409);
    expect((await changed.json()).reason).toBe("transcript_attempt_changed");
    await database.pool.query("UPDATE flows SET manifest=$1 WHERE id=$2", [
      { ...manifest, compat: { engine_max: "1.0.0" } },
      flowId,
    ]);
    expect(
      (await (await requestSnapshot(root, child)).json()).content,
    ).toMatchObject({ kind: "flow", availability: "incompatible" });
    expect((await (await get("limit=2")).json()).compatible).toBe(false);
  });

  it("IT-PKD-02: bounded hierarchy refuses depth 65 and accepts depth 64 without eager tree reads", async () => {
    let parent = root;

    for (let depth = 1; depth <= 65; depth++) {
      parent = await seedRun(parent);
      if (depth === 64)
        expect((await requestSnapshot(root, parent)).status).toBe(200);
    }
    expect((await requestSnapshot(root, parent)).status).toBe(409);
  });

  it("IT-PKD-01: invisible grandchildren do not leak through hasChildren", async () => {
    await database.pool.query("DELETE FROM runs WHERE id=$1", [grandchild]);
    const foreign = randomUUID();

    await database.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,maister_yaml_path,task_key) VALUES($1,$2,'Secret',$3,'/tmp/m.yaml',$4)",
      [
        foreign,
        foreign,
        `/tmp/${foreign}`,
        `S${foreign.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      ],
    );
    await seedRun(child, foreign);
    expect(
      (await (await requestSnapshot(root, child)).json()).summary.hasChildren,
    ).toBe(false);
  });

  it("IT-PKD-06: projection advances at most four quanta toward a captured head and reports held/poisoned consumers", async () => {
    const { GET } = await import("../../transcript/route");
    const get = (query = "limit=100") =>
      GET(
        new NextRequest(
          `http://localhost/api/runs/${child}/transcript?${query}`,
        ),
        { params: Promise.resolve({ runId: child }) },
      );

    await database.pool.query(
      `INSERT INTO execution_events(id,source,source_key,run_id,event_type,payload_schema,payload,occurred_at,received_at,run_sequence,ingest_disposition)
      SELECT gen_random_uuid()::text,'manager',$1 || '-' || n::text,$1,'session.update','maister.session.update.v1',jsonb_build_object('update',jsonb_build_object('sessionUpdate','agent_message_chunk','content',jsonb_build_object('type','text','text','x'))),now(),now(),n,'accepted' FROM generate_series(1,501) n`,
      [child],
    );
    const first: TranscriptPage = await (await get()).json();

    expect(first.projection.state).toBe("pending");
    expect(first.projection.continuation).toBe(true);
    expect(Number(first.projection.throughSequence)).toBeLessThanOrEqual(400);
    await database.pool.query(
      `INSERT INTO execution_events(id,source,source_key,run_id,event_type,payload_schema,payload,occurred_at,received_at,run_sequence,ingest_disposition)
      VALUES(gen_random_uuid()::text,'manager',$1 || '-502',$1,'session.update','maister.session.update.v1','{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"late"}}}',now(),now(),502,'accepted')`,
      [child],
    );
    let captured: TranscriptPage = await (
      await get("limit=100&through=501")
    ).json();

    for (
      let request = 0;
      request < 20 && captured.projection.state === "pending";
      request++
    ) {
      expect(captured.projection.continuation).toBe(true);
      const previous = BigInt(captured.projection.throughSequence!);

      captured = await (await get("limit=100&through=501")).json();
      expect(BigInt(captured.projection.throughSequence!)).toBeGreaterThan(
        previous,
      );
      expect(captured.projection.observedHead).toBe("501");
    }
    expect(captured.projection).toMatchObject({
      state: "caught_up",
      throughSequence: "501",
      observedHead: "501",
      continuation: false,
    });
    await database.pool.query(
      "UPDATE execution_event_consumers SET claim_owner='held',claim_expires_at=now()+interval '1 minute' WHERE run_id=$1",
      [child],
    );
    const held = await (await get()).json();

    expect(held.projection).toMatchObject({
      state: "pending",
      throughSequence: "501",
      observedHead: "502",
      continuation: false,
    });
    await database.pool.query(
      "UPDATE execution_event_consumers SET state='poisoned',claim_owner=NULL,claim_expires_at=NULL WHERE run_id=$1",
      [child],
    );
    const poisoned = await get();

    expect(poisoned.status).toBe(409);
    expect((await poisoned.json()).reason).toBe(
      "transcript_projection_poisoned",
    );
  });

  it("IT-PKD-10: actual child and snapshot responses conform to the published schemas", async () => {
    const document = parse(
      readFileSync(
        resolve(process.cwd(), "../docs/api/web.openapi.yaml"),
        "utf8",
      ),
    ) as { components: { schemas: Record<string, object> } };
    const ajv = new Ajv({ strict: false, validateFormats: false });

    const { GET: transcriptGet } = await import("../../transcript/route");
    const transcriptResponse = await transcriptGet(
      new NextRequest(
        `http://localhost/api/runs/${child}/transcript?limit=100`,
      ),
      { params: Promise.resolve({ runId: child }) },
    );

    for (const [name, response] of [
      ["RunPeekSnapshot", await requestSnapshot(root, child)],
      ["RunPeekChildPage", await requestChildren(root)],
      ["RunTranscriptPage", transcriptResponse],
    ] as const) {
      expect(response.status).toBe(200);
      const schema = normalizeSchema({
        components: document.components,
        $ref: `#/components/schemas/${name}`,
      }) as object;
      const validate = ajv.compile(schema);

      expect(
        validate(await response.json()),
        JSON.stringify(validate.errors),
      ).toBe(true);
    }
  });
});
