import "server-only";

import { and, eq } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { selectForUpdate } from "@/lib/db/select-for-update";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { EXPERIMENT_JUDGE_AGENT_ID } from "@/lib/experiments/constants";
import { ExperimentNotFoundError } from "@/lib/experiments/errors";
import { validateExperimentHumanVerdict } from "@/lib/experiments/rubric";
import type { TokenActor } from "@/lib/tokens/verify";
import type {
  ExperimentJudgeAdvisory,
  ExperimentRubric,
  ExperimentVariant,
  ExperimentVerdictEnvelope,
} from "@/lib/experiments/types";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { experiments } = schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "experiments-advisory",
  level: process.env.LOG_LEVEL ?? "info",
});

export const experimentAdvisoryInputSchema = z
  .object({
    scores: z.record(z.string().min(1), z.record(z.string().min(1), z.number())),
    summary: z.string().min(1).max(8000),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export type ExperimentAdvisoryInput = z.infer<
  typeof experimentAdvisoryInputSchema
>;

export type AppendExperimentAdvisoryResult = {
  experimentId: string;
  advisory: ExperimentJudgeAdvisory;
};

export function isUnauthorizedExperimentAgentActor(
  actor: Pick<TokenActor, "agentId" | "tokenKind">,
): boolean {
  return (
    actor.tokenKind === "agent" && actor.agentId !== EXPERIMENT_JUDGE_AGENT_ID
  );
}

function nextAdvisoryOrdinal(verdict: ExperimentVerdictEnvelope | null): number {
  const advisories = verdict?.judgeAdvisories ?? [];

  return (
    Math.max(0, ...advisories.map((advisory) => advisory.advisoryOrdinal)) + 1
  );
}

export async function appendExperimentAdvisory(
  args: {
    projectId: string;
    experimentId: string;
    actorLabel: string;
    agentRunId?: string | null;
    input: ExperimentAdvisoryInput;
    audit?: (tx: Db) => Promise<void>;
  },
  db?: Db,
): Promise<AppendExperimentAdvisoryResult> {
  const parsed = experimentAdvisoryInputSchema.safeParse(args.input);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `invalid experiment advisory: ${parsed.error.message}`,
    );
  }

  const d = db ?? getDb();

  return await d.transaction(async (tx: Db) => {
    const lockedRows = await selectForUpdate(
      tx
        .select()
        .from(experiments)
        .where(
          and(
            eq(experiments.id, args.experimentId),
            eq(experiments.projectId, args.projectId),
          ),
        ),
    );
    const experiment = lockedRows.find(
      (row) =>
        row.id === args.experimentId && row.projectId === args.projectId,
    );

    if (!experiment) {
      throw new ExperimentNotFoundError(args.experimentId);
    }
    if (experiment.status !== "running" && experiment.status !== "comparable") {
      throw new MaisterError(
        "PRECONDITION",
        `experiment ${args.experimentId} does not accept advisories in ${experiment.status}`,
      );
    }

    validateExperimentHumanVerdict({
      variants: experiment.variants as ExperimentVariant[],
      rubric: experiment.rubric as ExperimentRubric,
      verdict: { outcome: "tie", scores: parsed.data.scores },
    });

    const currentVerdict =
      (experiment.verdict as ExperimentVerdictEnvelope | null) ?? {};
    const advisory: ExperimentJudgeAdvisory = {
      advisoryOrdinal: nextAdvisoryOrdinal(currentVerdict),
      agentRunId: args.agentRunId ?? null,
      createdAt: new Date().toISOString(),
      scores: parsed.data.scores,
      summary: parsed.data.summary,
      ...(parsed.data.confidence !== undefined
        ? { confidence: parsed.data.confidence }
        : {}),
    };
    const verdict: ExperimentVerdictEnvelope = {
      ...currentVerdict,
      judgeAdvisories: [
        ...(currentVerdict.judgeAdvisories ?? []),
        advisory,
      ],
    };

    await tx
      .update(experiments)
      .set({ verdict, updatedAt: new Date() })
      .where(eq(experiments.id, args.experimentId));

    if (args.audit) await args.audit(tx);

    log.info(
      {
        projectId: args.projectId,
        experimentId: args.experimentId,
        actorLabel: args.actorLabel,
        advisoryOrdinal: advisory.advisoryOrdinal,
        agentRunId: advisory.agentRunId,
      },
      "experiment advisory appended",
    );

    return { experimentId: args.experimentId, advisory };
  });
}
