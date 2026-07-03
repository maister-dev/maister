import type { ExperimentLabLabels, ExperimentLabTab } from "@/components/experiments/experiment-lab";
import type { ComparisonTabLabels } from "@/components/experiments/comparison-tabs";
import type {
  JudgePanelLabels,
  VerdictPanelLabels,
} from "@/components/experiments/verdict-panel";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { ProjectTabs } from "@/components/board/project-tabs";
import { ExperimentLab } from "@/components/experiments/experiment-lab";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { EXPERIMENT_JUDGE_AGENT_ID } from "@/lib/experiments/judge";
import { getExperimentComparison } from "@/lib/experiments/comparison";
import { getProjectAgentsView } from "@/lib/agents/project-links";
import { getBoardData } from "@/lib/queries/board";
import { getProjectBySlug } from "@/lib/queries/project";
import { getTaskDTO } from "@/lib/services/tasks";

interface PageProps {
  params: Promise<{ slug: string; experimentId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}

const VALID_TABS: readonly ExperimentLabTab[] = [
  "diff",
  "diffOfDiffs",
  "files",
  "gates",
  "cost",
  "verdict",
];

function parseTab(raw: string | string[] | undefined): ExperimentLabTab {
  const value = Array.isArray(raw) ? raw[0] : raw;

  return (VALID_TABS as readonly string[]).includes(value ?? "")
    ? (value as ExperimentLabTab)
    : "diff";
}

function canAct(role: string): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

export default async function ProjectExperimentLabPage({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { slug, experimentId } = await params;
  const user = await getSessionUser();

  if (!user) notFound();

  const project = await getProjectBySlug(slug);

  if (!project || project.archivedAt) notFound();

  const role =
    user.role === "admin" ? "owner" : await getProjectRole(user.id, project.id);

  if (role === null) notFound();

  const [t, board, agents] = await Promise.all([
    getTranslations("experiments"),
    getBoardData(project.id),
    getProjectAgentsView(project.id),
  ]);
  const comparison = await getExperimentComparison({
    projectId: project.id,
    experimentId,
    viewerType: "session",
  }).catch(() => null);

  if (!comparison) notFound();

  const task = await getTaskDTO(comparison.experiment.taskId, project.id);

  if (!task) notFound();

  const activeTab = parseTab((await searchParams).tab);
  const judgeAvailable = agents.attached.some(
    (attached) =>
      attached.enabled && attached.agent.id === EXPERIMENT_JUDGE_AGENT_ID,
  );

  return (
    <>
      <ProjectTabs
        active="experiments"
        boardCount={board.totalTasks}
        slug={slug}
      />
      <ExperimentLab
        activeTab={activeTab}
        canConclude={canAct(role)}
        canManage={canAct(role)}
        comparison={comparison}
        comparisonLabels={comparisonLabels(t)}
        judgeAvailable={judgeAvailable}
        judgeLabels={judgeLabels(t)}
        labels={labLabels(t)}
        projectSlug={slug}
        taskNumber={task.number}
        verdictLabels={verdictLabels(t)}
      />
    </>
  );
}

function labLabels(t: Awaited<ReturnType<typeof getTranslations>>): ExperimentLabLabels {
  return {
    eyebrow: t("lab.eyebrow"),
    task: t("lab.task"),
    base: t("lab.base"),
    branch: t("lab.branch"),
    launch: t("lab.launch"),
    abandon: t("lab.abandon"),
    conclude: t("lab.conclude"),
    variants: t("lab.variants"),
    latestReplicate: t("lab.latestReplicate"),
    queuePosition: t("lab.queuePosition"),
    duration: t("lab.duration"),
    openRun: t("lab.openRun"),
    noRuns: t("lab.noRuns"),
    crashedConcludable: t("lab.crashedConcludable"),
    tabs: {
      diff: t("tabs.diff"),
      diffOfDiffs: t("tabs.diffOfDiffs"),
      files: t("tabs.files"),
      gates: t("tabs.gates"),
      cost: t("tabs.cost"),
      verdict: t("tabs.verdict"),
    },
    status: {
      draft: t("status.draft"),
      running: t("status.running"),
      comparable: t("status.comparable"),
      concluded: t("status.concluded"),
      abandoned: t("status.abandoned"),
    },
    runStatus: {
      Pending: t("runStatus.Pending"),
      Running: t("runStatus.Running"),
      NeedsInput: t("runStatus.NeedsInput"),
      NeedsInputIdle: t("runStatus.NeedsInputIdle"),
      HumanWorking: t("runStatus.HumanWorking"),
      WaitingOnChildren: t("runStatus.WaitingOnChildren"),
      Review: t("runStatus.Review"),
      Crashed: t("runStatus.Crashed"),
      Done: t("runStatus.Done"),
      Abandoned: t("runStatus.Abandoned"),
      Failed: t("runStatus.Failed"),
    },
  };
}

function comparisonLabels(
  t: Awaited<ReturnType<typeof getTranslations>>,
): ComparisonTabLabels {
  return {
    pair: t("comparison.pair"),
    snapshot: t("comparison.snapshot"),
    refsGone: t("comparison.refsGone"),
    truncated: t("comparison.truncated"),
    missingSnapshot: t("comparison.missingSnapshot"),
    identical: t("comparison.identical"),
    partial: t("comparison.partial"),
    filesAll: t("comparison.filesAll"),
    filesDifferent: t("comparison.filesDifferent"),
    filesSame: t("comparison.filesSame"),
    contentUnavailable: t("comparison.contentUnavailable"),
    noGates: t("comparison.noGates"),
    confidence: t("comparison.confidence"),
    noCost: t("comparison.noCost"),
    tokensCaption: t("comparison.tokensCaption"),
    duration: t("lab.duration"),
    inputTokens: t("comparison.inputTokens"),
    outputTokens: t("comparison.outputTokens"),
    cacheReadTokens: t("comparison.cacheReadTokens"),
    cacheCreationTokens: t("comparison.cacheCreationTokens"),
    resumeTokens: t("comparison.resumeTokens"),
    byModel: t("comparison.byModel"),
    byRunner: t("comparison.byRunner"),
  };
}

function verdictLabels(
  t: Awaited<ReturnType<typeof getTranslations>>,
): VerdictPanelLabels {
  return {
    title: t("verdict.title"),
    readOnly: t("verdict.readOnly"),
    viewerReadOnly: t("verdict.viewerReadOnly"),
    outcome: t("verdict.outcome"),
    outcomeWinner: t("outcome.winner"),
    outcomeTie: t("outcome.tie"),
    outcomeInconclusive: t("outcome.inconclusive"),
    winner: t("verdict.winner"),
    comment: t("verdict.comment"),
    abandonLosers: t("verdict.abandonLosers"),
    submit: t("verdict.submit"),
    score: t("verdict.score"),
    skipOptional: t("verdict.skipOptional"),
    optional: t("verdict.optional"),
    required: t("verdict.required"),
    validationError: t("verdict.validationError"),
    advisory: t("verdict.advisory"),
    confidence: t("comparison.confidence"),
    noAdvisory: t("verdict.noAdvisory"),
  };
}

function judgeLabels(
  t: Awaited<ReturnType<typeof getTranslations>>,
): JudgePanelLabels {
  return {
    title: t("judge.title"),
    ask: t("judge.ask"),
    pending: t("judge.pending"),
    unavailable: t("judge.unavailable"),
    done: t("judge.done"),
    settings: t("judge.settings"),
  };
}
