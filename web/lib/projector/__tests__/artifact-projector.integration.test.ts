// T5.1 (RED): failing integration tests for the ADR-022 artifact projector core.
//
// Contract under test (module not yet implemented — these MUST fail RED):
//   web/lib/projector/artifact-projector.ts exports
//     projectRunEvents(runId, opts?: { db?: Db })
//       : Promise<{ projected: number; lastMonotonicId: number }>
//
// It is a PULL projector over the run-scoped run.events.jsonl (one file per
// run, shared across steps; monotonicId is run-global). It derives event-stream
// evidence the runner cannot see: tool-call activity (kind:"log") and preview
// URLs (kind:"preview"), both producer:"projector". It advances a per-run
// cursor (PK=runId, scope="run") in the same transaction as the upserts
// (crash-safe replay). It NEVER drives runs.status and NEVER uses fs.watch.

import type {
  ArtifactInstance,
  ArtifactProjectionCursor,
} from "@/lib/db/schema";

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { projectorArtifactId } from "@/lib/flows/graph/artifact-store";
import { projectRunEvents } from "@/lib/projector/artifact-projector";

// FIXME(any): dual drizzle-orm peer-dep variants (matches the store/ledger idiom).
const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

const ORIGINAL_RUNTIME_ROOT = process.env.MAISTER_RUNTIME_ROOT;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  // Each test seeds its own temp runtime root and sets the env so the
  // projector resolves runtimeRoot()/.maister/<slug>/runs/<runId>/run.events.jsonl
  // to the file we wrote.
  delete process.env.MAISTER_RUNTIME_ROOT;
});

afterEach(() => {
  if (ORIGINAL_RUNTIME_ROOT === undefined) {
    delete process.env.MAISTER_RUNTIME_ROOT;
  } else {
    process.env.MAISTER_RUNTIME_ROOT = ORIGINAL_RUNTIME_ROOT;
  }
});

type Seeded = {
  runId: string;
  slug: string;
  runtimeRoot: string;
  eventsLogPath: string;
  attemptAId: string;
  attemptBId: string;
  sessionA: string;
  sessionB: string;
};

// Seed a project + run + two node_attempts (each with a distinct acp_session_id
// for attribution), set MAISTER_RUNTIME_ROOT to a temp dir, and return handles.
async function seedRun(): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest: { schemaVersion: 1, name: "g" },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    executorId,
    flowVersion: "v1.0.0",
    status: "Running",
  });

  const attemptAId = randomUUID();
  const attemptBId = randomUUID();
  const sessionA = `acp-session-${randomUUID()}`;
  const sessionB = `acp-session-${randomUUID()}`;

  await db.insert(schema.nodeAttempts).values({
    id: attemptAId,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
    acpSessionId: sessionA,
  });
  await db.insert(schema.nodeAttempts).values({
    id: attemptBId,
    runId,
    nodeId: "checks",
    nodeType: "check",
    attempt: 1,
    status: "Running",
    acpSessionId: sessionB,
  });

  const eventsLogPath = join(
    runtimeRoot,
    ".maister",
    slug,
    "runs",
    runId,
    "run.events.jsonl",
  );

  await mkdir(join(runtimeRoot, ".maister", slug, "runs", runId), {
    recursive: true,
  });

  return {
    runId,
    slug,
    runtimeRoot,
    eventsLogPath,
    attemptAId,
    attemptBId,
    sessionA,
    sessionB,
  };
}

// ---- realistic supervisor event-line builders ----
// Mirrors supervisor/src/types.ts SessionEvent union exactly; the supervisor
// writes one `JSON.stringify(event)` per line to run.events.jsonl.

function toolCallLine(opts: {
  monotonicId: number;
  sessionId: string;
  toolCallId?: string;
  sessionUpdate?: "tool_call" | "tool_call_update";
  content?: unknown[];
  locations?: unknown[];
}): string {
  return JSON.stringify({
    type: "session.update",
    sessionId: opts.sessionId,
    monotonicId: opts.monotonicId,
    update: {
      sessionUpdate: opts.sessionUpdate ?? "tool_call",
      toolCallId: opts.toolCallId ?? `call-${opts.monotonicId}`,
      title: "Run command",
      kind: "execute",
      status: "completed",
      content: opts.content ?? [
        { type: "content", content: { type: "text", text: "ran ok" } },
      ],
      locations: opts.locations ?? [],
    },
  });
}

function agentMessageChunkLine(opts: {
  monotonicId: number;
  sessionId: string;
}): string {
  return JSON.stringify({
    type: "session.update",
    sessionId: opts.sessionId,
    monotonicId: opts.monotonicId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "thinking out loud" },
    },
  });
}

// A tool_call whose content/locations carry an https preview link.
function previewToolCallLine(opts: {
  monotonicId: number;
  sessionId: string;
  url: string;
}): string {
  return toolCallLine({
    monotonicId: opts.monotonicId,
    sessionId: opts.sessionId,
    content: [
      {
        type: "content",
        content: {
          type: "resource_link",
          uri: opts.url,
          name: "preview",
        },
      },
    ],
    locations: [{ path: opts.url }],
  });
}

// session.permission_request line — mirrors supervisor/src/types.ts exactly:
// the tool surface lives under `toolCall` (NOT `update`) and carries no
// `sessionUpdate` discriminant. When `url` is given it is embedded as a
// resource_link uri + locations[].path (preview); otherwise it is a plain
// command (log).
function permissionRequestLine(opts: {
  monotonicId: number;
  sessionId: string;
  url?: string;
}): string {
  const content = opts.url
    ? [
        {
          type: "content",
          content: { type: "resource_link", uri: opts.url, name: "preview" },
        },
      ]
    : [{ type: "content", content: { type: "text", text: "rm -rf build" } }];

  return JSON.stringify({
    type: "session.permission_request",
    sessionId: opts.sessionId,
    monotonicId: opts.monotonicId,
    requestId: "req-1",
    options: [],
    toolCall: {
      toolCallId: `call-${opts.monotonicId}`,
      title: opts.url ? "Open preview" : "Run command",
      kind: "execute",
      status: "pending",
      content,
      locations: opts.url ? [{ path: opts.url }] : [],
    },
  });
}

// A tool_call whose ONLY url-looking string sits under a `text` key (not under
// uri/url/path) — by contract this is a `log`, never a `preview`.
function bareTextUrlToolCallLine(opts: {
  monotonicId: number;
  sessionId: string;
  url: string;
}): string {
  return toolCallLine({
    monotonicId: opts.monotonicId,
    sessionId: opts.sessionId,
    content: [{ type: "content", content: { type: "text", text: opts.url } }],
    locations: [],
  });
}

async function getArtifacts(runId: string): Promise<ArtifactInstance[]> {
  return (await db
    .select()
    .from(schema.artifactInstances)
    .where(
      eq(schema.artifactInstances.runId, runId),
    )) as unknown as ArtifactInstance[];
}

async function getCursor(
  runId: string,
): Promise<ArtifactProjectionCursor | undefined> {
  const rows = (await db
    .select()
    .from(schema.artifactProjectionCursors)
    .where(
      and(
        eq(schema.artifactProjectionCursors.runId, runId),
        eq(schema.artifactProjectionCursors.scope, "run"),
      ),
    )) as unknown as ArtifactProjectionCursor[];

  return rows[0];
}

async function getRunStatus(runId: string): Promise<string> {
  const rows = (await db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as Array<{ status: string }>;

  return rows[0].status;
}

describe("T5.1: artifact projector core (projectRunEvents)", () => {
  // Behaviors 1 + 2 + 3: reads run-scoped log, derives log+preview artifacts
  // with deterministic PKs, plain chunk derives nothing, monotonic_id stored.
  it("derives a log artifact for tool calls, a preview artifact for preview URLs, and nothing for agent_message_chunk", async () => {
    const s = await seedRun();

    const previewUrl = "https://preview.example.com/run-42/index.html";

    await writeFile(
      s.eventsLogPath,
      [
        toolCallLine({ monotonicId: 1, sessionId: s.sessionA }),
        agentMessageChunkLine({ monotonicId: 2, sessionId: s.sessionA }),
        previewToolCallLine({
          monotonicId: 3,
          sessionId: s.sessionA,
          url: previewUrl,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await projectRunEvents(s.runId, { db });

    const artifacts = await getArtifacts(s.runId);

    // The agent_message_chunk (monotonicId 2) derives NO artifact.
    const chunkArtifact = artifacts.find((a) => a.monotonicId === 2);

    expect(chunkArtifact).toBeUndefined();

    // monotonicId 1 → log artifact with deterministic PK and producer=projector.
    const logArtifact = artifacts.find(
      (a) => a.id === projectorArtifactId({ runId: s.runId, monotonicId: 1 }),
    );

    expect(logArtifact).toBeDefined();
    expect(logArtifact?.kind).toBe("log");
    expect(logArtifact?.producer).toBe("projector");
    expect(logArtifact?.monotonicId).toBe(1);

    // monotonicId 3 → preview artifact with deterministic PK and producer=projector.
    const previewArtifact = artifacts.find(
      (a) => a.id === projectorArtifactId({ runId: s.runId, monotonicId: 3 }),
    );

    expect(previewArtifact).toBeDefined();
    expect(previewArtifact?.kind).toBe("preview");
    expect(previewArtifact?.producer).toBe("projector");
    expect(previewArtifact?.monotonicId).toBe(3);

    // Two derived rows; cursor advanced past the chunk to the max monotonicId.
    expect(result.projected).toBe(2);
    expect(result.lastMonotonicId).toBe(3);
  });

  // Behavior 4: idempotent re-run — no duplicate rows.
  it("is idempotent: re-running over the same file produces no duplicate rows", async () => {
    const s = await seedRun();

    await writeFile(
      s.eventsLogPath,
      [
        toolCallLine({ monotonicId: 1, sessionId: s.sessionA }),
        toolCallLine({ monotonicId: 2, sessionId: s.sessionA }),
      ].join("\n") + "\n",
      "utf8",
    );

    await projectRunEvents(s.runId, { db });
    const afterFirst = await getArtifacts(s.runId);

    await projectRunEvents(s.runId, { db });
    const afterSecond = await getArtifacts(s.runId);

    expect(afterFirst.length).toBe(2);
    expect(afterSecond.length).toBe(2);
    expect(new Set(afterSecond.map((a) => a.id)).size).toBe(2);
  });

  // Behavior 5: crash-safe replay — reset cursor to 0, re-run re-derives the
  // SAME rows (same PKs, no duplicates, final cursor back at max).
  it("crash-safe replay: resetting the cursor re-derives the same rows with no duplicates", async () => {
    const s = await seedRun();

    await writeFile(
      s.eventsLogPath,
      [
        toolCallLine({ monotonicId: 1, sessionId: s.sessionA }),
        toolCallLine({ monotonicId: 2, sessionId: s.sessionA }),
        toolCallLine({ monotonicId: 3, sessionId: s.sessionA }),
      ].join("\n") + "\n",
      "utf8",
    );

    await projectRunEvents(s.runId, { db });
    const afterFirst = await getArtifacts(s.runId);
    const idsAfterFirst = new Set(afterFirst.map((a) => a.id));

    // Simulate a crash that committed rows but lost the cursor advance:
    // manually reset last_monotonic_id back to 0.
    await db
      .update(schema.artifactProjectionCursors)
      .set({ lastMonotonicId: 0 })
      .where(eq(schema.artifactProjectionCursors.runId, s.runId));

    const replay = await projectRunEvents(s.runId, { db });
    const afterReplay = await getArtifacts(s.runId);
    const idsAfterReplay = new Set(afterReplay.map((a) => a.id));

    expect(afterReplay.length).toBe(afterFirst.length);
    expect(idsAfterReplay).toEqual(idsAfterFirst);

    const cursor = await getCursor(s.runId);

    expect(cursor?.lastMonotonicId).toBe(3);
    expect(replay.lastMonotonicId).toBe(3);
  });

  // Behavior 6: cursor two-phase advance — last_monotonic_id = highest in file,
  // events_log_path set to the resolved path.
  it("advances the per-run cursor to the highest monotonicId and records the events log path", async () => {
    const s = await seedRun();

    await writeFile(
      s.eventsLogPath,
      [
        toolCallLine({ monotonicId: 5, sessionId: s.sessionA }),
        agentMessageChunkLine({ monotonicId: 6, sessionId: s.sessionA }),
        toolCallLine({ monotonicId: 7, sessionId: s.sessionA }),
      ].join("\n") + "\n",
      "utf8",
    );

    await projectRunEvents(s.runId, { db });

    const cursor = await getCursor(s.runId);

    expect(cursor).toBeDefined();
    expect(cursor?.scope).toBe("run");
    expect(cursor?.lastMonotonicId).toBe(7);
    expect(cursor?.eventsLogPath).toBe(s.eventsLogPath);
  });

  // Behavior 7: poison event — malformed JSON AND unknown sessionUpdate shape
  // are SKIPPED (no artifact, no throw) but the cursor STILL advances past them.
  it("skips a malformed line and an unknown-shape update without stalling the cursor", async () => {
    const s = await seedRun();

    const garbageUpdateLine = JSON.stringify({
      type: "session.update",
      sessionId: s.sessionA,
      monotonicId: 2,
      update: { sessionUpdate: "totally_unknown_shape", junk: 123 },
    });

    await writeFile(
      s.eventsLogPath,
      [
        toolCallLine({ monotonicId: 1, sessionId: s.sessionA }),
        "{ this is not valid json at all",
        garbageUpdateLine,
        toolCallLine({ monotonicId: 4, sessionId: s.sessionA }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await projectRunEvents(s.runId, { db });

    const artifacts = await getArtifacts(s.runId);

    // Only the two valid tool calls derive artifacts.
    expect(artifacts.length).toBe(2);
    expect(artifacts.find((a) => a.monotonicId === 2)).toBeUndefined();

    // Cursor advanced past the poison lines to the highest valid monotonicId.
    const cursor = await getCursor(s.runId);

    expect(cursor?.lastMonotonicId).toBe(4);
    expect(result.lastMonotonicId).toBe(4);
  });

  // Behavior 8: attribution — matched sessionId → node_attempt_id populated +
  // node_id/attempt; unmatched sessionId → node_attempt_id NULL (run-level).
  it("attributes derived artifacts to the matching node_attempt by acp_session_id; unmatched → run-level NULL", async () => {
    const s = await seedRun();

    const unknownSession = `acp-session-${randomUUID()}`;

    await writeFile(
      s.eventsLogPath,
      [
        // matches attempt B (sessionB → node checks)
        toolCallLine({ monotonicId: 1, sessionId: s.sessionB }),
        // matches no attempt → run-level
        toolCallLine({ monotonicId: 2, sessionId: unknownSession }),
      ].join("\n") + "\n",
      "utf8",
    );

    await projectRunEvents(s.runId, { db });

    const artifacts = await getArtifacts(s.runId);

    const matched = artifacts.find((a) => a.monotonicId === 1);

    expect(matched).toBeDefined();
    expect(matched?.nodeAttemptId).toBe(s.attemptBId);
    expect(matched?.nodeId).toBe("checks");
    expect(matched?.attempt).toBe(1);

    const unmatched = artifacts.find((a) => a.monotonicId === 2);

    expect(unmatched).toBeDefined();
    expect(unmatched?.nodeAttemptId).toBeNull();
  });

  // Behavior 9: never drives runs.status.
  it("never updates runs.status", async () => {
    const s = await seedRun();

    await writeFile(
      s.eventsLogPath,
      [
        toolCallLine({ monotonicId: 1, sessionId: s.sessionA }),
        toolCallLine({ monotonicId: 2, sessionId: s.sessionA }),
      ].join("\n") + "\n",
      "utf8",
    );

    const before = await getRunStatus(s.runId);

    await projectRunEvents(s.runId, { db });

    const after = await getRunStatus(s.runId);

    expect(before).toBe("Running");
    expect(after).toBe("Running");
  });

  // ---- G1 (BUG-TIED, MUST go RED): session.permission_request derivation ----
  // The supervisor emits permission requests with the tool surface under
  // `toolCall` and NO `update.sessionUpdate` discriminant. The projector must
  // still derive evidence from them.

  // G1(a): permission request carrying a preview URL → ONE preview artifact.
  it("G1a: derives a preview artifact from a session.permission_request carrying a preview URL", async () => {
    const s = await seedRun();

    const previewUrl = "https://preview.example.com/perm/index.html";

    await writeFile(
      s.eventsLogPath,
      permissionRequestLine({
        monotonicId: 1,
        sessionId: s.sessionA,
        url: previewUrl,
      }) + "\n",
      "utf8",
    );

    const result = await projectRunEvents(s.runId, { db });

    const artifacts = await getArtifacts(s.runId);

    expect(artifacts).toHaveLength(1);

    const artifact = artifacts.find(
      (a) => a.id === projectorArtifactId({ runId: s.runId, monotonicId: 1 }),
    );

    expect(artifact).toBeDefined();
    expect(artifact?.kind).toBe("preview");
    expect(artifact?.producer).toBe("projector");
    expect(artifact?.monotonicId).toBe(1);
    expect(result.projected).toBe(1);
  });

  // G1(b): plain-command permission request (no URL) → ONE log artifact.
  it("G1b: derives a log artifact from a plain-command session.permission_request", async () => {
    const s = await seedRun();

    await writeFile(
      s.eventsLogPath,
      permissionRequestLine({ monotonicId: 1, sessionId: s.sessionA }) + "\n",
      "utf8",
    );

    const result = await projectRunEvents(s.runId, { db });

    const artifacts = await getArtifacts(s.runId);

    expect(artifacts).toHaveLength(1);

    const artifact = artifacts.find(
      (a) => a.id === projectorArtifactId({ runId: s.runId, monotonicId: 1 }),
    );

    expect(artifact).toBeDefined();
    expect(artifact?.kind).toBe("log");
    expect(artifact?.producer).toBe("projector");
    expect(artifact?.monotonicId).toBe(1);
    expect(result.projected).toBe(1);
  });

  // ---- G7 (BUG-TIED, MUST go RED): bare-text URL is log, not preview ----
  // Only URLs under uri/url/path keys are previews. A URL that appears only as
  // free text under a `text` key is NOT a preview link → must be a log.
  it("G7: a tool_call with a URL only under a text key derives a log artifact, not preview", async () => {
    const s = await seedRun();

    await writeFile(
      s.eventsLogPath,
      bareTextUrlToolCallLine({
        monotonicId: 1,
        sessionId: s.sessionA,
        url: "https://example.com/x",
      }) + "\n",
      "utf8",
    );

    await projectRunEvents(s.runId, { db });

    const artifacts = await getArtifacts(s.runId);

    expect(artifacts).toHaveLength(1);

    const artifact = artifacts.find(
      (a) => a.id === projectorArtifactId({ runId: s.runId, monotonicId: 1 }),
    );

    expect(artifact).toBeDefined();
    expect(artifact?.kind).toBe("log");
    expect(artifact?.producer).toBe("projector");
  });

  // ---- G2 (COVERAGE): multi-session attribution across interleaved lines ----
  it("G2: attributes each derived artifact to the correct attempt when sessions interleave", async () => {
    const s = await seedRun();

    await writeFile(
      s.eventsLogPath,
      [
        toolCallLine({ monotonicId: 1, sessionId: s.sessionA }),
        toolCallLine({ monotonicId: 2, sessionId: s.sessionB }),
        toolCallLine({ monotonicId: 3, sessionId: s.sessionA }),
        toolCallLine({ monotonicId: 4, sessionId: s.sessionB }),
      ].join("\n") + "\n",
      "utf8",
    );

    await projectRunEvents(s.runId, { db });

    const artifacts = await getArtifacts(s.runId);

    const byMono = new Map(artifacts.map((a) => [a.monotonicId, a]));

    // sessionA → attempt A (node implement); sessionB → attempt B (node checks)
    expect(byMono.get(1)?.nodeAttemptId).toBe(s.attemptAId);
    expect(byMono.get(1)?.nodeId).toBe("implement");
    expect(byMono.get(1)?.attempt).toBe(1);

    expect(byMono.get(2)?.nodeAttemptId).toBe(s.attemptBId);
    expect(byMono.get(2)?.nodeId).toBe("checks");

    expect(byMono.get(3)?.nodeAttemptId).toBe(s.attemptAId);
    expect(byMono.get(3)?.nodeId).toBe("implement");

    expect(byMono.get(4)?.nodeAttemptId).toBe(s.attemptBId);
    expect(byMono.get(4)?.nodeId).toBe("checks");
  });

  // ---- G3 (COVERAGE): events file not found → no-op, no throw ----
  it("G3: returns {projected:0} and does not throw when the events file is absent", async () => {
    const s = await seedRun();

    // Deliberately write NO events file.
    const result = await projectRunEvents(s.runId, { db });

    expect(result.projected).toBe(0);

    const artifacts = await getArtifacts(s.runId);

    expect(artifacts).toHaveLength(0);

    // A cursor may be created (load-or-create) but must not advance past 0.
    const cursor = await getCursor(s.runId);

    if (cursor) {
      expect(cursor.lastMonotonicId).toBe(0);
    }
  });

  // ---- G4 (COVERAGE): empty / blank-only file → no-op, cursor unchanged ----
  it("G4: an empty file and a blank-lines-only file derive nothing and leave the cursor at zero", async () => {
    const empty = await seedRun();

    await writeFile(empty.eventsLogPath, "", "utf8");

    const emptyResult = await projectRunEvents(empty.runId, { db });

    expect(emptyResult.projected).toBe(0);
    expect(emptyResult.lastMonotonicId).toBe(0);
    expect(await getArtifacts(empty.runId)).toHaveLength(0);

    const emptyCursor = await getCursor(empty.runId);

    expect(emptyCursor?.lastMonotonicId).toBe(0);

    const blanks = await seedRun();

    await writeFile(blanks.eventsLogPath, "\n   \n\n\t\n", "utf8");

    const blankResult = await projectRunEvents(blanks.runId, { db });

    expect(blankResult.projected).toBe(0);
    expect(blankResult.lastMonotonicId).toBe(0);
    expect(await getArtifacts(blanks.runId)).toHaveLength(0);

    const blankCursor = await getCursor(blanks.runId);

    expect(blankCursor?.lastMonotonicId).toBe(0);
  });

  // ---- G5 (COVERAGE): duplicate monotonicId in one batch → one row ----
  it("G5: two lines with the same monotonicId upsert to exactly one row (no crash)", async () => {
    const s = await seedRun();

    await writeFile(
      s.eventsLogPath,
      [
        toolCallLine({
          monotonicId: 1,
          sessionId: s.sessionA,
          toolCallId: "first",
        }),
        toolCallLine({
          monotonicId: 1,
          sessionId: s.sessionA,
          toolCallId: "second",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await projectRunEvents(s.runId, { db });

    const artifacts = await getArtifacts(s.runId);

    const atPk = artifacts.filter(
      (a) => a.id === projectorArtifactId({ runId: s.runId, monotonicId: 1 }),
    );

    expect(atPk).toHaveLength(1);
    expect(artifacts).toHaveLength(1);
    expect(result.lastMonotonicId).toBe(1);
  });
});
