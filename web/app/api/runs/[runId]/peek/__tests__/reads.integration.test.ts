import type { TranscriptPage } from "@/lib/runs/transcript-page";
import type { RunResultContract } from "@/lib/run-results/types";
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
import { getDb } from "@/lib/db/client";
import {
  encodeToolPayload,
  parseScratchMessageContent,
} from "@/lib/run-transcript/transcript";
import { TRANSCRIPT_PAGE_BYTES } from "@/lib/runs/transcript-page";
import { reanchorDispatchedPrompts } from "@/lib/execution-host/events/run-message-store";
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

const apiDocument = parse(
  readFileSync(resolve(process.cwd(), "../docs/api/web.openapi.yaml"), "utf8"),
) as { components: { schemas: Record<string, object> } };
const apiValidator = new Ajv({ strict: false, validateFormats: false });

function expectContract(name: string, value: unknown): void {
  const schema = normalizeSchema({
    components: apiDocument.components,
    $ref: `#/components/schemas/${name}`,
  }) as object;
  const validate = apiValidator.compile(schema);

  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
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

  it("IT-PKD-04: failed snapshots reuse the matching token-only terminal cause without exposing raw event content", async () => {
    const cause = {
      code: "BUDGET_EXCEEDED",
      reason: "budget_breach",
      source: "sweeper",
    };

    await database.pool.query("UPDATE runs SET status='Failed' WHERE id=$1", [
      child,
    ]);
    await database.pool.query(
      "INSERT INTO domain_events(kind,project_id,run_id,payload,occurred_at) VALUES('run.failed',$1,$2,$3,now())",
      [
        projectId,
        child,
        { cause, privateMessage: "do not disclose this raw payload" },
      ],
    );
    const response = await requestSnapshot(root, child);

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.terminalCause).toEqual(cause);
    expect(JSON.stringify(body)).not.toContain("do not disclose");
    expectContract("RunPeekSnapshot", body);
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

  it.each([null, "2026-01-01T00:00:00.000123Z"])(
    "IT-PKD-05: pages equal/null launch keys without duplicates when a pending Run starts: %s",
    async (launched) => {
      const extra = await seedRun(root);

      if (launched)
        await database.pool.query(
          "UPDATE runs SET launched_at=$1 WHERE id=ANY($2::text[])",
          [launched, [child, extra]],
        );
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
        new Set([...first.items, ...second.items].map((item) => item.runId))
          .size,
      ).toBe(2);
      expect(second.hasMore).toBe(false);
      expect(second.nextCursor).toBeNull();
      expect(
        (await requestChildren(child, `?cursor=${first.nextCursor}`)).status,
      ).toBe(400);
    },
  );

  it("IT-PKD-02 IT-PKD-05: full-page insertion, deletion and reparenting preserve immutable keyset order and off-page selection", async () => {
    const ids: string[] = [];

    for (let index = 0; index < 35; index++) {
      const id = await seedRun(root);

      ids.push(id);
      await database.pool.query("UPDATE runs SET launched_at=$1 WHERE id=$2", [
        new Date(1700000000000 + index),
        id,
      ]);
    }
    const first = (await (
      await requestChildren(root)
    ).json()) as RunPeekChildPage;

    expect(first.items.map((item) => item.runId)).toEqual(ids.slice(0, 25));
    const inserted = await seedRun(root);

    await database.pool.query("UPDATE runs SET launched_at=$1 WHERE id=$2", [
      new Date(1700000000035),
      inserted,
    ]);
    await database.pool.query("DELETE FROM runs WHERE id=$1", [ids[0]]);
    const second = (await (
      await requestChildren(root, `?cursor=${first.nextCursor}`)
    ).json()) as RunPeekChildPage;

    expect(second.items.map((item) => item.runId)).toEqual([
      ...ids.slice(25),
      inserted,
      ...[child].sort(),
    ]);
    const selected = (await (
      await requestSnapshot(root, ids[34])
    ).json()) as RunPeekSnapshot;

    expect(selected.selectedRunId).toBe(ids[34]);
    await database.pool.query("UPDATE runs SET parent_run_id=$1 WHERE id=$2", [
      child,
      ids[34],
    ]);
    const children = (await (
      await requestChildren(root, `?parent=${child}`)
    ).json()) as RunPeekChildPage;

    expect(children.items.some((item) => item.runId === ids[34])).toBe(true);
    const moved = (await (
      await requestSnapshot(root, ids[34])
    ).json()) as RunPeekSnapshot;

    expect(moved.breadcrumbs.map((item) => item.runId)).toEqual([
      root,
      child,
      ids[34],
    ]);
  });

  it("IT-PKD-01: a private local-package scratch child uses its positive owner grant and conceals another owner", async () => {
    const localPackage = randomUUID();
    const scratch = await seedRun(root);

    try {
      await database.pool.query(
        "INSERT INTO local_packages(id,name,slug,working_dir,created_by) VALUES($1,'Private package',$2,'/tmp/peek-private',$3)",
        [localPackage, `peek-${localPackage}`, userId],
      );
      await database.pool.query(
        "UPDATE runs SET run_kind='scratch',project_id=NULL,local_package_id=$1,created_by_user_id=$2 WHERE id=$3",
        [localPackage, userId, scratch],
      );
      const response = await requestSnapshot(root, scratch);

      expect(response.status).toBe(200);
      expect((await response.json()).capabilities.canReadTranscript).toBe(true);
      const page = (await (
        await requestChildren(root)
      ).json()) as RunPeekChildPage;

      expect(page.items.some((item) => item.runId === scratch)).toBe(true);
      await database.pool.query(
        "UPDATE runs SET created_by_user_id=NULL WHERE id=$1",
        [scratch],
      );
      expect((await requestSnapshot(root, scratch)).status).toBe(404);
      const hidden = (await (
        await requestChildren(root)
      ).json()) as RunPeekChildPage;

      expect(hidden.items.some((item) => item.runId === scratch)).toBe(false);
    } finally {
      await database.pool.query("DELETE FROM local_packages WHERE id=$1", [
        localPackage,
      ]);
    }
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
        "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) VALUES($1,$2,$3,'assistant',$4,'2026-01-01T00:00:00.000123Z')",
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

    expect(page.hasEarlier).toBe(true);
    const tampered = JSON.parse(
      Buffer.from(page.beforeCursor!, "base64url").toString("utf8"),
    ) as { position: { event: string } };

    tampered.position.event = "x";
    expect(
      (
        await get(
          `limit=100&before=${Buffer.from(JSON.stringify(tampered)).toString("base64url")}`,
        )
      ).status,
    ).toBe(400);

    expect(page.messages).toHaveLength(100);
    expect(
      "content" in page.messages[0] ? page.messages[0].content : null,
    ).toBe("message-106");
    expect(page.messages[99]).toMatchObject({
      content: "界".repeat(1024),
      preview: { originalBytes: 600000 },
    });
    expect(page.messages[99].preview?.fullContentHref).toBe(
      `/api/runs/${child}/transcript/messages/${page.messages[99].id}`,
    );
    expectContract("RunTranscriptPage", page);
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

  it("IT-PKD-06: cumulative byte boundaries prioritize the tail and preserve every mixed record in both directions", async () => {
    const { GET } = await import("../../transcript/route");
    const get = async (query = ""): Promise<TranscriptPage> => {
      const response = await GET(
        new NextRequest(
          `http://localhost/api/runs/${child}/transcript?limit=100&${query}`,
        ),
        { params: Promise.resolve({ runId: child }) },
      );

      expect(response.status).toBe(200);
      const raw = await response.text();

      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(TRANSCRIPT_PAGE_BYTES);
      const page = JSON.parse(raw) as TranscriptPage;

      expectContract("RunTranscriptPage", page);

      return page;
    };
    const records = [
      { role: "user", content: "First request" },
      {
        role: "tool",
        content: encodeToolPayload({
          name: "Read",
          toolKind: "read",
          status: "completed",
          arg: "first.txt",
          rawInput: { path: "first.txt" },
          result: "a".repeat(230000),
        }),
      },
      { role: "assistant", content: "Small reply after first large tool" },
      {
        role: "system",
        content: JSON.stringify({
          v: 1,
          kind: "thought",
          text: "Considering the next file",
        }),
      },
      {
        role: "tool",
        content: encodeToolPayload({
          name: "Read",
          toolKind: "read",
          status: "completed",
          arg: "second.txt",
          rawInput: { path: "second.txt" },
          result: "b".repeat(230000),
        }),
      },
      { role: "assistant", content: "Small reply after second large tool" },
      { role: "user", content: "Continue" },
      {
        role: "tool",
        content: encodeToolPayload({
          name: "Bash",
          toolKind: "execute",
          status: "completed",
          arg: "git status",
          rawInput: { command: "git status" },
          result: "c".repeat(230000),
        }),
      },
      { role: "assistant", content: "Latest small answer" },
    ];
    const ids = records.map(() => randomUUID());

    for (const [index, record] of records.entries())
      await database.pool.query(
        "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) VALUES($1,$2,$3,$4,$5,'2026-01-01T00:00:00.000123Z')",
        [ids[index], child, index + 1, record.role, record.content],
      );
    const latest = await get();

    expect(latest.messages.at(-1)?.id).toBe(ids.at(-1));
    expect(latest.messages.at(-1)?.content).toBe("Latest small answer");
    expect(latest.messages.length).toBeLessThan(records.length);
    expect(latest.hasEarlier).toBe(true);
    expect(latest.hasLater).toBe(false);
    // Stable anchors are available before future live rows are appended.
    expect(latest.afterCursor).toBeTypeOf("string");
    const backwards = [...latest.messages];
    const portions = [latest];
    let earliest = latest;

    while (earliest.hasEarlier) {
      earliest = await get(`before=${earliest.beforeCursor}`);
      portions.push(earliest);
      backwards.unshift(...earliest.messages);
    }
    expect(backwards.map((message) => message.id)).toEqual(ids);
    expect(backwards.map((message) => message.content)).toEqual(
      records.map((record) => record.content),
    );
    expect(backwards.every((message) => message.preview === undefined)).toBe(
      true,
    );
    const firstCallPortion = portions.findIndex((portion) =>
      portion.messages.some((message) => message.id === ids[1]),
    );
    const secondCallPortion = portions.findIndex((portion) =>
      portion.messages.some((message) => message.id === ids[4]),
    );

    expect(firstCallPortion).toBeGreaterThanOrEqual(0);
    expect(secondCallPortion).toBeGreaterThanOrEqual(0);
    expect(firstCallPortion).not.toBe(secondCallPortion);
    // Same-name calls on opposite portion boundaries stay distinct complete
    // canonical tool units; a result is never matched by name or adjacency.
    expect(
      [backwards[1], backwards[4]].map((message) =>
        parseScratchMessageContent(message.role, message.content),
      ),
    ).toMatchObject([
      {
        kind: "tool",
        tool: {
          name: "Read",
          arg: "first.txt",
          status: "completed",
          result: "a".repeat(230000),
        },
      },
      {
        kind: "tool",
        tool: {
          name: "Read",
          arg: "second.txt",
          status: "completed",
          result: "b".repeat(230000),
        },
      },
    ]);
    const forwards = [...earliest.messages];
    let next = earliest;

    while (next.hasLater) {
      next = await get(`after=${next.afterCursor}`);
      forwards.push(...next.messages);
    }
    expect(forwards.map((message) => message.id)).toEqual(ids);
    expect(new Set(forwards.map((message) => message.id)).size).toBe(
      ids.length,
    );
    const recentered = await get(`anchor=${ids[4]}`);

    expect(recentered.messages[0].id).toBe(ids[4]);
    expect(recentered.messages[0].content).toBe(records[4].content);
    expect(recentered.hasEarlier).toBe(true);
    expect(recentered.hasLater).toBe(true);
    expect(
      (
        await GET(
          new NextRequest(
            `http://localhost/api/runs/${child}/transcript?limit=100&anchor=${randomUUID()}`,
          ),
          { params: Promise.resolve({ runId: child }) },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await GET(
          new NextRequest(
            `http://localhost/api/runs/${child}/transcript?limit=100&anchor=${ids[4]}&after=${latest.afterCursor}`,
          ),
          { params: Promise.resolve({ runId: child }) },
        )
      ).status,
    ).toBe(400);
    const appendedId = randomUUID();

    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) VALUES($1,$2,10,'assistant','live row','2026-01-01T00:00:00.000123Z')",
      [appendedId, child],
    );
    expect(
      (await get(`after=${latest.afterCursor}`)).messages.map(
        (message) => message.id,
      ),
    ).toEqual([appendedId]);
  });

  it("IT-PKD-06: escaped UTF-8 wire sizes admit complete records and oversized tools retain identity and complete access", async () => {
    const { GET } = await import("../../transcript/route");
    const { GET: downloadGet } =
      await import("../../transcript/messages/[messageId]/route");
    const get = async (query = ""): Promise<TranscriptPage> => {
      const response = await GET(
        new NextRequest(
          `http://localhost/api/runs/${child}/transcript?limit=100&${query}`,
        ),
        { params: Promise.resolve({ runId: child }) },
      );

      expect(response.status).toBe(200);
      const raw = await response.text();

      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(TRANSCRIPT_PAGE_BYTES);

      return JSON.parse(raw) as TranscriptPage;
    };
    const multibyte = '界😀"\\\n'.repeat(15000);
    const oversizedTool = encodeToolPayload({
      name: "Read",
      toolKind: "read",
      status: "completed",
      arg: "large.txt",
      rawInput: { path: "large.txt" },
      result: "界😀".repeat(100000),
    });
    const escaped = "\u0001".repeat(70000);
    const records = [
      { role: "assistant", content: multibyte },
      { role: "tool", content: oversizedTool },
      {
        role: "assistant",
        content: "Small message following oversized result",
      },
      { role: "user", content: escaped },
      { role: "assistant", content: "Latest message" },
    ];
    const ids = records.map(() => randomUUID());

    for (const [index, record] of records.entries())
      await database.pool.query(
        "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) VALUES($1,$2,$3,$4,$5,'2026-01-01T00:00:00.000123Z')",
        [ids[index], child, index + 1, record.role, record.content],
      );
    const latest = await get();
    const all = [...latest.messages];
    let previous = latest;

    while (previous.hasEarlier) {
      previous = await get(`before=${previous.beforeCursor}`);
      all.unshift(...previous.messages);
    }
    expect(all.map((message) => message.id)).toEqual(ids);
    expect(all[0].content).toBe(multibyte);
    expect(all[0].preview).toBeUndefined();
    expect(all[2].content).toBe(records[2].content);
    expect(all[2].preview).toBeUndefined();
    expect(all[3].preview?.originalBytes).toBe(Buffer.byteLength(escaped));
    const tool = all[1];

    expect(tool.preview?.originalBytes).toBe(Buffer.byteLength(oversizedTool));
    expect(parseScratchMessageContent(tool.role, tool.content)).toMatchObject({
      kind: "tool",
      tool: {
        name: "Read",
        toolKind: "read",
        status: "completed",
        arg: "large.txt",
        result: "界😀".repeat(512),
      },
    });
    const download = await downloadGet(
      new NextRequest(`http://localhost${tool.preview!.fullContentHref}`),
      { params: Promise.resolve({ runId: child, messageId: tool.id }) },
    );

    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toContain("attachment");
    expect(download.headers.get("Cache-Control")).toBe("private, no-store");
    expect(download.headers.get("Content-Length")).toBe(
      String(Buffer.byteLength(oversizedTool)),
    );
    const reader = download.body!.getReader();
    const chunks: Uint8Array[] = [];

    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;
      expect(chunk.value.byteLength).toBeLessThanOrEqual(65536);
      chunks.push(chunk.value);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe(oversizedTool);
    expect(chunks.length).toBeGreaterThan(1);
    const abort = new AbortController();
    const aborted = await downloadGet(
      new NextRequest(`http://localhost${tool.preview!.fullContentHref}`, {
        signal: abort.signal,
      }),
      { params: Promise.resolve({ runId: child, messageId: tool.id }) },
    );
    const abortedReader = aborted.body!.getReader();

    expect((await abortedReader.read()).done).toBe(false);
    abort.abort();
    await expect(abortedReader.read()).rejects.toMatchObject({
      name: "AbortError",
    });
    const cancelled = await downloadGet(
      new NextRequest(`http://localhost${tool.preview!.fullContentHref}`),
      { params: Promise.resolve({ runId: child, messageId: tool.id }) },
    );
    const cancelledReader = cancelled.body!.getReader();

    expect((await cancelledReader.read()).done).toBe(false);
    await cancelledReader.cancel();
    expect((await cancelledReader.read()).done).toBe(true);
    const changed = await downloadGet(
      new NextRequest(`http://localhost${tool.preview!.fullContentHref}`),
      { params: Promise.resolve({ runId: child, messageId: tool.id }) },
    );
    const changingReader = changed.body!.getReader();

    expect((await changingReader.read()).done).toBe(false);
    await database.pool.query(
      "UPDATE run_messages SET content=content || 'changed' WHERE id=$1",
      [tool.id],
    );
    await expect(changingReader.read()).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "transcript_message_changed" },
    });
    const foreign = await downloadGet(
      new NextRequest(
        `http://localhost/api/runs/${root}/transcript/messages/${tool.id}`,
      ),
      { params: Promise.resolve({ runId: root, messageId: tool.id }) },
    );

    expect(foreign.status).toBe(404);
    await database.pool.query(
      "UPDATE project_members SET role='viewer' WHERE user_id=$1",
      [userId],
    );
    expect(
      (
        await downloadGet(
          new NextRequest(`http://localhost${tool.preview!.fullContentHref}`),
          { params: Promise.resolve({ runId: child, messageId: tool.id }) },
        )
      ).status,
    ).toBe(403);
  });

  it("IT-PKD-06: usage remains independent of page windows and ignores newer non-usage JSON", async () => {
    const { GET } = await import("../../transcript/route");
    const get = (query: string) =>
      GET(
        new NextRequest(
          `http://localhost/api/runs/${child}/transcript?limit=1&${query}`,
        ),
        { params: Promise.resolve({ runId: child }) },
      );

    for (const [sequence, content] of [
      [1, JSON.stringify({ kind: "usage", used: 12, size: 100 })],
      [2, JSON.stringify({ kind: "info", note: '"kind" "usage"' })],
      [3, '{"kind":"usage"broken}'],
    ] as const)
      await database.pool.query(
        "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) VALUES($1,$2,$3,'system',$4,$5)",
        [
          randomUUID(),
          child,
          sequence,
          content,
          new Date(1700000000000 + sequence),
        ],
      );
    const page = await (await get("")).json();

    expect(page.usage).toEqual({ used: 12, size: 100 });
    const earlier = await (await get(`before=${page.beforeCursor}`)).json();

    await database.pool.query(
      "DELETE FROM run_messages WHERE run_id=$1 AND sequence=3",
      [child],
    );
    const empty = await (await get(`after=${earlier.afterCursor}`)).json();

    expect(empty.messages).toEqual([]);
    expect(empty.usage).toEqual({ used: 12, size: 100 });
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
    const { GET: downloadGet } =
      await import("../../transcript/messages/[messageId]/route");
    const download = (attemptQuery: string) =>
      downloadGet(
        new NextRequest(
          `http://localhost/api/runs/${child}/transcript/messages/${page.messages[0].id}${attemptQuery}`,
        ),
        {
          params: Promise.resolve({
            runId: child,
            messageId: page.messages[0].id,
          }),
        },
      );

    expect((await download("")).status).toBe(409);
    const currentDownload = await download(`?attempt=${attempt}`);

    expect(currentDownload.status).toBe(200);
    expect(await currentDownload.text()).toBe("prompt");
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
    expect((await download(`?attempt=${attempt}`)).status).toBe(409);
    await database.pool.query("UPDATE flows SET manifest=$1 WHERE id=$2", [
      { ...manifest, compat: { engine_max: "1.0.0" } },
      flowId,
    ]);
    expect(
      (await (await requestSnapshot(root, child)).json()).content,
    ).toMatchObject({ kind: "flow", availability: "incompatible" });
    expect((await (await get("limit=2")).json()).compatible).toBe(false);
  });

  it("IT-PKD-06: late tool completion keeps cursor order and corrected prompt horizons rebase scoped boundaries", async () => {
    const flowId = randomUUID();
    const attempt = randomUUID();
    const manifest = {
      schemaVersion: 1,
      name: "cursor-flow",
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
      "INSERT INTO flows(id,project_id,flow_ref_id,source,version,installed_path,manifest,schema_version) VALUES($1,$2,'cursor','test','v1','/tmp/cursor',$3,1)",
      [flowId, projectId, manifest],
    );
    await database.pool.query(
      "UPDATE runs SET run_kind='flow',flow_id=$1 WHERE id=$2",
      [flowId, child],
    );
    await database.pool.query(
      "INSERT INTO node_attempts(id,run_id,node_id,node_type,attempt,status) VALUES($1,$2,'work','ai_coding',1,'Running')",
      [attempt, child],
    );
    const { GET } = await import("../../transcript/route");
    const get = async (query = "limit=1"): Promise<TranscriptPage> => {
      const response = await GET(
        new NextRequest(
          `http://localhost/api/runs/${child}/transcript?node=work&${query}`,
        ),
        { params: Promise.resolve({ runId: child }) },
      );

      expect(response.status).toBe(200);

      return response.json() as Promise<TranscriptPage>;
    };
    const emit = async (
      sequence: number,
      update: Record<string, unknown>,
    ): Promise<void> => {
      await database.pool.query(
        "INSERT INTO execution_events(id,source,source_key,run_id,event_type,payload_schema,payload,occurred_at,received_at,run_sequence,ingest_disposition) VALUES($1,'manager',$2,$3,'session.update','maister.session.update.v1',$4,now(),now(),$5,'accepted')",
        [
          randomUUID(),
          `${child}-${sequence}`,
          child,
          { nodeAttemptId: attempt, update },
          sequence,
        ],
      );
    };

    await emit(1, {
      sessionUpdate: "tool_call",
      toolCallId: "call-a",
      title: "Read",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "first.txt" },
    });
    await emit(2, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Between calls" },
    });
    await emit(3, {
      sessionUpdate: "tool_call",
      toolCallId: "call-b",
      title: "Read",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "second.txt" },
    });
    const tail = await get();
    const middle = await get(`limit=1&before=${tail.beforeCursor}`);
    const first = await get(`limit=1&before=${middle.beforeCursor}`);

    expect(first.messages[0].role).toBe("tool");
    expect(middle.messages[0].content).toBe("Between calls");
    expect(tail.messages[0].role).toBe("tool");
    // Simulate a row written by the prior binary between migration and restart.
    await database.pool.query(
      "UPDATE run_messages SET first_supervisor_event_id=NULL WHERE id=$1",
      [first.messages[0].id],
    );
    await emit(4, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-a",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "first result" } },
      ],
    });
    const refreshed = await get(
      `limit=1&windowBefore=${first.window.before}&windowAfter=${first.window.after}`,
    );

    expect(refreshed.messages[0].id).toBe(first.messages[0].id);
    expect(
      parseScratchMessageContent(
        refreshed.messages[0].role,
        refreshed.messages[0].content,
      ),
    ).toMatchObject({
      kind: "tool",
      tool: {
        name: "Read",
        arg: "first.txt",
        status: "completed",
        result: "first result",
      },
    });
    expect((await get()).messages[0].id).toBe(tail.messages[0].id);
    expect(
      (await get(`limit=1&before=${middle.beforeCursor}`)).messages[0].id,
    ).toBe(first.messages[0].id);
    expect((await get(`limit=1&after=${tail.afterCursor}`)).messages).toEqual(
      [],
    );
    const anchors = await database.pool.query(
      "SELECT first_supervisor_event_id,supervisor_event_id FROM run_messages WHERE id=$1",
      [first.messages[0].id],
    );

    expect(anchors.rows[0]).toEqual({
      first_supervisor_event_id: "1",
      supervisor_event_id: "4",
    });
    const promptId = randomUUID();

    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,node_attempt_id,sequence,role,content,supervisor_event_id,prompt_dispatch_key) VALUES($1,$2,$3,-1,'user','Later-dispatched prompt','-1','dispatch-corrected')",
      [promptId, child, attempt],
    );
    const oldPrompt = await get(`limit=1&anchor=${promptId}`);

    expect(oldPrompt.hasEarlier).toBe(false);
    expect(oldPrompt.messages[0].id).toBe(promptId);
    await emit(5, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Late-ingested reply" },
    });
    await getDb().transaction((tx) =>
      reanchorDispatchedPrompts(tx, {
        runId: child,
        settledAt: new Date(0),
        anchor: 6n,
      }),
    );
    const corrected = await get(
      `limit=1&windowBefore=${oldPrompt.window.before}&windowAfter=${oldPrompt.window.after}`,
    );

    expect(corrected.messages[0].id).toBe(promptId);
    expect(corrected.hasEarlier).toBe(true);
    expect(corrected.beforeCursor).not.toBe(oldPrompt.beforeCursor);
    const preceding = await get(`limit=1&before=${oldPrompt.beforeCursor}`);

    expect(preceding.messages[0].content).toBe("Late-ingested reply");
    const traversal = [
      ...(await get(`limit=100&before=${oldPrompt.beforeCursor}`)).messages,
      corrected.messages[0],
    ];

    expect(traversal.map((message) => message.id)).toEqual([
      first.messages[0].id,
      middle.messages[0].id,
      tail.messages[0].id,
      preceding.messages[0].id,
      promptId,
    ]);
    expect(new Set(traversal.map((message) => message.id)).size).toBe(5);
    // Even when correction reverses the old window endpoints, refresh includes
    // both endpoint records and returns their current chronological order.
    const reversedWindow = await get(
      `limit=100&windowBefore=${oldPrompt.window.before}&windowAfter=${first.window.after}`,
    );

    expect(reversedWindow.messages[0].id).toBe(first.messages[0].id);
    expect(reversedWindow.messages.at(-1)?.id).toBe(promptId);
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

  it.each([
    ["Running", true, null, "pending"],
    ["Done", false, null, "absent"],
    ["Done", true, null, "missing"],
    ["Done", true, "stale", "stale"],
    ["Done", true, "invalid", "invalid"],
    ["Failed", true, "valid", "unavailable"],
    ["Done", true, "valid", "valid"],
    ["Done", true, "superseded", "missing"],
    ["Done", null, null, null],
  ] as const)(
    "IT-PKD-03: child HTTP metadata and payload retain result state %s / %s / %s",
    async (status, required, validity, expected) => {
      const contract: RunResultContract | null =
        required === null
          ? null
          : {
              kind: "flow_export",
              producerNodeIds: ["work"],
              schemaRef: "fixture@abcdef123456:research-result.v1",
              schemaVersion: 1,
              sha256: "a".repeat(64),
              required,
              schema: {
                schemaVersion: 1,
                fields: [{ name: "summary", type: "string", required: true }],
              },
              flowRevisionId: "peek",
            };

      await database.pool.query(
        "UPDATE runs SET run_kind='flow',status=$1,result_contract=$2 WHERE id=$3",
        [status, contract, child],
      );
      if (validity)
        await database.pool.query(
          "INSERT INTO run_results(id,run_id,revision,validity,schema_ref,schema_version,schema_sha256,value,value_bytes,producer_kind,producer_ref,invalid_reason,engine_version) VALUES($1,$2,1,$3,'result',1,$4,$5::jsonb,40,'flow_node','work',$6,'3.10.0')",
          [
            randomUUID(),
            child,
            validity,
            "a".repeat(64),
            validity === "invalid"
              ? null
              : JSON.stringify({ summary: "authorized value" }),
            validity === "invalid" ? "schema_mismatch" : null,
          ],
        );
      const response = await requestSnapshot(root, child);

      expect(response.status).toBe(200);
      const snapshot = (await response.json()) as RunPeekSnapshot;

      expectContract("RunPeekSnapshot", snapshot);
      expect(snapshot.summary.resultStatus).toBe(expected);
      expect(snapshot.publicResult?.resultStatus ?? null).toBe(expected);
      expect(snapshot.publicResult?.value ?? null).toEqual(
        expected === "valid" ? { summary: "authorized value" } : null,
      );
      const page = (await (
        await requestChildren(root)
      ).json()) as RunPeekChildPage;

      expect(
        page.items.find((item) => item.runId === child)?.resultStatus,
      ).toBe(expected);
      expect(JSON.stringify(page)).not.toContain("authorized value");
    },
  );

  it("IT-PKD-10: actual child and snapshot responses conform to the published schemas", async () => {
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
      expectContract(name, await response.json());
    }
  });
});
