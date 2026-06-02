import "server-only";

import type { ArtifactLocator } from "@/lib/db/schema";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  projectorArtifactId,
  recordArtifact,
} from "@/lib/flows/graph/artifact-store";
import { runtimeRoot } from "@/lib/instance-config";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches the store/ledger idiom).
const { runs, projects, nodeAttempts, artifactProjectionCursors } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "artifact-projector",
  level: process.env.LOG_LEVEL ?? "info",
});

type Attribution = {
  nodeAttemptId: string;
  nodeId: string;
  attempt: number;
};

type Derivation = {
  kind: "log" | "preview";
  locator: ArtifactLocator;
  uri: string | null;
};

const HTTP_URL = /^https?:\/\/\S+$/i;

// Recursively scan a parsed value for the first http(s) URL reached via a key
// named `uri`/`url`/`path` (covers content[] resource_link uri and
// locations[].path). A URL sitting under any other key (e.g. free `text`) is
// NOT a preview link — by contract that derives a log, not a preview.
function findPreviewUrl(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findPreviewUrl(item);

      if (hit) return hit;
    }

    return null;
  }

  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        (key === "uri" || key === "url" || key === "path") &&
        typeof v === "string" &&
        HTTP_URL.test(v)
      ) {
        return v;
      }

      const hit = findPreviewUrl(v);

      if (hit) return hit;
    }
  }

  return null;
}

function shortLogSummary(update: Record<string, unknown>): string {
  const title = typeof update.title === "string" ? update.title : undefined;
  const toolCallId =
    typeof update.toolCallId === "string" ? update.toolCallId : undefined;
  const status = typeof update.status === "string" ? update.status : undefined;

  return [title, toolCallId, status].filter(Boolean).join(" · ") || "tool_call";
}

// Classify a tool-call surface (ACP toolCall with title/toolCallId/status/
// content/locations) into a preview-or-log derivation.
function deriveFromToolCall(toolCall: Record<string, unknown>): Derivation {
  const previewUrl = findPreviewUrl(toolCall);

  if (previewUrl) {
    return {
      kind: "preview",
      locator: { kind: "inline", text: previewUrl },
      uri: previewUrl,
    };
  }

  return {
    kind: "log",
    locator: { kind: "inline", text: shortLogSummary(toolCall) },
    uri: null,
  };
}

// Classify a single parsed event line into a derivation, or null when it
// derives nothing (chunk / non-deriving). Throws only when a session.update
// carries an unknown sessionUpdate shape, so the caller can WARN + skip while
// still advancing. A well-formed permission line never throws.
function deriveFromLine(line: Record<string, unknown>): Derivation | null {
  const type = line.type;

  // session.permission_request carries the tool surface under `toolCall` with
  // NO sessionUpdate discriminant — treat it directly as a tool call.
  if (type === "session.permission_request") {
    const toolCall = line.toolCall;

    if (!toolCall || typeof toolCall !== "object") {
      return null;
    }

    return deriveFromToolCall(toolCall as Record<string, unknown>);
  }

  if (type !== "session.update") {
    return null;
  }

  const inner = line.update;

  if (!inner || typeof inner !== "object") {
    return null;
  }

  const update = inner as Record<string, unknown>;
  const sessionUpdate = update.sessionUpdate;

  if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
    return deriveFromToolCall(update);
  }

  // Known non-tool shape (e.g. agent_message_chunk) → derive nothing.
  if (
    sessionUpdate === "agent_message_chunk" ||
    sessionUpdate === "agent_thought_chunk" ||
    sessionUpdate === "user_message_chunk" ||
    sessionUpdate === "plan" ||
    sessionUpdate === "available_commands_update" ||
    sessionUpdate === "current_mode_update"
  ) {
    return null;
  }

  throw new Error(`unknown sessionUpdate shape: ${String(sessionUpdate)}`);
}

async function loadOrCreateCursor(
  d: Db,
  runId: string,
  eventsLogPath: string,
): Promise<number> {
  const rows = await d
    .select()
    .from(artifactProjectionCursors)
    .where(
      and(
        eq(artifactProjectionCursors.runId, runId),
        eq(artifactProjectionCursors.scope, "run"),
      ),
    )
    .limit(1);

  const existing = rows[0] as { lastMonotonicId: number } | undefined;

  if (existing) {
    return existing.lastMonotonicId ?? 0;
  }

  // Race-safe create: two concurrent first-time callers must not throw on the
  // (run_id, scope) unique constraint. onConflictDoNothing + re-select returns
  // the canonical row whichever caller won. (FOR-UPDATE serialization: T5.2.)
  await d
    .insert(artifactProjectionCursors)
    .values({
      id: runId,
      runId,
      scope: "run",
      eventsLogPath,
      lastMonotonicId: 0,
      status: "idle",
    })
    .onConflictDoNothing();

  const created = await d
    .select()
    .from(artifactProjectionCursors)
    .where(
      and(
        eq(artifactProjectionCursors.runId, runId),
        eq(artifactProjectionCursors.scope, "run"),
      ),
    )
    .limit(1);

  return (
    (created[0] as { lastMonotonicId: number } | undefined)?.lastMonotonicId ??
    0
  );
}

export async function projectRunEvents(
  runId: string,
  opts?: { db?: Db },
): Promise<{ projected: number; lastMonotonicId: number }> {
  const d: Db = opts?.db ?? getDb();

  // 1. Resolve the events-log path via project slug join.
  const slugRows = await d
    .select({ slug: projects.slug })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(runs.id, runId))
    .limit(1);

  const slug = (slugRows[0] as { slug: string } | undefined)?.slug;

  if (!slug) {
    throw new Error(`projectRunEvents: no project slug for run ${runId}`);
  }

  const eventsLogPath = path.join(
    runtimeRoot(),
    ".maister",
    slug,
    "runs",
    runId,
    "run.events.jsonl",
  );

  // 2. Load-or-create the per-run cursor.
  const lastMonotonicId = await loadOrCreateCursor(d, runId, eventsLogPath);

  // 3. Read the events file; missing file → no-op (return cursor value).
  let raw: string;

  try {
    raw = await readFile(eventsLogPath, "utf8");
  } catch {
    return { projected: 0, lastMonotonicId };
  }

  // 4. Attribution map: acp_session_id → node attempt.
  const attemptRows = await d
    .select({
      id: nodeAttempts.id,
      nodeId: nodeAttempts.nodeId,
      attempt: nodeAttempts.attempt,
      acpSessionId: nodeAttempts.acpSessionId,
    })
    .from(nodeAttempts)
    .where(eq(nodeAttempts.runId, runId));

  const attribution = new Map<string, Attribution>();

  for (const row of attemptRows as Array<{
    id: string;
    nodeId: string;
    attempt: number;
    acpSessionId: string | null;
  }>) {
    if (row.acpSessionId) {
      attribution.set(row.acpSessionId, {
        nodeAttemptId: row.id,
        nodeId: row.nodeId,
        attempt: row.attempt,
      });
    }
  }

  // 5. Parse line-by-line; build the derived-artifact batch and track maxSeen.
  type DerivedRow = {
    id: string;
    monotonicId: number;
    derivation: Derivation;
    sessionId: string | undefined;
  };

  const derived: DerivedRow[] = [];
  let maxSeen = lastMonotonicId;

  for (const rawLine of raw.split("\n")) {
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) continue;

    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      log.warn({ runId, reason: "unparseable line" }, "projector skip line");
      continue;
    }

    const monotonicId = parsed.monotonicId;

    if (typeof monotonicId !== "number") {
      log.warn({ runId, reason: "missing monotonicId" }, "projector skip line");
      continue;
    }

    if (monotonicId <= lastMonotonicId) {
      continue;
    }

    if (monotonicId > maxSeen) maxSeen = monotonicId;

    let derivation: Derivation | null;

    try {
      derivation = deriveFromLine(parsed);
    } catch (err) {
      log.warn(
        { runId, monotonicId, reason: (err as Error).message },
        "projector unknown shape, deriving nothing",
      );
      continue;
    }

    if (!derivation) continue;

    derived.push({
      id: projectorArtifactId({ runId, monotonicId }),
      monotonicId,
      derivation,
      sessionId:
        typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
    });
  }

  // 6. Two-phase ordering in ONE transaction: upsert all artifacts, then advance
  // the cursor (the after-side idempotency marker).
  await d.transaction(async (tx: Db) => {
    for (const row of derived) {
      const attr = row.sessionId ? attribution.get(row.sessionId) : undefined;

      await recordArtifact(
        {
          id: row.id,
          runId,
          nodeAttemptId: attr?.nodeAttemptId ?? null,
          nodeId: attr?.nodeId ?? null,
          attempt: attr?.attempt ?? null,
          artifactDefId: null,
          kind: row.derivation.kind,
          producer: "projector",
          locator: row.derivation.locator,
          uri: row.derivation.uri,
          monotonicId: row.monotonicId,
          validity: "current",
          visibility: "internal",
          retention: "run",
        },
        tx,
      );
    }

    await tx
      .update(artifactProjectionCursors)
      .set({
        lastMonotonicId: maxSeen,
        status: "caught_up",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(artifactProjectionCursors.runId, runId),
          eq(artifactProjectionCursors.scope, "run"),
        ),
      );
  });

  log.info(
    { runId, projected: derived.length, lastMonotonicId: maxSeen },
    "projector batch applied",
  );

  return { projected: derived.length, lastMonotonicId: maxSeen };
}
