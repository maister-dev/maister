import "server-only";

import type { ArtifactLocator } from "@/lib/db/schema";
import type { ExecutionEvent } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  canonicalProjectorArtifactId,
  recordArtifact,
} from "@/lib/flows/graph/artifact-store";
import {
  ExecutionEventProjectionError,
  projectExecutionEvents,
  type ExecutionEventProjector,
} from "@/lib/execution-host/events/projector";
import { CANONICAL_PROJECTION_CONSUMERS } from "@/lib/execution-host/events/projection-consumers";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches the store/ledger idiom).
const { runs, nodeAttempts } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export const canonicalArtifactProjector: ExecutionEventProjector = {
  consumerName: CANONICAL_PROJECTION_CONSUMERS.artifact,
  project: projectCanonicalArtifactEvent,
};

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

function permanentCanonicalProjectionError(
  message: string,
): ExecutionEventProjectionError {
  return new ExecutionEventProjectionError(message, true);
}

function canonicalEventLine(event: ExecutionEvent): Record<string, unknown> {
  const payload = event.payload ?? {};

  if (event.eventType === "session.update") {
    if (!payload.update || typeof payload.update !== "object") {
      throw permanentCanonicalProjectionError(
        "canonical session.update event is missing its update payload",
      );
    }
  }
  if (event.eventType === "session.permission_request") {
    if (!payload.toolCall || typeof payload.toolCall !== "object") {
      throw permanentCanonicalProjectionError(
        "canonical permission event is missing its tool-call payload",
      );
    }
  }

  return {
    type: event.eventType,
    update: payload.update,
    toolCall: payload.toolCall,
  };
}

async function canonicalAttribution(
  tx: Db,
  event: ExecutionEvent,
): Promise<Attribution | undefined> {
  const nodeAttemptId = event.payload?.nodeAttemptId;

  if (nodeAttemptId === undefined || nodeAttemptId === null) return undefined;
  if (typeof nodeAttemptId !== "string" || nodeAttemptId.length === 0) {
    throw permanentCanonicalProjectionError(
      "canonical artifact event has an invalid node-attempt binding",
    );
  }
  const attempts = await tx
    .select({
      id: nodeAttempts.id,
      nodeId: nodeAttempts.nodeId,
      attempt: nodeAttempts.attempt,
    })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.id, nodeAttemptId),
        eq(nodeAttempts.runId, event.runId),
      ),
    )
    .limit(1);
  const attempt = attempts[0] as
    | { id: string; nodeId: string; attempt: number }
    | undefined;

  if (!attempt) {
    throw permanentCanonicalProjectionError(
      "canonical artifact event names a node attempt outside its run",
    );
  }

  return {
    nodeAttemptId: attempt.id,
    nodeId: attempt.nodeId,
    attempt: attempt.attempt,
  };
}

async function projectCanonicalArtifactEvent(
  tx: Db,
  event: ExecutionEvent,
): Promise<void> {
  // The one-shot pre-B4 importer preserves historical supervisor events under
  // a deterministic `legacy_import` identity. They are immutable audit input,
  // not a live host authority, but retain the same line/tool-call derivations.
  if (event.source !== "host" && event.source !== "legacy_import") return;
  let derivation: Derivation | null;

  try {
    derivation = deriveFromLine(canonicalEventLine(event));
  } catch (error) {
    if (error instanceof ExecutionEventProjectionError) throw error;
    throw permanentCanonicalProjectionError(
      error instanceof Error
        ? `canonical artifact event has an invalid shape: ${error.message}`
        : "canonical artifact event has an invalid shape",
    );
  }
  if (!derivation) return;

  const attribution = await canonicalAttribution(tx, event);

  await recordArtifact(
    {
      id: canonicalProjectorArtifactId({
        runId: event.runId,
        eventId: event.id,
      }),
      runId: event.runId,
      nodeAttemptId: attribution?.nodeAttemptId ?? null,
      nodeId: attribution?.nodeId ?? null,
      attempt: attribution?.attempt ?? null,
      artifactDefId: null,
      kind: derivation.kind,
      producer: "projector",
      locator: derivation.locator,
      uri: derivation.uri,
      // Canonical run order is an unbounded BIGINT. The legacy field is an
      // integer and must not silently truncate it; the event-id locator above
      // is the idempotency identity for canonical replay.
      monotonicId: null,
      validity: "current",
      visibility: "internal",
      retention: "run",
    },
    tx,
  );
}

async function projectCanonicalRunEvents(
  d: Db,
  runId: string,
): Promise<{ projected: number; lastMonotonicId: number }> {
  const result = await projectExecutionEvents({
    db: d,
    runId,
    projector: canonicalArtifactProjector,
  });

  // The public result predates canonical BIGINT run ordering. Keep its legacy
  // field stable for callers while the durable consumer cursor owns replay.
  return { projected: result.projected, lastMonotonicId: 0 };
}

export async function projectRunEvents(
  runId: string,
  opts?: { db?: Db },
): Promise<{ projected: number; lastMonotonicId: number }> {
  const d: Db = opts?.db ?? getDb();

  const runRows = await d
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  const run = runRows[0] as { id: string } | undefined;

  if (!run) {
    throw new Error(`projectRunEvents: run does not exist: ${runId}`);
  }

  return projectCanonicalRunEvents(d, runId);
}
