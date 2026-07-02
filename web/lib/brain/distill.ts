import "server-only";

import type { BrainItemKind } from "./schema";

import { sql, type SQL } from "drizzle-orm";

import {
  getBrainEmbeddingClient,
  type OpenAiCompatibleClient,
} from "./openai-compatible";

import { getDb } from "@/lib/db/client";
import { validateStructuredOutput } from "@/lib/flows/output-schema";

// Project Brain (ADR-122) distillation. Builds a prompt from CONCRETE sources —
// the domain-event payload (ids + reason only) plus fetched review comments, the
// node_attempts rework chain, and the task title/prompt — then asks the
// distillation model for a structured lesson. NEVER depends on runs.summary
// (the column exists but is unpopulated — a known P0 gap). Schema-invalid output
// after one in-process retry yields null (the harvest consumer then skips it).

type DistillDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export interface DistillInput {
  kind: string;
  projectId: string;
  runId: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
}

export interface DistilledLesson {
  content: string;
  kind: BrainItemKind;
  tags: string[];
}

// The flows structured-output DSL (validateStructuredOutput grammar).
const LESSON_SCHEMA = {
  fields: [
    { name: "content", type: "string", required: true },
    {
      name: "kind",
      type: "enum",
      required: true,
      options: ["lesson", "observation", "state_fact"],
    },
    { name: "tags", type: "array", required: false },
  ],
};

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    const v = JSON.parse(cleaned);

    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

interface DistillContext {
  task: { title: string; prompt: string } | null;
  reviewComments: string[];
  reworkChain: Array<{ nodeId: string; attempt: number; from: string }>;
}

async function gatherContext(
  db: DistillDb,
  input: DistillInput,
): Promise<DistillContext> {
  let task: DistillContext["task"] = null;

  if (input.taskId) {
    const r = await db.execute(
      sql`SELECT title, prompt FROM tasks WHERE id = ${input.taskId}`,
    );

    if (r.rows[0]) {
      task = {
        title: String(r.rows[0].title ?? ""),
        prompt: String(r.rows[0].prompt ?? ""),
      };
    }
  }

  let reviewComments: string[] = [];
  let reworkChain: DistillContext["reworkChain"] = [];

  if (input.runId) {
    const rc = await db.execute(
      sql`SELECT body FROM review_comments WHERE run_id = ${input.runId} ORDER BY created_at ASC LIMIT 50`,
    );

    reviewComments = rc.rows.map((r) => String(r.body ?? ""));

    const na = await db.execute(
      sql`SELECT node_id, attempt, rework_from_node FROM node_attempts
          WHERE run_id = ${input.runId} AND rework_from_node IS NOT NULL
          ORDER BY started_at ASC LIMIT 50`,
    );

    reworkChain = na.rows.map((r) => ({
      nodeId: String(r.node_id ?? ""),
      attempt: Number(r.attempt ?? 0),
      from: String(r.rework_from_node ?? ""),
    }));
  }

  return { task, reviewComments, reworkChain };
}

export function buildDistillPrompt(
  input: DistillInput,
  ctx: DistillContext,
): string {
  const isGate = input.kind === "gate.failed";
  const lines: string[] = [
    "You distill a durable, reusable project LESSON from a run outcome, for a project-memory system.",
    'Return ONLY a JSON object: {"content": string, "kind": "lesson"|"observation"|"state_fact", "tags": string[]}.',
    "content: one concise, generalizable takeaway (<= 400 chars) a future run should know.",
    "kind: 'lesson' for a mistake-to-avoid, 'observation' for a noticed pattern, 'state_fact' for a durable project fact.",
    "tags: 0-5 short lowercase tags.",
    "",
    `## Event: ${input.kind}`,
  ];

  if (isGate) {
    lines.push(
      `Gate failed — kind=${String(input.payload.gateKind ?? "?")}, blocking=${String(input.payload.blocking ?? "?")}.`,
    );
  } else {
    lines.push(
      `Run terminal — reason=${String(input.payload.reason ?? "n/a")}, runKind=${String(input.payload.runKind ?? "flow")}.`,
    );
  }

  if (ctx.task) {
    lines.push(
      `## Task\nTitle: ${ctx.task.title}\nPrompt: ${truncate(ctx.task.prompt, 1000)}`,
    );
  }

  if (ctx.reviewComments.length > 0) {
    lines.push(
      `## Review comments\n${ctx.reviewComments.map((c) => `- ${truncate(c, 300)}`).join("\n")}`,
    );
  }

  if (ctx.reworkChain.length > 0) {
    lines.push(
      `## Rework chain\n${ctx.reworkChain
        .map(
          (r) =>
            `- node ${r.nodeId} attempt ${r.attempt} reworked from ${r.from}`,
        )
        .join("\n")}`,
    );
  }

  return lines.join("\n");
}

export async function distill(
  input: DistillInput,
  opts: { db?: DistillDb; client?: OpenAiCompatibleClient } = {},
): Promise<DistilledLesson | null> {
  const db = opts.db ?? (getDb() as unknown as DistillDb);
  const client =
    opts.client ??
    (await getBrainEmbeddingClient(
      db as unknown as Parameters<typeof getBrainEmbeddingClient>[0],
    ));

  const ctx = await gatherContext(db, input);
  const prompt = buildDistillPrompt(input, ctx);

  // Up to 2 attempts (one in-process retry). Invalid both times → null; the
  // harvest consumer logs + skips (a permanent failure, never a poison loop).
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await client.complete(prompt, { json: true });
    const parsed = tryParseJson(raw);

    if (!parsed) continue;

    const check = validateStructuredOutput(parsed, LESSON_SCHEMA);

    if (!check.ok) continue;

    const tags = Array.isArray(parsed.tags)
      ? parsed.tags
          .filter((t): t is string => typeof t === "string")
          .slice(0, 5)
      : [];

    return {
      content: String(parsed.content),
      kind: parsed.kind as BrainItemKind,
      tags,
    };
  }

  return null;
}
