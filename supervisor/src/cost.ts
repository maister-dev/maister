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
  projectSlug?: string;
  runId?: string;
  stepId?: string;
  nodeAttemptId?: string;
};

export type AttachCostOptions = {
  sessionId: string;
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
  const onEvent = (event: SessionEvent) => {
    if (event.type !== "session.line") return;

    const dynamicContext = opts.getContext?.() ?? {};
    const record = extractCost(event.line, opts.sessionId, {
      projectSlug: opts.projectSlug,
      runId: opts.runId,
      stepId: opts.stepId,
      nodeAttemptId: opts.nodeAttemptId,
      ...dynamicContext,
    });

    if (!record) return;

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
  };

  opts.emitter.on(SESSION_EVENT_CHANNEL, onEvent);

  return {
    costPath,
    detach: async () => {
      opts.emitter.off(SESSION_EVENT_CHANNEL, onEvent);
      await new Promise<void>((resolveP) => stream.end(() => resolveP()));
    },
  };
}

export function extractCost(
  line: string,
  sessionId: string,
  context: CostAttributionContext = {},
): CostRecord | null {
  if (!line.includes('"usage"')) return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const usage = findKeyObject(parsed, "usage", MAX_TRAVERSAL_DEPTH);

  if (!usage) return null;

  const record: CostRecord = {
    ts: new Date().toISOString(),
    sessionId,
  };

  if (context.projectSlug) record.projectSlug = context.projectSlug;
  if (context.runId) record.runId = context.runId;
  if (context.stepId) record.stepId = context.stepId;
  if (context.nodeAttemptId) record.nodeAttemptId = context.nodeAttemptId;

  if (typeof usage.input_tokens === "number") {
    record.input_tokens = usage.input_tokens;
  }
  if (typeof usage.output_tokens === "number") {
    record.output_tokens = usage.output_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === "number") {
    record.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    record.cache_read_input_tokens = usage.cache_read_input_tokens;
  }

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

  return record;
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
