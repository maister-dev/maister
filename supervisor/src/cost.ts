import type { EventEmitter } from "node:events";
import type { Logger } from "pino";
import type { SessionEvent } from "./types";

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { SESSION_EVENT_CHANNEL } from "./registry";

const MAX_TRAVERSAL_DEPTH = 8;

export type CostRecord = {
  ts: string;
  sessionId: string;
  // M42 (ADR-114): logical Flow session this spend belongs to ("default" for a
  // single-session run) — lets a multi-session run attribute cost per session.
  sessionName?: string;
  projectSlug?: string;
  runId?: string;
  stepId?: string;
  nodeAttemptId?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  // M8 T13: marks entries written by a supervisor session that was
  // started via `--resume <id>`. Ops can compute the cache-creation
  // tax (M0 finding: ~$0.28 per cross-process resume) via
  // `sum(cache_creation_input_tokens) WHERE resumed=true`. Pure
  // observability — no control-plane decision branches on this flag.
  resumed?: boolean;
};

export type CostAttributionContext = {
  sessionName?: string;
  projectSlug?: string;
  runId?: string;
  stepId?: string;
  nodeAttemptId?: string;
};

export type AttachCostOptions = {
  sessionId: string;
  sessionName?: string;
  runtimeRoot: string;
  projectSlug: string;
  runId: string;
  stepId?: string;
  nodeAttemptId?: string;
  getContext?: () => CostAttributionContext;
  emitter: EventEmitter;
  logger: Logger;
  // M8 T13: true when the session was spawned via `--resume <id>`.
  // Stamped onto every appended cost.jsonl record. Default false.
  resumed?: boolean;
};

export type CostHandle = {
  costPath: string;
  detach: () => Promise<void>;
};

export async function attachCost(opts: AttachCostOptions): Promise<CostHandle> {
  const costPath = resolve(
    opts.runtimeRoot,
    ".maister",
    opts.projectSlug,
    "runs",
    opts.runId,
    "cost.jsonl",
  );

  await mkdir(dirname(costPath), { recursive: true });
  const stream = createWriteStream(costPath, { flags: "a" });

  const resumed = Boolean(opts.resumed);
  const recorder = createTurnUsageRecorder((record) => {
    if (resumed) record.resumed = true;

    stream.write(`${JSON.stringify(record)}\n`);
    opts.logger.debug(
      {
        sessionId: opts.sessionId,
        runId: record.runId,
        stepId: record.stepId,
        nodeAttemptId: record.nodeAttemptId,
        cache_creation: record.cache_creation_input_tokens,
        input: record.input_tokens,
        output: record.output_tokens,
        resumed,
      },
      "cost-append",
    );
  });
  const onEvent = (event: SessionEvent) => {
    if (event.type !== "session.line") return;

    const dynamicContext = opts.getContext?.() ?? {};
    const extracted = extractCostWithSource(event.line, opts.sessionId, {
      sessionName: opts.sessionName,
      projectSlug: opts.projectSlug,
      runId: opts.runId,
      stepId: opts.stepId,
      nodeAttemptId: opts.nodeAttemptId,
      ...dynamicContext,
    });

    if (!extracted) return;

    recorder.offer(extracted.record, extracted.source);
  };

  opts.emitter.on(SESSION_EVENT_CHANNEL, onEvent);

  return {
    costPath,
    detach: async () => {
      opts.emitter.off(SESSION_EVENT_CHANNEL, onEvent);
      // Flush a streaming-only turn (one that never emitted a canonical
      // result.usage) before closing — otherwise its spend would be lost.
      recorder.flush();
      await new Promise<void>((resolveP) => stream.end(() => resolveP()));
    },
  };
}

// The canonical per-turn total is the ACP adapter's end-turn JSON-RPC
// `result.usage`. A per-message / sub-agent `usage` object nested elsewhere in
// the stream (e.g. a Task tool response inside a `session/update`) is a
// component already subsumed by that total. The classification is by POSITION
// (under the top-level `result` or not), not snake/camel — so it holds for any
// adapter that answers a prompt with a JSON-RPC `result.usage`.
export type UsageSource = "result" | "stream";

// Back-compat thin wrapper — returns just the record (used by tests + callers
// that do not need turn-dedup). `attachCost` uses `extractCostWithSource`.
export function extractCost(
  line: string,
  sessionId: string,
  context: CostAttributionContext = {},
): CostRecord | null {
  return extractCostWithSource(line, sessionId, context)?.record ?? null;
}

export function extractCostWithSource(
  line: string,
  sessionId: string,
  context: CostAttributionContext = {},
): { record: CostRecord; source: UsageSource } | null {
  if (!line.includes('"usage"')) return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const located = locateUsage(parsed);

  if (!located) return null;

  const record: CostRecord = {
    ts: new Date().toISOString(),
    sessionId,
  };

  if (context.sessionName) record.sessionName = context.sessionName;
  if (context.projectSlug) record.projectSlug = context.projectSlug;
  if (context.runId) record.runId = context.runId;
  if (context.stepId) record.stepId = context.stepId;
  if (context.nodeAttemptId) record.nodeAttemptId = context.nodeAttemptId;

  // Accept BOTH the Anthropic snake_case usage and the ACP adapter's camelCase
  // shape (inputTokens / outputTokens / cachedWriteTokens = cache-creation /
  // cachedReadTokens = cache-read). Per field, snake_case wins so a usage object
  // carrying both shapes is never double-counted (T-D2). Without this the
  // camelCase end-turn usage was dropped and every node session after the first
  // recorded zero tokens.
  const input = numberField(located.usage, "input_tokens", "inputTokens");
  const output = numberField(located.usage, "output_tokens", "outputTokens");
  const cacheCreation = numberField(
    located.usage,
    "cache_creation_input_tokens",
    "cachedWriteTokens",
  );
  const cacheRead = numberField(
    located.usage,
    "cache_read_input_tokens",
    "cachedReadTokens",
  );

  if (input !== undefined) record.input_tokens = input;
  if (output !== undefined) record.output_tokens = output;
  if (cacheCreation !== undefined) {
    record.cache_creation_input_tokens = cacheCreation;
  }
  if (cacheRead !== undefined) record.cache_read_input_tokens = cacheRead;

  if (
    record.input_tokens === undefined &&
    record.output_tokens === undefined &&
    record.cache_creation_input_tokens === undefined &&
    record.cache_read_input_tokens === undefined
  ) {
    return null;
  }

  const model = findKeyString(parsed, "model", MAX_TRAVERSAL_DEPTH);

  if (model) record.model = model;

  return { record, source: located.source };
}

// The end-turn JSON-RPC `result.usage` is the canonical per-turn total; any
// other `usage` (a per-message or nested sub-agent object) is a stream
// component already reflected in it.
function locateUsage(
  parsed: unknown,
): { usage: Record<string, unknown>; source: UsageSource } | null {
  const root = plainObject(parsed);
  const resultUsage = plainObject(plainObject(root?.result)?.usage);

  if (resultUsage) return { usage: resultUsage, source: "result" };

  const nested = findKeyObject(parsed, "usage", MAX_TRAVERSAL_DEPTH);

  if (nested) return { usage: nested, source: "stream" };

  return null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Collapse the per-session cost stream so each turn contributes exactly one
// record. A "result" usage (the adapter's end-turn total) is authoritative and
// written immediately, discarding any buffered "stream" usage from the same
// turn — that nested usage is already part of the result total, so writing both
// would double-count (owner decision: result.usage canonical per turn, never
// count both). A "stream" usage is buffered, not written, until either a result
// supersedes it (discard) or the session closes with no result for that turn
// (flush — a streaming-only turn is still recorded, never lost).
export function createTurnUsageRecorder(emit: (record: CostRecord) => void): {
  offer: (record: CostRecord, source: UsageSource) => void;
  flush: () => void;
} {
  let pendingStream: CostRecord | null = null;

  return {
    offer(record, source) {
      if (source === "result") {
        pendingStream = null;
        emit(record);

        return;
      }
      pendingStream = record;
    },
    flush() {
      if (!pendingStream) return;
      emit(pendingStream);
      pendingStream = null;
    },
  };
}

// Read a numeric usage field, preferring the canonical snake_case key and
// falling back to the camelCase alias (per field → no double-count).
function numberField(
  usage: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): number | undefined {
  if (typeof usage[snakeKey] === "number") return usage[snakeKey] as number;
  if (typeof usage[camelKey] === "number") return usage[camelKey] as number;

  return undefined;
}

function findKeyObject(
  obj: unknown,
  key: string,
  depthLimit: number,
): Record<string, unknown> | null {
  if (depthLimit <= 0 || obj === null || typeof obj !== "object") return null;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findKeyObject(item, key, depthLimit - 1);

      if (found) return found;
    }

    return null;
  }

  const rec = obj as Record<string, unknown>;

  if (
    key in rec &&
    rec[key] !== null &&
    typeof rec[key] === "object" &&
    !Array.isArray(rec[key])
  ) {
    return rec[key] as Record<string, unknown>;
  }

  for (const value of Object.values(rec)) {
    const found = findKeyObject(value, key, depthLimit - 1);

    if (found) return found;
  }

  return null;
}

function findKeyString(
  obj: unknown,
  key: string,
  depthLimit: number,
): string | null {
  if (depthLimit <= 0 || obj === null || typeof obj !== "object") return null;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findKeyString(item, key, depthLimit - 1);

      if (found) return found;
    }

    return null;
  }

  const rec = obj as Record<string, unknown>;

  if (key in rec && typeof rec[key] === "string") {
    return rec[key];
  }

  for (const value of Object.values(rec)) {
    const found = findKeyString(value, key, depthLimit - 1);

    if (found) return found;
  }

  return null;
}
