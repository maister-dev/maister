import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { prepareDiffSummary } from "@/lib/diff/prepare";
import { compileManifest } from "@/lib/flows/graph/compile";
import { resolveManifest } from "@/lib/flows/graph/current-node-kind";
import { runtimeRoot } from "@/lib/instance-config";
import { interpretScratchUpdate } from "@/lib/scratch-runs/transcript";
import { diffRunWorkspace, resolveBaseRef } from "@/lib/worktree";

const { gateResults, nodeAttempts, projects, workspaces } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
type Db = NodePgDatabase<typeof schema>;

export interface InboxGateChip {
  gateId: string;
  kind:
    | "command_check"
    | "skill_check"
    | "ai_judgment"
    | "artifact_required"
    | "external_check"
    | "human_review";
  mode: "blocking" | "advisory";
  status:
    | "pending"
    | "running"
    | "passed"
    | "failed"
    | "stale"
    | "skipped"
    | "overridden";
}

export interface InboxCardContext {
  lastAgentMessage: { text: string; at: string } | null;
  gates: InboxGateChip[];
  diff: { files: number; additions: number; deletions: number } | null;
  progress: { done: number; total: number } | null;
}

export interface InboxContextRun {
  id: string;
  projectId: string;
  currentStepId: string | null;
  flowRevisionId: string | null;
  flowId: string | null;
}

const MAX_MESSAGE_CHARS = 1000;

// Coalesce the trailing contiguous run of `agent_message_chunk` text from a run's
// `run.events.jsonl` — i.e. the last thing the agent said. A tool call resets the
// buffer (the agent moved on); thought/usage chunks are ignored.
export function extractLastAgentMessage(rawJsonl: string): string | null {
  let buffer = "";

  for (const line of rawJsonl.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || !trimmed.includes("session.update")) continue;

    let parsed: { type?: unknown; update?: unknown };

    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (parsed.type !== "session.update") continue;
    const interpreted = interpretScratchUpdate(parsed.update);

    if (!interpreted) continue;

    if (interpreted.kind === "text") buffer += interpreted.text;
    else if (
      interpreted.kind === "tool_call" ||
      interpreted.kind === "tool_update"
    )
      buffer = "";
  }

  const text = buffer.trim();

  if (text.length === 0) return null;

  return text.length > MAX_MESSAGE_CHARS
    ? `${text.slice(0, MAX_MESSAGE_CHARS)}…`
    : text;
}

async function loadLastAgentMessage(
  client: Db,
  run: InboxContextRun,
): Promise<InboxCardContext["lastAgentMessage"]> {
  try {
    const slugRows = await client
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, run.projectId));
    const slug = slugRows[0]?.slug;

    if (!slug) return null;

    const eventsLogPath = path.join(
      runtimeRoot(),
      ".maister",
      slug,
      "runs",
      run.id,
      "run.events.jsonl",
    );
    const raw = await readFile(eventsLogPath, "utf8");
    const text = extractLastAgentMessage(raw);

    if (!text) return null;

    const st = await stat(eventsLogPath);

    return { text, at: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

async function loadCurrentNodeGates(
  client: Db,
  run: InboxContextRun,
): Promise<InboxGateChip[]> {
  if (!run.currentStepId) return [];

  try {
    const attemptRows = await client
      .select({ id: nodeAttempts.id })
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.runId, run.id),
          eq(nodeAttempts.nodeId, run.currentStepId),
        ),
      )
      .orderBy(desc(nodeAttempts.attempt))
      .limit(1);
    const attemptId = attemptRows[0]?.id;

    if (!attemptId) return [];

    return await client
      .select({
        gateId: gateResults.gateId,
        kind: gateResults.kind,
        mode: gateResults.mode,
        status: gateResults.status,
      })
      .from(gateResults)
      .where(eq(gateResults.nodeAttemptId, attemptId));
  } catch {
    return [];
  }
}

async function loadProgress(
  client: Db,
  run: InboxContextRun,
): Promise<InboxCardContext["progress"]> {
  try {
    const manifest = await resolveManifest(client, {
      flowRevisionId: run.flowRevisionId,
      flowId: run.flowId,
    });

    if (!manifest) return null;
    const total = compileManifest(manifest).nodes.size;

    if (total === 0) return null;

    const doneRows = await client
      .select({ nodeId: nodeAttempts.nodeId })
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.runId, run.id),
          eq(nodeAttempts.status, "Succeeded"),
        ),
      );
    const done = new Set(doneRows.map((r) => r.nodeId)).size;

    return { done: Math.min(done, total), total };
  } catch {
    return null;
  }
}

async function loadDiffSummary(
  client: Db,
  run: InboxContextRun,
): Promise<InboxCardContext["diff"]> {
  try {
    const wsRows = await client
      .select()
      .from(workspaces)
      .where(eq(workspaces.runId, run.id));
    const workspace = wsRows[0];

    if (!workspace || workspace.removedAt) return null;

    const projRows = await client
      .select({ mainBranch: projects.mainBranch })
      .from(projects)
      .where(eq(projects.id, run.projectId));
    const project = projRows[0];

    if (!project) return null;

    const base =
      workspace.baseCommit ??
      (await resolveBaseRef({
        worktreePath: workspace.worktreePath,
        branch: workspace.branch,
        mainBranch: project.mainBranch,
      }));
    const { text, truncated } = await diffRunWorkspace({
      projectRepoPath: workspace.worktreePath,
      baseCommit: base,
      branch: workspace.branch,
    });
    const summary = prepareDiffSummary(text, truncated);

    return {
      files: summary.files.length,
      additions: summary.files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
      deletions: summary.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
    };
  } catch {
    return null;
  }
}

// The run is loaded + authorized (`readBoard`) by the caller. Each field is read
// independently and degrades to null/[] on a missing or unreadable source — the
// route never 500s for a missing peek (M17/inbox-card-redesign).
export async function getInboxCardContext(
  run: InboxContextRun,
): Promise<InboxCardContext> {
  const client = getDb() as unknown as Db;

  const [lastAgentMessage, gates, progress, diff] = await Promise.all([
    loadLastAgentMessage(client, run),
    loadCurrentNodeGates(client, run),
    loadProgress(client, run),
    loadDiffSummary(client, run),
  ]);

  return { lastAgentMessage, gates, diff, progress };
}
