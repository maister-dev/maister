import "server-only";

import type { SQL } from "drizzle-orm";
import type { TranscriptMessage } from "@/components/run-transcript/transcript-view";
import type { FlowManifestIncompatibility } from "@/lib/flows/manifest-parser";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";
import { CANONICAL_PROJECTION_CONSUMERS } from "@/lib/execution-host/events/projection-consumers";
import { loadRunManifest } from "@/lib/queries/run-manifest";
import { authorizePeekRun } from "@/lib/runs/peek-read-model";
import { projectRunTranscript } from "@/lib/runs/run-transcript-projector";

export type TranscriptPageMessage =
  | TranscriptMessage
  | {
      id: string;
      role: TranscriptMessage["role"];
      createdAt: string;
      kind: "bounded_preview";
      preview: string;
      originalBytes: number;
      truncated: true;
    };
export type TranscriptPage = {
  compatible: boolean;
  incompatibility: FlowManifestIncompatibility | null;
  messages: TranscriptPageMessage[];
  usage: { used: number; size: number } | null;
  attemptId: string | null;
  beforeCursor: string | null;
  afterCursor: string | null;
  hasEarlier: boolean;
  hasLater: boolean;
  window: { before: string | null; after: string | null };
  projection: {
    throughSequence: string | null;
    observedHead: string | null;
    state: "caught_up" | "pending";
    continuation: boolean;
  };
};
const positionSchema = z
  .object({
    id: z.string(),
    createdAt: z.string().datetime(),
    event: z
      .string()
      .regex(/^\d{1,19}$/)
      .refine(
        (value) =>
          /^\d{1,19}$/.test(value) && BigInt(value) <= 9223372036854775807n,
      ),
    prompt: z.boolean(),
    sequence: z.number().int().min(-2147483648).max(2147483647),
  })
  .strict();
const cursorSchema = z
  .object({
    version: z.literal(1),
    run: z.string().uuid(),
    node: z.string().nullable(),
    attempt: z.string().nullable(),
    direction: z.enum(["before", "after", "lower", "upper"]),
    position: positionSchema,
  })
  .strict();

type Cursor = z.infer<typeof cursorSchema>;
type Position = z.infer<typeof positionSchema>;
type Metadata = Position & { role: TranscriptMessage["role"]; bytes: number };

function invalid(reason = "invalid_cursor"): MaisterError {
  return new MaisterError("CONFIG", "Invalid transcript paging request", {
    details: { reason },
  });
}
function decode(
  raw: string,
  run: string,
  node: string | null,
  attempt: string | null,
  direction: Cursor["direction"],
): Position {
  if (raw.length > 2048 || !/^[\w-]+$/.test(raw)) throw invalid();
  let value: unknown;

  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const parsed = cursorSchema.safeParse(value);

  if (
    !parsed.success ||
    parsed.data.run !== run ||
    parsed.data.node !== node ||
    parsed.data.direction !== direction
  )
    throw invalid();
  if (parsed.data.attempt !== attempt)
    throw new MaisterError("CONFLICT", "Transcript attempt changed", {
      details: { reason: "transcript_attempt_changed" },
    });

  return parsed.data.position;
}
function tuple(position: Position, node: string | null): SQL {
  return node
    ? sql`(${position.event}::bigint,${position.prompt},${position.sequence},${position.id})`
    : sql`(${position.createdAt}::timestamptz,${position.sequence},${position.id})`;
}

export async function readTranscriptPage(
  userId: string,
  runId: string,
  query: Record<string, string>,
): Promise<TranscriptPage> {
  const access = await authorizePeekRun(userId, runId);

  if (!access.canReadTranscript)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Transcript requires repository read access",
    );
  const limit = query.limit === undefined ? 100 : Number(query.limit);

  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw invalid("invalid_limit");
  if (
    ((query.before !== undefined || query.after !== undefined) &&
      query.limit === undefined) ||
    (query.before !== undefined && query.after !== undefined) ||
    (query.windowBefore !== undefined) !== (query.windowAfter !== undefined) ||
    (query.windowBefore !== undefined &&
      (query.before !== undefined || query.after !== undefined))
  )
    throw invalid("invalid_query");
  const node = query.node ?? null;

  if (node === "") throw invalid("invalid_node");
  let incompatibility: FlowManifestIncompatibility | null = null;

  if (node !== null) {
    const loaded = await loadRunManifest(runId);

    if (!loaded) throw invalid("invalid_node");
    if (!loaded.compatible) incompatibility = loaded.incompatibility;
    else if (!compileManifest(loaded.manifest).nodes.has(node))
      throw invalid("invalid_node");
  } else if (access.run.runKind === "flow") throw invalid("node_required");
  const db = getDb();
  const projection = await projectCapturedHead(runId, query.through);
  const empty: TranscriptPage = {
    compatible: incompatibility === null,
    incompatibility,
    messages: [],
    usage: null,
    attemptId: null,
    beforeCursor: null,
    afterCursor: null,
    hasEarlier: false,
    hasLater: false,
    window: { before: null, after: null },
    projection,
  };

  return db.transaction(
    (tx) => readWindow(tx, { runId, node, query, limit, empty }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

type ReadDb = Pick<ReturnType<typeof getDb>, "execute">;
async function projectCapturedHead(
  runId: string,
  requestedHead: string | undefined,
): Promise<TranscriptPage["projection"]> {
  const db = getDb();
  const [{ rows: heads }, { rows: consumers }] = await Promise.all([
    db.execute<{ head: string | null }>(
      sql`SELECT max(run_sequence)::text AS head FROM execution_events WHERE run_id=${runId} AND ingest_disposition='accepted'`,
    ),
    db.execute<{ head: string | null; state: string }>(
      sql`SELECT last_run_sequence::text AS head,state FROM execution_event_consumers WHERE run_id=${runId} AND consumer_name=${CANONICAL_PROJECTION_CONSUMERS.transcript}`,
    ),
  ]);

  if (consumers[0]?.state === "poisoned")
    throw new MaisterError(
      "CONFLICT",
      "Transcript projection requires repair",
      { details: { reason: "transcript_projection_poisoned" } },
    );
  const actualHead = heads[0]?.head ?? null;

  if (
    requestedHead !== undefined &&
    (!/^\d{1,20}$/.test(requestedHead) ||
      actualHead === null ||
      BigInt(requestedHead) > BigInt(actualHead))
  )
    throw invalid("invalid_head");
  const observedHead = requestedHead ?? actualHead;
  let throughSequence = consumers[0]?.head ?? null;
  let progressed = false;

  for (
    let quantum = 0;
    quantum < 4 &&
    observedHead !== null &&
    (throughSequence === null ||
      BigInt(throughSequence) < BigInt(observedHead));
    quantum++
  ) {
    const summary = await projectRunTranscript(runId, {
      throughSequence: BigInt(observedHead),
    });

    if (summary.throughSequence === throughSequence) break;
    progressed = true;
    throughSequence = summary.throughSequence;
  }
  const pending =
    observedHead !== null &&
    (throughSequence === null ||
      BigInt(throughSequence) < BigInt(observedHead));
  const projection: TranscriptPage["projection"] = {
    throughSequence,
    observedHead,
    state: pending ? "pending" : "caught_up",
    continuation: pending && progressed,
  };

  return projection;
}

async function readWindow(
  db: ReadDb,
  input: {
    runId: string;
    node: string | null;
    query: Record<string, string>;
    limit: number;
    empty: TranscriptPage;
  },
): Promise<TranscriptPage> {
  const { runId, node, query, limit } = input;
  const attempts = node
    ? await db.execute<{ id: string }>(
        sql`SELECT id FROM node_attempts WHERE run_id=${runId} AND node_id=${node} ORDER BY attempt DESC LIMIT 1`,
      )
    : null;
  const attemptId = attempts?.rows[0]?.id ?? null;
  const empty: TranscriptPage = { ...input.empty, attemptId };
  // Decode even empty scopes so a stale attempt can never masquerade as empty history.
  const before =
    query.before === undefined
      ? null
      : decode(query.before, runId, node, attemptId, "before");
  const after =
    query.after === undefined
      ? null
      : decode(query.after, runId, node, attemptId, "after");
  const lower =
    query.windowBefore === undefined
      ? null
      : decode(query.windowBefore, runId, node, attemptId, "lower");
  const upper =
    query.windowAfter === undefined
      ? null
      : decode(query.windowAfter, runId, node, attemptId, "upper");

  if (empty.incompatibility || (node && !attemptId)) return empty;
  const scope = sql`run_id=${runId} ${node ? sql`AND node_attempt_id=${attemptId}` : sql``}`;
  const order = node
    ? sql`(coalesce(supervisor_event_id,'0')::bigint,(prompt_dispatch_key IS NOT NULL),sequence,id)`
    : sql`(created_at,sequence,id)`;
  const bounds = sql`${before ? sql`AND ${order}<${tuple(before, node)}` : sql``} ${after ? sql`AND ${order}>${tuple(after, node)}` : sql``} ${lower ? sql`AND ${order}>=${tuple(lower, node)}` : sql``} ${upper ? sql`AND ${order}<=${tuple(upper, node)}` : sql``}`;
  const ascending = after !== null || lower !== null;
  const rows = await db.execute<Metadata>(
    sql`SELECT id,role,to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",${node ? sql`coalesce(supervisor_event_id,'0')` : sql`'0'`} AS event,(prompt_dispatch_key IS NOT NULL) AS prompt,sequence,octet_length(content)::int AS bytes FROM run_messages WHERE ${scope} ${bounds} ORDER BY ${node ? sql`coalesce(supervisor_event_id,'0')::bigint ${ascending ? sql`ASC` : sql`DESC`},(prompt_dispatch_key IS NOT NULL) ${ascending ? sql`ASC` : sql`DESC`},` : sql`created_at ${ascending ? sql`ASC` : sql`DESC`},`} sequence ${ascending ? sql`ASC` : sql`DESC`},id ${ascending ? sql`ASC` : sql`DESC`} LIMIT ${limit}`,
  );
  const usage = await readUsage(db, scope, node);
  const metadata = ascending ? rows.rows : rows.rows.toReversed();

  if (!metadata.length) return { ...empty, usage };
  const positions = metadata.map((row): Position => ({
    id: row.id,
    createdAt: row.createdAt,
    event: row.event,
    prompt: row.prompt,
    sequence: row.sequence,
  }));
  const messages = await readMessageBodies(db, runId, metadata, positions);
  const first = positions[0];
  const last = positions.at(-1)!;
  const counts = await db.execute<{ earlier: boolean; later: boolean }>(
    sql`SELECT EXISTS(SELECT 1 FROM run_messages WHERE ${scope} AND ${order}<${tuple(first, node)}) AS earlier, EXISTS(SELECT 1 FROM run_messages WHERE ${scope} AND ${order}>${tuple(last, node)}) AS later`,
  );
  const encode = (position: Position, direction: Cursor["direction"]): string =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        run: runId,
        node,
        attempt: attemptId,
        direction,
        position,
      } satisfies Cursor),
    ).toString("base64url");

  return {
    ...empty,
    messages,
    usage,
    hasEarlier: counts.rows[0].earlier,
    hasLater: counts.rows[0].later,
    beforeCursor: counts.rows[0].earlier ? encode(first, "before") : null,
    afterCursor: counts.rows[0].later ? encode(last, "after") : null,
    window: { before: encode(first, "lower"), after: encode(last, "upper") },
  };
}

async function readUsage(
  db: ReadDb,
  scope: SQL,
  node: string | null,
): Promise<TranscriptPage["usage"]> {
  const validJson = sql`CASE WHEN pg_input_is_valid(content, 'jsonb') THEN content::jsonb ELSE '{}'::jsonb END`;
  const rows = await db.execute<{ used: unknown; size: unknown }>(
    sql`SELECT (${validJson})->'used' AS used, (${validJson})->'size' AS size FROM run_messages WHERE ${scope} AND role='system' AND (${validJson})->>'kind'='usage' ORDER BY ${node ? sql`coalesce(supervisor_event_id,'0')::bigint DESC,(prompt_dispatch_key IS NOT NULL) DESC,` : sql`created_at DESC,`} sequence DESC,id DESC LIMIT 1`,
  );
  const row = rows.rows[0];

  if (!row) return null;
  const parsed = z
    .object({
      used: z.number().int().nonnegative(),
      size: z.number().int().nonnegative(),
    })
    .safeParse({ used: row.used ?? 0, size: row.size ?? 0 });

  return parsed.success ? parsed.data : null;
}

async function readMessageBodies(
  db: ReadDb,
  runId: string,
  metadata: Metadata[],
  positions: Position[],
): Promise<TranscriptPageMessage[]> {
  let budget = 380 * 1024;
  const allocations = metadata.map((row) => {
    const full = row.bytes * 6 + 512 <= budget && row.bytes <= 65536;
    const cap = full
      ? row.bytes
      : Math.max(0, Math.min(4096, Math.floor((budget - 512) / 6)));

    budget -= cap * 6 + 512;

    return { row, full, cap };
  });
  const bodies = await db.execute<{ id: string; content: string }>(
    sql`SELECT m.id,left(m.content,a.cap) AS content FROM run_messages m JOIN (VALUES ${sql.join(
      allocations.map(({ row, cap }) => sql`(${row.id},${cap}::int)`),
      sql`,`,
    )}) AS a(id,cap) ON a.id=m.id WHERE m.run_id=${runId}`,
  );
  const content = new Map(bodies.rows.map((row) => [row.id, row.content]));
  const messages: TranscriptPageMessage[] = allocations.map(
    ({ row, full }, index) =>
      full
        ? {
            id: row.id,
            role: row.role,
            content: content.get(row.id)!,
            createdAt: positions[index].createdAt,
          }
        : {
            id: row.id,
            role: row.role,
            kind: "bounded_preview",
            preview: content.get(row.id)!,
            originalBytes: row.bytes,
            truncated: true,
            createdAt: positions[index].createdAt,
          },
  );

  return messages;
}
