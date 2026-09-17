import "server-only";

import type { ArtifactLocator } from "@/lib/db/schema";
import type { ExecutionEvent } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";
import pino from "pino";

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
import { prepareArtifactContent } from "@/lib/execution-host/events/session-content";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches the store/ledger idiom).
const { runs, nodeAttempts } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "artifact-projector",
  level: process.env.LOG_LEVEL ?? "info",
});

// The ACP `sessionUpdate` variants that carry no artifact. `tool_call` and
// `tool_call_update` are the only ones that can derive at all, and since
// TRC-01 they do so only when the surface carries an http(s) preview URL;
// everything else the protocol defines is transcript or telemetry. Taken from
// the SDK's own schema rather
// than discovered one incident at a time — `usage_update` alone poisoned six
// consumers. Vendor adapters add frames beyond the spec, so an unlisted one
// warns and skips (below) instead of stopping the run's projection.
const NON_DERIVING_SESSION_UPDATES: ReadonlySet<string> = new Set([
  // @agentclientprotocol/sdk 1.4.0 schema.
  "agent_message_chunk",
  "agent_thought_chunk",
  "available_commands_update",
  "compaction_summary_chunk",
  "compaction_update",
  "config_option_update",
  "current_mode_update",
  "plan",
  "plan_removed",
  "plan_update",
  "session_info_update",
  "usage_update",
  "user_message_chunk",
  // Vendor extensions: claude's model-reconciliation advisory.
  "model_advisory",
]);

/** An ACP frame this projector does not classify. Adapters keep adding
 * telemetry shapes; that is not a corrupt event, so it never poisons. */
class UnknownSessionUpdateShape extends Error {
  constructor(readonly shape: string) {
    super(`unknown sessionUpdate shape: ${shape}`);
    this.name = "UnknownSessionUpdateShape";
  }
}

export const canonicalArtifactProjector: ExecutionEventProjector = {
  consumerName: CANONICAL_PROJECTION_CONSUMERS.artifact,
  prepare: prepareArtifactContent,
  project: projectCanonicalArtifactEvent,
};

type Attribution = {
  nodeAttemptId: string;
  nodeId: string;
  attempt: number;
};

// TRC-01: a tool surface derives evidence only when it carries something a
// reviewer can open. `preview` is the only kind this projector produces.
type Derivation = {
  kind: "preview";
  locator: ArtifactLocator;
  uri: string;
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

// Classify a tool-call surface (ACP toolCall with title/toolCallId/status/
// content/locations). A surface with no openable preview URL derives NOTHING:
// what the tool did is already carried, and carried better, by the Trace plane
// (`run_messages`) — name, kind, status, arguments, result. The `log` artifact
// this used to synthesize held only `title · toolCallId · status`, a strictly
// lossier duplicate that nonetheless grew to 96% of one install's evidence
// graph and buried the artifacts a reviewer actually needed.
function deriveFromToolCall(
  toolCall: Record<string, unknown>,
): Derivation | null {
  const previewUrl = findPreviewUrl(toolCall);

  if (!previewUrl) return null;

  return {
    kind: "preview",
    locator: { kind: "inline", text: previewUrl },
    uri: previewUrl,
  };
}

// Classify a single parsed event line into a derivation, or null when it
// derives nothing (chunk / non-deriving). Throws UnknownSessionUpdateShape only
// when a session.update carries an unknown sessionUpdate discriminant, so the
// caller can WARN + skip while still advancing. A well-formed permission line
// never throws.
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

  if (
    typeof sessionUpdate === "string" &&
    NON_DERIVING_SESSION_UPDATES.has(sessionUpdate)
  ) {
    return null;
  }

  throw new UnknownSessionUpdateShape(String(sessionUpdate));
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
    // A shape this projector does not know derives no artifact, and poisoning
    // the consumer over it would stop EVERY later event in the run — the
    // failure mode this arm exists to avoid. Warn with the discriminant (the
    // only thing needed to allow-list it) and advance.
    if (error instanceof UnknownSessionUpdateShape) {
      log.warn(
        {
          runId: event.runId,
          eventId: event.id,
          sessionUpdate: error.shape,
        },
        "artifact projector skipped an unknown session update shape",
      );

      return;
    }
    throw permanentCanonicalProjectionError(
      error instanceof Error
        ? `canonical artifact event has an invalid shape: ${error.message}`
        : "canonical artifact event has an invalid shape",
    );
  }
  // The rehydration behind this decision is NOT free: `prepareArtifactContent`
  // pulls each offloaded payload's bytes back before classification, because a
  // preview URL can only be found inside them. Skipping the fetch would lose
  // previews silently, so the cost is logged rather than avoided.
  log.debug(
    {
      runId: event.runId,
      eventId: event.id,
      sessionUpdate:
        typeof event.payload?.update === "object" && event.payload.update
          ? (event.payload.update as Record<string, unknown>).sessionUpdate
          : event.eventType,
      payloadBytes: event.payloadBytes,
      derived: derivation ? "preview" : null,
    },
    "artifact projector classified an event",
  );
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
