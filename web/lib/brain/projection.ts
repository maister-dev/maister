import "server-only";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import type { BrainProposalActor, BrainProposalKind } from "@/lib/brain/schema";
import type { SocialActor } from "@/lib/social/activity";

import { MaisterError } from "@/lib/errors";
import { createTask } from "@/lib/services/tasks";
import { applyTriageVerdict } from "@/lib/services/triage";

const log = pino({
  name: "brain:projection",
  level: process.env.LOG_LEVEL ?? "info",
});

type ProjectionDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export interface ProjectBrainProjectionInput {
  projectId: string;
  proposalId: string;
  kind: BrainProposalKind;
  draft: Record<string, unknown>;
  actor: BrainProposalActor;
}

export interface ProjectBrainProjectionResult {
  taskId: string;
  launchMode: "auto" | "manual";
}

function requiredString(
  draft: Record<string, unknown>,
  field: string,
): string {
  const value = draft[field];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MaisterError(
      "CONFIG",
      `Brain projection draft requires non-empty string field "${field}"`,
    );
  }

  return value.trim();
}

function draftContent(draft: Record<string, unknown>): string {
  const content = draft.content ?? draft.markdown;

  if (typeof content === "string" && content.trim().length > 0) {
    return content.trim();
  }

  const body = draft.body;

  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    typeof (body as Record<string, unknown>).markdown === "string"
  ) {
    const markdown = (body as Record<string, unknown>).markdown as string;

    if (markdown.trim().length > 0) return markdown.trim();
  }

  throw new MaisterError(
    "CONFIG",
    'Brain projection draft requires "content", "markdown", or "body.markdown"',
  );
}

function taskTitle(kind: BrainProposalKind, draft: Record<string, unknown>): string {
  return `Project Brain ${kind}: ${requiredString(draft, "title")}`;
}

function projectionPrompt(args: {
  kind: BrainProposalKind;
  path: string;
  content: string;
}): string {
  return [
    "Project Brain accepted a docs-as-code projection proposal.",
    "",
    `Kind: ${args.kind}`,
    `Target path: ${args.path}`,
    "",
    "Draft content:",
    "```md",
    args.content,
    "```",
    "",
    "Apply this through the normal task, run, and promotion workflow.",
    "Do not publish, merge, or write repository files outside that workflow.",
  ].join("\n");
}

function socialActor(actor: BrainProposalActor): SocialActor {
  if (actor.type === "user") return { type: "user", id: actor.id };
  if (actor.type === "agent") return { type: "agent", id: actor.id };

  return { type: "system", id: null };
}

async function projectionFlowId(
  db: ProjectionDb,
  projectId: string,
): Promise<string | null> {
  const rows = await db.execute(sql`
    SELECT projection_flow_id
    FROM brain_project_config
    WHERE project_id = ${projectId}
    LIMIT 1
  `);

  return (rows.rows[0]?.projection_flow_id as string | null) ?? null;
}

export async function projectBrainProposalToTask(
  db: ProjectionDb & Record<string, unknown>,
  input: ProjectBrainProjectionInput,
): Promise<ProjectBrainProjectionResult> {
  const path = requiredString(input.draft, "path");
  const content = draftContent(input.draft);
  const flowId = await projectionFlowId(db, input.projectId);
  const created = await createTask(
    {
      title: taskTitle(input.kind, input.draft),
      prompt: projectionPrompt({ kind: input.kind, path, content }),
      flowId: null,
    },
    {
      projectId: input.projectId,
      actorUserId: input.actor.type === "user" ? input.actor.id : null,
    },
    db,
  );
  const launchMode: ProjectBrainProjectionResult["launchMode"] = flowId
    ? "auto"
    : "manual";

  if (flowId) {
    await applyTriageVerdict(db, {
      taskId: created.taskId,
      projectId: input.projectId,
      verdict: { flowId },
      actor: socialActor(input.actor),
      enqueue: true,
    });
  }

  log.info(
    {
      projectId: input.projectId,
      proposalId: input.proposalId,
      taskId: created.taskId,
      kind: input.kind,
      launchMode,
    },
    "brain projection task created",
  );

  return { taskId: created.taskId, launchMode };
}
