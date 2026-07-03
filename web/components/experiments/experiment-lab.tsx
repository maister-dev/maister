import type { ExperimentComparisonDTO } from "@/lib/experiments/comparison";
import type { ExperimentStatus } from "@/lib/experiments/types";
import type { ReactElement } from "react";

import Link from "next/link";

import {
  CostTab,
  DiffOfDiffsTab,
  DiffTab,
  FilesTab,
  GatesTab,
  type ComparisonTabLabels,
} from "@/components/experiments/comparison-tabs";
import {
  JudgePanel,
  type JudgePanelLabels,
  VerdictPanel,
  type VerdictPanelLabels,
} from "@/components/experiments/verdict-panel";
import {
  VariantMatrix,
  type VariantMatrixLabels,
} from "@/components/experiments/variant-matrix";
import { Tabs, type TabItem } from "@/components/navigation/tabs";

export type ExperimentLabTab =
  | "diff"
  | "diffOfDiffs"
  | "files"
  | "gates"
  | "cost"
  | "verdict";

export interface ExperimentLabLabels extends VariantMatrixLabels {
  eyebrow: string;
  task: string;
  base: string;
  branch: string;
  launch: string;
  abandon: string;
  conclude: string;
  tabs: Record<ExperimentLabTab, string>;
  status: Record<ExperimentStatus, string>;
}

const LAB_TABS: readonly ExperimentLabTab[] = [
  "diff",
  "diffOfDiffs",
  "files",
  "gates",
  "cost",
  "verdict",
];

function shortSha(value: string): string {
  return value.slice(0, 7);
}

function statusClass(status: ExperimentStatus): string {
  if (status === "comparable") {
    return "border-[color-mix(in_oklab,var(--accent-2)_30%,var(--line))] bg-accent-2-soft text-accent-2";
  }
  if (status === "concluded") {
    return "border-amber-line bg-amber-soft text-amber";
  }
  if (status === "running") {
    return "border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))] bg-accent-4-soft text-accent-4";
  }

  return "border-line bg-ivory text-mute";
}

function latestJudgeSummary(comparison: ExperimentComparisonDTO): string | null {
  const advisories =
    comparison.verdict?.judgeAdvisories ??
    comparison.experiment.verdict?.judgeAdvisories ??
    [];
  const latest = advisories.sort(
    (left, right) => right.advisoryOrdinal - left.advisoryOrdinal,
  )[0];

  return latest?.summary ?? null;
}

export function ExperimentLab({
  comparison,
  labels,
  comparisonLabels,
  verdictLabels,
  judgeLabels,
  canManage,
  canConclude,
  projectSlug,
  taskNumber,
  activeTab = "diff",
  judgeAvailable,
  judgePending = false,
}: {
  comparison: ExperimentComparisonDTO;
  labels: ExperimentLabLabels;
  comparisonLabels?: ComparisonTabLabels;
  verdictLabels?: VerdictPanelLabels;
  judgeLabels?: JudgePanelLabels;
  canManage: boolean;
  canConclude: boolean;
  projectSlug: string;
  taskNumber: number;
  activeTab?: ExperimentLabTab;
  judgeAvailable: boolean;
  judgePending?: boolean;
}): ReactElement {
  const tabItems: TabItem[] = LAB_TABS.map((tab) => ({
    key: tab,
    label: labels.tabs[tab],
    href: `/projects/${projectSlug}/experiments/${comparison.experiment.id}?tab=${tab}`,
  }));
  const resolvedComparisonLabels = comparisonLabels ?? fallbackComparisonLabels();
  const resolvedVerdictLabels = verdictLabels ?? fallbackVerdictLabels();
  const resolvedJudgeLabels = judgeLabels ?? fallbackJudgeLabels();

  return (
    <section>
      <header className="mb-6 border-b border-line pb-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-mute">
            {labels.eyebrow}
          </span>
          <span
            className={`rounded-full border px-2 py-px font-mono text-[10px] font-bold uppercase tracking-[0.08em] ${statusClass(
              comparison.experiment.status,
            )}`}
          >
            {labels.status[comparison.experiment.status]}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_auto]">
          <div>
            <h1 className="m-0 text-[32px] font-semibold leading-[1.08] text-ink">
              {comparison.experiment.title}
            </h1>
            <div className="mt-3 flex flex-wrap gap-3 font-mono text-[11px] text-mute">
              <Link
                className="text-amber hover:text-amber-2"
                href={`/projects/${projectSlug}/tasks/${taskNumber}`}
              >
                {labels.task} KEY-{taskNumber}
              </Link>
              <span>
                {labels.base}: {shortSha(comparison.experiment.baseCommit)}
              </span>
              <span>
                {labels.branch}: {comparison.experiment.baseBranch}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-start justify-end gap-2">
            {canManage ? (
              <>
                <button className="rounded-lg border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white">
                  {labels.launch}
                </button>
                <button className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink">
                  {labels.abandon}
                </button>
              </>
            ) : null}
            {canConclude && comparison.experiment.status === "comparable" ? (
              <a
                className="rounded-lg border border-line bg-ivory px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink"
                href="#verdict"
              >
                {labels.conclude}
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <VariantMatrix comparison={comparison} labels={labels} />

      <div className="mt-6">
        <Tabs activeKey={activeTab} items={tabItems} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4">
        {activeTab === "diff" ? (
          <DiffTab comparison={comparison} labels={resolvedComparisonLabels} />
        ) : null}
        {activeTab === "diffOfDiffs" ? (
          <DiffOfDiffsTab
            comparison={comparison}
            labels={resolvedComparisonLabels}
          />
        ) : null}
        {activeTab === "files" ? (
          <FilesTab comparison={comparison} labels={resolvedComparisonLabels} />
        ) : null}
        {activeTab === "gates" ? (
          <GatesTab comparison={comparison} labels={resolvedComparisonLabels} />
        ) : null}
        {activeTab === "cost" ? (
          <CostTab comparison={comparison} labels={resolvedComparisonLabels} />
        ) : null}
        {activeTab === "verdict" ? (
          <div
            className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]"
            id="verdict"
          >
            <VerdictPanel
              canConclude={canConclude}
              comparison={comparison}
              labels={resolvedVerdictLabels}
              projectSlug={projectSlug}
            />
            <JudgePanel
              available={judgeAvailable}
              experimentId={comparison.experiment.id}
              labels={resolvedJudgeLabels}
              latestSummary={latestJudgeSummary(comparison)}
              pending={judgePending}
              projectSlug={projectSlug}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function fallbackComparisonLabels(): ComparisonTabLabels {
  return {
    pair: "Pair",
    snapshot: "Stored snapshot",
    refsGone: "Refs gone - serving stored snapshot",
    truncated: "Truncated",
    missingSnapshot: "No diff snapshot",
    identical: "No differences",
    partial: "Partial comparison",
    filesAll: "All",
    filesDifferent: "Different",
    filesSame: "Same",
    contentUnavailable: "Content unavailable",
    noGates: "No gates",
    confidence: "Confidence",
    noCost: "No cost data",
    tokensCaption: "Tokens, not dollars",
    duration: "Duration",
    inputTokens: "Input",
    outputTokens: "Output",
    cacheReadTokens: "Cache read",
    cacheCreationTokens: "Cache create",
    resumeTokens: "Resume",
    byModel: "By model",
    byRunner: "By runner",
  };
}

function fallbackVerdictLabels(): VerdictPanelLabels {
  return {
    title: "Human verdict",
    readOnly: "Verdict is locked",
    viewerReadOnly: "Viewer access",
    outcome: "Outcome",
    outcomeWinner: "Winner",
    outcomeTie: "Tie",
    outcomeInconclusive: "Inconclusive",
    winner: "Winner variant",
    comment: "Comment",
    abandonLosers: "Abandon losers",
    submit: "Conclude",
    score: "Score",
    skipOptional: "Skip optional",
    optional: "optional",
    required: "required",
    validationError: "Resolve rubric scores before concluding",
    advisory: "Judge advisory",
    confidence: "Confidence",
    noAdvisory: "No advisory yet",
  };
}

function fallbackJudgeLabels(): JudgePanelLabels {
  return {
    title: "Experiment Judge",
    ask: "Ask judge",
    pending: "Judge is running",
    unavailable: "Attach Experiment Judge first",
    done: "Latest advisory",
    settings: "Open agents settings",
  };
}
