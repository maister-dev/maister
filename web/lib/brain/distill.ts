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

// The instruction block. Kept as a named constant (not inlined) so a prompt
// revision is one obvious diff. Contract-critical rules: single takeaway,
// project-scoped (no run ids/paths), strict single-JSON-object output, and a
// kind rubric tied to how each kind decays (policy.ts). The worked example is
// one-shot — it shows the target shape without biasing the topic.
const DISTILL_INSTRUCTIONS = [
  "You are a senior engineer distilling ONE durable, reusable lesson from a completed run's outcome.",
  "It is stored in a project-memory system and recalled by FUTURE runs on this same project, so it must earn its place.",
  "",
  "A good memory item is:",
  "- Generalizable — a rule or pattern that transfers to future work, NOT a play-by-play of this run.",
  "- Actionable — a future agent can do something differently because of it.",
  "- Self-contained — understandable with no run/PR/branch ids, no absolute paths, no one-off names.",
  "",
  "Do NOT: restate the task; narrate step by step; include ids/paths/branch names; emit vague platitudes",
  '("write better code"); or bundle several takeaways — pick the single most useful one.',
  "",
  "Pick `kind` by what the item IS (it drives how the item decays):",
  "- lesson — a mistake-to-avoid or corrective rule learned from a failure/rework (TTL decay unless it recurs).",
  "- observation — a noticed pattern or tendency; a weaker signal (slower decay).",
  "- state_fact — a durable, currently-true project fact (a convention, constraint, or decision); does not decay until it changes.",
  "When the signal is weak or you are unsure, prefer `observation` over inventing a `lesson`.",
  "",
  "Identify the single most useful takeaway, then return ONLY one JSON object — no prose, no code fence:",
  '{"content": string, "kind": "lesson"|"observation"|"state_fact", "tags": string[]}',
  "- content: <= 400 chars, one takeaway, imperative or declarative.",
  '- tags: 0-5 short lowercase keywords (area/topic), e.g. "migrations", "auth", "tests".',
  "",
  "Example (shape only — do not copy the topic):",
  "Input — a review gate failed twice on a rename that broke downstream imports.",
  'Output — {"content":"When renaming an exported symbol, update every import in the same change; code that compiles locally can still break consumers.","kind":"lesson","tags":["refactor","imports"]}',
].join("\n");

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
    DISTILL_INSTRUCTIONS,
    "",
    "--- Run to distill ---",
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
