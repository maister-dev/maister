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

export type TranscriptPageMessage = TranscriptMessage & {
  preview?: { originalBytes: number; fullContentHref: string };
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
      .regex(/^-?\d{1,19}$/)
      .refine(
        (value) =>
          /^-?\d{1,19}$/.test(value) &&
          BigInt(value) >= -9223372036854775808n &&
          BigInt(value) <= 9223372036854775807n,
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
type Metadata = Position & {
  role: TranscriptMessage["role"];
  bytes: number;
  wireBytes: number;
};

export const TRANSCRIPT_PAGE_BYTES = 380 * 1024;
// Preview SQL limits the total extracted text to 1,504 characters. This bound
// includes UTF-8, JSON escaping twice (payload inside content), and metadata.
const PREVIEW_MESSAGE_BYTES = 16 * 1024;

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
    ? sql`(${position.event}::bigint,${position.prompt}::boolean,${position.sequence}::int,${position.id}::text)`
    : sql`(${position.createdAt}::timestamptz,${position.sequence}::int,${position.id}::text)`;
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
    ((query.before !== undefined ||
      query.after !== undefined ||
      query.anchor !== undefined) &&
      query.limit === undefined) ||
    (query.before !== undefined && query.after !== undefined) ||
    (query.windowBefore !== undefined) !== (query.windowAfter !== undefined) ||
    (query.windowBefore !== undefined &&
      (query.before !== undefined || query.after !== undefined)) ||
    (query.anchor !== undefined &&
      (query.anchor.length === 0 ||
        query.anchor.length > 512 ||
        query.before !== undefined ||
        query.after !== undefined ||
        query.windowBefore !== undefined))
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
  const beforePosition =
    query.before === undefined
      ? null
      : decode(query.before, runId, node, attemptId, "before");
  const afterPosition =
    query.after === undefined
      ? null
      : decode(query.after, runId, node, attemptId, "after");
  const lowerPosition =
    query.windowBefore === undefined
      ? null
      : decode(query.windowBefore, runId, node, attemptId, "lower");
  const upperPosition =
    query.windowAfter === undefined
      ? null
      : decode(query.windowAfter, runId, node, attemptId, "upper");

  if (empty.incompatibility || (node && !attemptId)) {
    if (query.anchor !== undefined) throw invalid("invalid_anchor");

    return empty;
  }
  const scope = sql`run_id=${runId} ${node ? sql`AND node_attempt_id=${attemptId}` : sql``}`;
  const cursorIds = [
    ...new Set(
      [beforePosition, afterPosition, lowerPosition, upperPosition].flatMap(
        (position) => (position ? [position.id] : []),
      ),
    ),
  ];
  const currentCursorRows =
    cursorIds.length === 0
      ? []
      : (
          await db.execute<Position>(
            sql`SELECT id,to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",${node ? sql`coalesce(first_supervisor_event_id,supervisor_event_id,'0')` : sql`'0'`} AS event,(prompt_dispatch_key IS NOT NULL) AS prompt,sequence FROM run_messages WHERE ${scope} AND id IN (${sql.join(
              cursorIds.map((id) => sql`${id}`),
              sql`,`,
            )})`,
          )
        ).rows;
  const currentPositions = new Map(
    currentCursorRows.map((row) => [row.id, row]),
  );
  const resolvePosition = (position: Position | null): Position | null => {
    if (position === null) return null;
    const current = currentPositions.get(position.id);

    if (current === undefined) throw invalid("cursor_record_missing");

    return current;
  };
  // Prompt horizons may be explicitly corrected after late event ingestion.
  // Resolve each scoped ID in this repeatable-read snapshot, rather than use
  // an obsolete tuple from a previously issued cursor.
  const before = resolvePosition(beforePosition);
  const after = resolvePosition(afterPosition);
  const lower = resolvePosition(lowerPosition);
  const upper = resolvePosition(upperPosition);
  const anchors =
    query.anchor === undefined
      ? null
      : await db.execute<Position>(
          sql`SELECT id,to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",${node ? sql`coalesce(first_supervisor_event_id,supervisor_event_id,'0')` : sql`'0'`} AS event,(prompt_dispatch_key IS NOT NULL) AS prompt,sequence FROM run_messages WHERE ${scope} AND id=${query.anchor} LIMIT 1`,
        );
  const anchor = anchors?.rows[0] ?? null;

  if (query.anchor !== undefined && anchor === null)
    throw invalid("invalid_anchor");
  const order = node
    ? sql`(coalesce(first_supervisor_event_id,supervisor_event_id,'0')::bigint,(prompt_dispatch_key IS NOT NULL),sequence,id)`
    : sql`(created_at,sequence,id)`;
  const bounds = sql`${before ? sql`AND ${order}<${tuple(before, node)}` : sql``} ${after ? sql`AND ${order}>${tuple(after, node)}` : sql``} ${lower && upper ? sql`AND ${order}>=LEAST(${tuple(lower, node)},${tuple(upper, node)}) AND ${order}<=GREATEST(${tuple(lower, node)},${tuple(upper, node)})` : sql``} ${anchor ? sql`AND ${order}>=${tuple(anchor, node)}` : sql``}`;
  const ascending = after !== null || lower !== null || anchor !== null;
  const rows = await db.execute<Metadata>(
    sql`SELECT id,role,to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",${node ? sql`coalesce(first_supervisor_event_id,supervisor_event_id,'0')` : sql`'0'`} AS event,(prompt_dispatch_key IS NOT NULL) AS prompt,sequence,octet_length(content)::int AS bytes,CASE WHEN octet_length(content)>${TRANSCRIPT_PAGE_BYTES} THEN octet_length(content)+2 ELSE octet_length(to_json(content)::text) END::int AS "wireBytes" FROM run_messages WHERE ${scope} ${bounds} ORDER BY ${node ? sql`coalesce(first_supervisor_event_id,supervisor_event_id,'0')::bigint ${ascending ? sql`ASC` : sql`DESC`},(prompt_dispatch_key IS NOT NULL) ${ascending ? sql`ASC` : sql`DESC`},` : sql`created_at ${ascending ? sql`ASC` : sql`DESC`},`} sequence ${ascending ? sql`ASC` : sql`DESC`},id ${ascending ? sql`ASC` : sql`DESC`} LIMIT ${limit}`,
  );
  const usage = await readUsage(db, scope, node);
  const envelope: TranscriptPage = { ...empty, usage };
  const encode = (position: Position, direction: Cursor["direction"]): string =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        run: runId,
        node,
        attempt: attemptId,
        direction,
        position: positionOf(position),
      } satisfies Cursor),
    ).toString("base64url");
  const pageBoundary = (first: Position, last: Position): TranscriptPage => ({
    ...envelope,
    // false is one byte longer than true, making this a conservative envelope
    // until the existence queries below determine the actual flags.
    hasEarlier: false,
    hasLater: false,
    beforeCursor: encode(first, "before"),
    afterCursor: encode(last, "after"),
    window: { before: encode(first, "lower"), after: encode(last, "upper") },
  });
  const admitted: { row: Metadata; preview: boolean }[] = [];
  let messageBytes = 0;

  // Admit in the database's traversal direction. In particular the initial
  // DESC read spends its budget on the newest records, not the oldest of 100.
  for (const row of rows.rows) {
    const fullBytes =
      Buffer.byteLength(JSON.stringify(messageOf(row, ""))) - 2 + row.wireBytes;
    const individualEnvelope = Buffer.byteLength(
      JSON.stringify(pageBoundary(row, row)),
    );
    const preview = fullBytes + individualEnvelope > TRANSCRIPT_PAGE_BYTES;
    const size = preview ? PREVIEW_MESSAGE_BYTES : fullBytes;
    const first = ascending ? (admitted[0]?.row ?? row) : row;
    const last = ascending ? row : (admitted[0]?.row ?? row);
    const responseBytes =
      Buffer.byteLength(JSON.stringify(pageBoundary(first, last))) +
      messageBytes +
      size +
      admitted.length;

    // A cumulative limit is a page boundary, never a reason to replace an
    // otherwise complete record with an empty or partial preview.
    if (responseBytes > TRANSCRIPT_PAGE_BYTES) break;
    admitted.push({ row, preview });
    messageBytes += size;
  }
  if (!admitted.length) return envelope;
  const chronological = ascending ? admitted : admitted.toReversed();
  const messages = await readMessageBodies(db, runId, chronological, attemptId);
  const first = chronological[0].row;
  const last = chronological.at(-1)!.row;
  const counts = await db.execute<{ earlier: boolean; later: boolean }>(
    sql`SELECT EXISTS(SELECT 1 FROM run_messages WHERE ${scope} AND ${order}<${tuple(first, node)}) AS earlier, EXISTS(SELECT 1 FROM run_messages WHERE ${scope} AND ${order}>${tuple(last, node)}) AS later`,
  );
  const page: TranscriptPage = {
    ...pageBoundary(first, last),
    messages,
    hasEarlier: counts.rows[0].earlier,
    hasLater: counts.rows[0].later,
  };

  if (Buffer.byteLength(JSON.stringify(page)) > TRANSCRIPT_PAGE_BYTES)
    throw new MaisterError(
      "PRECONDITION",
      "Transcript page exceeded its byte budget",
      {
        details: {
          reason: "transcript_page_budget_exceeded",
          runId,
          messageCount: messages.length,
        },
      },
    );

  return page;
}

function positionOf(row: Position): Position {
  return {
    id: row.id,
    createdAt: row.createdAt,
    event: row.event,
    prompt: row.prompt,
    sequence: row.sequence,
  };
}

function messageOf(row: Metadata, content: string): TranscriptPageMessage {
  return { id: row.id, role: row.role, content, createdAt: row.createdAt };
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

/** Build valid payload previews in Postgres without transferring the full record. */
function previewContent(): SQL {
  const json = sql`CASE WHEN pg_input_is_valid(m.content, 'jsonb') THEN m.content::jsonb ELSE '{}'::jsonb END`;

  return sql`CASE
    WHEN m.role IN ('user','assistant') THEN left(m.content,1024)
    WHEN m.role='tool' THEN jsonb_build_object(
      'v',1,'kind','tool',
      'name',left(coalesce((${json})->>'name','tool'),128),
      'toolKind',left(coalesce((${json})->>'toolKind','other'),64),
      'status',left(coalesce((${json})->>'status','pending'),32),
      'arg',left(coalesce((${json})->>'arg',''),256),
      'rawInput',null,
      'result',left(coalesce((${json})->>'result',''),1024)
    )::text
    WHEN (${json})->>'kind'='thought' THEN jsonb_build_object('v',1,'kind','thought','text',left(coalesce((${json})->>'text',''),1024))::text
    WHEN (${json})->>'kind'='permission' THEN jsonb_build_object('v',1,'kind','permission','prompt',left(coalesce((${json})->>'prompt',''),1024))::text
    ELSE jsonb_build_object('v',1,'kind',left(coalesce((${json})->>'kind','system'),64))::text
  END`;
}

async function readMessageBodies(
  db: ReadDb,
  runId: string,
  records: { row: Metadata; preview: boolean }[],
  attemptId: string | null,
): Promise<TranscriptPageMessage[]> {
  const bodies = await db.execute<{ id: string; content: string }>(
    sql`SELECT m.id,CASE WHEN a.preview THEN ${previewContent()} ELSE m.content END AS content FROM run_messages m JOIN (VALUES ${sql.join(
      records.map(({ row, preview }) => sql`(${row.id},${preview}::boolean)`),
      sql`,`,
    )}) AS a(id,preview) ON a.id=m.id WHERE m.run_id=${runId}`,
  );
  const content = new Map(bodies.rows.map((row) => [row.id, row.content]));

  return records.map(({ row, preview }): TranscriptPageMessage => {
    const body = content.get(row.id);

    if (body === undefined)
      throw new MaisterError(
        "PRECONDITION",
        "Transcript record disappeared during a snapshot read",
        {
          details: {
            reason: "transcript_message_missing",
            runId,
            messageId: row.id,
          },
        },
      );
    const message = messageOf(row, body);

    return preview
      ? {
          ...message,
          preview: {
            originalBytes: row.bytes,
            fullContentHref: `/api/runs/${runId}/transcript/messages/${encodeURIComponent(row.id)}${attemptId ? `?attempt=${encodeURIComponent(attemptId)}` : ""}`,
          },
        }
      : message;
  });
}
