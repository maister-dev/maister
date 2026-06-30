import type { ReactElement } from "react";
import type { RunStatus, TaskStatus } from "@/lib/db/schema";
import type { TaskEditableTarget } from "@/components/board/task-card-editing";
import type {
  CheckStrictness,
  ExecutionPreset,
  HumanGateAutonomy,
  PromotionTrigger,
} from "@/lib/runs/execution-policy";

import { QuestionMarkCircleIcon } from "@heroicons/react/24/outline";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";

import { LaunchPopover } from "@/components/board/launch-popover";
import {
  TaskCardEditModal,
  TaskInlineEditableField,
} from "@/components/board/task-card-editing";
import { type FlowGraphViewLabels } from "@/components/board/flow-graph-view";
import { FlowGraphViewSection } from "@/components/board/flow-graph-view-section";
import { CommentComposer } from "@/components/social/comment-composer";
import { FollowButton } from "@/components/social/follow-button";
import { TaskAgentActions } from "@/components/social/task-agent-actions";
import { RelationsEditor } from "@/components/social/relations-editor";
import { TaskDetailPromptEditor } from "@/components/social/task-detail-prompt-editor";
import { TaskTimeline } from "@/components/social/task-timeline";
import RunDiff from "@/components/workbench/run-diff";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { compileManifest } from "@/lib/flows/graph/compile";
import { buildFlowNodeTooltipsFromManifest } from "@/lib/flows/graph/node-tooltips";
import { presentationLayout } from "@/lib/flows/graph/presentation-layout";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";
import { loadRunManifest } from "@/lib/queries/run-manifest";
import { getRunNodeStatuses } from "@/lib/queries/run-node-status";
import { getProjectAgentsView } from "@/lib/agents/project-links";
import { getTaskDetail } from "@/lib/queries/task-detail";
import { expandExecutionPolicy } from "@/lib/runs/execution-policy";
import {
  classifyForceRelaunchLaunchability,
  classifyManualTaskLaunchability,
} from "@/lib/runs/launchability";
import { resolveTaskLaunchConfig } from "@/lib/runs/task-launch-config";
import { getPlatformStatus } from "@/lib/supervisor-client";
import { formatTokenCount } from "@/lib/runs/cost-summary-facts";

const DELIVERY_STRATEGY_LABEL: Record<string, string> = {
  merge: "strategyMerge",
  rebase_merge: "strategyRebaseMerge",
  pull_request: "strategyPullRequest",
  ai_rebase_merge: "strategyAiRebaseMerge",
};

const EXECUTION_PRESET_LABEL: Record<ExecutionPreset, string> = {
  supervised: "execPresetSupervised",
  assisted: "execPresetAssisted",
  unattended: "execPresetUnattended",
};

const EXECUTION_CHECKS_LABEL: Record<CheckStrictness, string> = {
  strict: "execChecksStrict",
  advisory: "execChecksAdvisory",
  skip: "execChecksSkip",
};

const EXECUTION_HUMAN_GATE_LABEL: Record<HumanGateAutonomy, string> = {
  stop: "execHumanGateStop",
  auto_pass: "execHumanGateAutoPass",
};

const EXECUTION_PROMOTION_LABEL: Record<PromotionTrigger, string> = {
  manual: "execPromotionManual",
  auto_on_ready: "execPromotionAuto",
};

type PageProps = {
  params: Promise<{ slug: string; number: string }>;
};

type LaunchConfigItem = {
  label: string;
  value: string;
  help: string;
};

function LaunchConfigLabel({
  help,
  label,
}: {
  help: string;
  label: string;
}): ReactElement {
  return (
    <div className="flex items-center gap-1 font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] text-mute">
      <span>{label}</span>
      <span className="group/help relative inline-flex">
        <button
          aria-label={help}
          className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-mute transition hover:text-amber focus:text-amber focus:outline-none"
          type="button"
        >
          <QuestionMarkCircleIcon aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
        <span
          className="pointer-events-none absolute left-1/2 top-full z-40 mt-1 hidden w-64 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md border border-line bg-paper px-2 py-1.5 text-left font-mono text-[10.5px] font-medium normal-case leading-snug tracking-normal text-ink shadow-lg group-hover/help:block group-focus-within/help:block"
          role="tooltip"
        >
          {help}
        </span>
      </span>
    </div>
  );
}

function parseTaskNumber(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);

  return Number.isInteger(parsed) && parsed >= 1 && String(parsed) === raw
    ? parsed
    : null;
}

function formatAt(at: Date | null): string {
  return at ? at.toISOString().slice(0, 16).replace("T", " ") : "—";
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "—";
  const seconds = Math.round(durationMs / 1000);

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);

  return `${hours}h`;
}

export default async function TaskDetailPage({
  params,
}: PageProps): Promise<ReactElement> {
  const { slug, number } = await params;

  const user = await getSessionUser();

  if (!user) redirect("/login");

  const taskNumber = parseTaskNumber(number);

  if (taskNumber === null) notFound();

  const detail = await getTaskDetail(slug, taskNumber, user.id);

  if (!detail) notFound();

  const role =
    user.role === "admin"
      ? "owner"
      : await getProjectRole(user.id, detail.project.id);

  // Hide existence from non-members (mirrors the project board page).
  if (!role) notFound();

  const canAct = role === "owner" || role === "admin" || role === "member";
  const [t, tLaunch, locale, platformStatus, launchConfig] = await Promise.all([
    getTranslations("taskDetail"),
    getTranslations("launch"),
    getLocale(),
    getPlatformStatus(),
    resolveTaskLaunchConfig(detail.task.id),
  ]);
  const manualLaunchability = classifyManualTaskLaunchability(
    {
      status: detail.task.status as TaskStatus,
      triageStatus: detail.task.triageStatus,
    },
    detail.latestFlowRun
      ? { status: detail.latestFlowRun.status as RunStatus }
      : null,
    { openBlockers: detail.openBlockers },
  );
  const launchDisabledReason =
    platformStatus.kind !== "ready"
      ? t("launchSupervisorUnavailable")
      : manualLaunchability === "launchable"
        ? undefined
        : manualLaunchability === "blocked"
          ? `${t("launchBlocked")} ${detail.openBlockers
              .map((b) => `${b.key}-${b.number}`)
              .join(", ")}`
          : t(`launchReason.${manualLaunchability}`);

  // ADR-119: the runs-history "Run again" (force-relaunch) button stays enabled
  // while a run is active — only the TASK gates flagged/blocked (and supervisor
  // readiness) disable it.
  const forceLaunchability = classifyForceRelaunchLaunchability(
    {
      status: detail.task.status as TaskStatus,
      triageStatus: detail.task.triageStatus,
    },
    detail.latestFlowRun
      ? { status: detail.latestFlowRun.status as RunStatus }
      : null,
    { openBlockers: detail.openBlockers },
  );
  const forceLaunchDisabledReason =
    platformStatus.kind !== "ready"
      ? t("launchSupervisorUnavailable")
      : forceLaunchability === "launchable"
        ? undefined
        : forceLaunchability === "blocked"
          ? `${t("launchBlocked")} ${detail.openBlockers
              .map((b) => `${b.key}-${b.number}`)
              .join(", ")}`
          : t(`launchReason.${forceLaunchability}`);

  // M34: attached agents with the `manual` trigger — "Run agent" candidates.
  const manualAgents = canAct
    ? (await getProjectAgentsView(detail.project.id)).attached
        .filter(
          (row) =>
            row.enabled &&
            (row.agent.enabled as boolean) &&
            row.agent.quarantinedAt == null &&
            (row.agent.triggers as string[]).includes("manual"),
        )
        .map((row) => ({
          id: row.agent.id as string,
          name: row.agent.name as string,
        }))
    : [];

  // The latest flow run's graph + branch diff (only when one exists). RunDiff
  // self-loads prepared data from /api/runs/[runId]/diff client-side.
  let graph: {
    runId: string;
    topology: ReturnType<typeof buildGraphTopology>;
    layout: Record<string, { x: number; y: number }>;
    statuses: Awaited<ReturnType<typeof getRunNodeStatuses>>;
    nodeTooltips: Record<string, string>;
    currentStepId: string | null;
    runStatus: string;
    labels: FlowGraphViewLabels;
  } | null = null;

  if (detail.latestFlowRun) {
    const loaded = await loadRunManifest(detail.latestFlowRun.id);

    if (loaded) {
      const tWorkbench = await getTranslations("workbench");

      graph = {
        runId: detail.latestFlowRun.id,
        topology: buildGraphTopology(compileManifest(loaded.manifest)),
        layout: presentationLayout(loaded.manifest),
        statuses: await getRunNodeStatuses(detail.latestFlowRun.id),
        nodeTooltips: buildFlowNodeTooltipsFromManifest(loaded.manifest),
        currentStepId: detail.latestFlowRun.currentStepId,
        runStatus: detail.latestFlowRun.status,
        labels: {
          title: tWorkbench("graph.title"),
          empty: tWorkbench("graph.empty"),
          currentNode: tWorkbench("graph.currentNode"),
          declaredGateSummary: tWorkbench("graph.declaredGateSummary"),
          gateSummary: tWorkbench("graph.gateSummary"),
          blockingGateSummary: tWorkbench("graph.blockingGateSummary"),
          node: {
            Pending: tWorkbench("graph.node.Pending"),
            Running: tWorkbench("graph.node.Running"),
            Succeeded: tWorkbench("graph.node.Succeeded"),
            Failed: tWorkbench("graph.node.Failed"),
            NeedsInput: tWorkbench("graph.node.NeedsInput"),
            Reworked: tWorkbench("graph.node.Reworked"),
            Stale: tWorkbench("graph.node.Stale"),
          },
          role: {
            agent: tWorkbench("graph.role.agent"),
            command: tWorkbench("graph.role.command"),
            check: tWorkbench("graph.role.check"),
            judge: tWorkbench("graph.role.judge"),
            human: tWorkbench("graph.role.human"),
            form: tWorkbench("graph.role.form"),
            terminal: tWorkbench("graph.role.terminal"),
            other: tWorkbench("graph.role.other"),
          },
          edge: {
            success: tWorkbench("graph.edge.success"),
            default: tWorkbench("graph.edge.default"),
            rework: tWorkbench("graph.edge.rework"),
            reject: tWorkbench("graph.edge.reject"),
            takeover: tWorkbench("graph.edge.takeover"),
            approve: tWorkbench("graph.edge.approve"),
            other: tWorkbench("graph.edge.other"),
          },
        },
      };
    }
  }

  const tWorkbench = await getTranslations("workbench");
  const diffLabels = {
    title: tWorkbench("diff.title"),
    empty: tWorkbench("diff.empty"),
    error: tWorkbench("diff.error"),
    changedFiles: tWorkbench("diff.changedFiles"),
    bodyUnavailable: tWorkbench("diff.bodyUnavailable"),
    added: tWorkbench("diff.added"),
    removed: tWorkbench("diff.removed"),
    displayMode: tWorkbench("diff.displayMode"),
    rich: tWorkbench("diff.rich"),
    raw: tWorkbench("diff.raw"),
    filterFiles: tWorkbench("diff.filterFiles"),
    filterFilesPlaceholder: tWorkbench("diff.filterFilesPlaceholder"),
    filterNoMatches: tWorkbench("diff.filterNoMatches"),
    showFiles: tWorkbench("diff.showFiles"),
    hideFiles: tWorkbench("diff.hideFiles"),
    refresh: tWorkbench("diff.refresh"),
    viewMode: tWorkbench("diff.viewMode"),
    split: tWorkbench("diff.split"),
    unified: tWorkbench("diff.unified"),
    truncated: tWorkbench("diff.truncated"),
  };

  const timelineLabels = {
    empty: t("timelineEmpty"),
    formerUser: t("formerUser"),
    system: t("systemActor"),
    event: {
      task_created: t("event.taskCreated"),
      task_mentioned: t("event.taskMentioned"),
      relation_added: t("event.relationAdded"),
      relation_removed: t("event.relationRemoved"),
      run_launched: t("event.runLaunched"),
    },
  };
  const editableTask: TaskEditableTarget = {
    taskId: detail.task.id,
    number: detail.task.number,
    keyRef: detail.keyRef,
    title: detail.task.title,
    prompt: detail.task.prompt,
    flowId: detail.task.flowId,
    runnerId: detail.task.runnerId,
    baseBranch: detail.task.baseBranch,
    targetBranch: detail.task.targetBranch,
    promotionMode: detail.task.promotionMode,
    executionPolicy: detail.task.executionPolicy,
    relations: detail.relations,
  };
  const launchExecutionPolicy = launchConfig
    ? expandExecutionPolicy(launchConfig.executionPolicy)
    : null;
  const launchConfigItems: LaunchConfigItem[] = launchConfig
    ? [
        {
          label: t("lcFlow"),
          value: launchConfig.flow?.refId ?? "—",
          help: t("lcHelpFlow"),
        },
        {
          label: t("lcRunner"),
          value: launchConfig.runner
            ? `${launchConfig.runner.id} · ${launchConfig.runner.model}`
            : "—",
          help: t("lcHelpRunner"),
        },
        {
          label: t("lcBaseBranch"),
          value: launchConfig.baseBranch,
          help: t("lcHelpBaseBranch"),
        },
        {
          label: t("lcTargetBranch"),
          value: launchConfig.targetBranch,
          help: t("lcHelpTargetBranch"),
        },
        {
          label: t("lcDeliveryStrategy"),
          value: tLaunch(
            DELIVERY_STRATEGY_LABEL[launchConfig.deliveryPolicy.strategy],
          ),
          help: t("lcHelpDeliveryStrategy"),
        },
        {
          label: t("lcExecutionPreset"),
          value: launchExecutionPolicy
            ? tLaunch(EXECUTION_PRESET_LABEL[launchExecutionPolicy.preset])
            : "—",
          help: t("lcHelpExecutionPreset"),
        },
        {
          label: t("lcChecks"),
          value: launchExecutionPolicy
            ? tLaunch(EXECUTION_CHECKS_LABEL[launchExecutionPolicy.checks])
            : "—",
          help: t("lcHelpChecks"),
        },
        {
          label: t("lcHumanGate"),
          value: launchExecutionPolicy
            ? tLaunch(
                EXECUTION_HUMAN_GATE_LABEL[launchExecutionPolicy.humanGate],
              )
            : "—",
          help: t("lcHelpHumanGate"),
        },
        {
          label: t("lcPromotionTrigger"),
          value: launchExecutionPolicy
            ? tLaunch(
                EXECUTION_PROMOTION_LABEL[launchExecutionPolicy.promotion],
              )
            : "—",
          help: t("lcHelpPromotionTrigger"),
        },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 border-b border-line-soft pb-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-[11px] text-mute">
            <Link className="hover:text-amber" href={`/projects/${slug}`}>
              {detail.project.name}
            </Link>
            <span>/</span>
            <span className="rounded border border-line bg-ivory px-1.5 py-px font-semibold text-ink">
              {detail.keyRef}
            </span>
            <span className="rounded border border-line px-1.5 py-px uppercase tracking-[0.08em]">
              {t(`status.${detail.task.status}`)}
            </span>
            {detail.task.triageStatus === "triaged" ? (
              <span className="rounded border border-line bg-ivory px-1.5 py-px font-semibold uppercase tracking-[0.08em] text-accent-4">
                {t("triaged")}
              </span>
            ) : null}
            {detail.task.triageStatus === "flagged" ? (
              <span className="rounded border border-amber-line bg-amber-soft px-1.5 py-px font-semibold uppercase tracking-[0.08em] text-amber">
                {t("flagged")}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {canAct ? (
              <TaskAgentActions
                agents={manualAgents}
                labels={{
                  runAgent: t("runAgent"),
                  sendToTriage: t("sendToTriage"),
                  busy: t("agentActionBusy"),
                  agentPickerLabel: t("agentPickerLabel"),
                }}
                slug={slug}
                taskId={detail.task.id}
                taskNumber={detail.task.number}
              />
            ) : null}
            {canAct ? (
              <LaunchPopover
                disabledLabel={t("runAgainUnavailable")}
                disabledReason={launchDisabledReason}
                hasRuns={detail.totals.runCount > 0}
                label={
                  detail.totals.runCount > 0 ? t("runAgain") : t("launchFirst")
                }
                taskId={detail.task.id}
              />
            ) : null}
            <FollowButton
              isFollowing={detail.isFollowing}
              labels={{
                follow: t("follow"),
                unfollow: t("unfollow"),
                busy: t("followBusy"),
              }}
              slug={slug}
              taskNumber={detail.task.number}
            />
            <TaskCardEditModal
              canEdit={canAct}
              card={editableTask}
              relationCandidates={detail.relationCandidates}
              slug={slug}
              triggerClassName="inline-flex h-8 w-8 flex-none items-center justify-center rounded-md border border-line bg-paper text-mute transition hover:border-amber hover:text-amber focus:border-amber focus:text-amber"
            />
          </div>
        </div>
        <div
          aria-level={1}
          className="w-full min-w-0 text-[22px] font-semibold leading-tight text-ink"
          role="heading"
        >
          <TaskInlineEditableField
            canEdit={canAct}
            className="min-w-0"
            field="title"
            slug={slug}
            taskNumber={detail.task.number}
            value={detail.task.title}
          />
        </div>
        <div className="rounded-lg border border-line-soft bg-paper p-3">
          <TaskDetailPromptEditor
            canEdit={canAct}
            prompt={detail.task.prompt}
            slug={slug}
            taskNumber={detail.task.number}
          />
        </div>
        <RelationsEditor
          canEdit={canAct}
          labels={{
            title: t("relationsTitle"),
            empty: t("relationsEmpty"),
            add: t("relationsAdd"),
            adding: t("relationsAdding"),
            numberPlaceholder: t("relationsNumberPlaceholder"),
            searchPlaceholder: t("relationsSearchPlaceholder"),
            searchNoResults: t("relationsSearchNoResults"),
            remove: t("relationsRemove"),
            kindOut: {
              blocks: t("relationKind.blocks"),
              depends_on: t("relationKind.dependsOn"),
              parent_of: t("relationKind.parentOf"),
              requires: t("relationKind.requires"),
            },
            kindIn: {
              blocks: t("relationKindInverse.blocks"),
              depends_on: t("relationKindInverse.dependsOn"),
              parent_of: t("relationKindInverse.parentOf"),
              requires: t("relationKindInverse.requires"),
            },
            errorConfig: t("relationsErrorConfig"),
            errorNotFound: t("relationsErrorNotFound"),
            errorForbidden: t("errorForbidden"),
            errorGeneric: t("errorGeneric"),
          }}
          relationCandidates={detail.relationCandidates}
          relations={detail.relations}
          slug={slug}
          taskNumber={detail.task.number}
        />
      </header>

      {launchConfig ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("launchConfigTitle")}
          </h2>
          <div
            className="grid gap-px rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
            data-testid="task-launch-config"
          >
            {launchConfigItems.map(({ help, label, value }) => (
              <div key={label} className="bg-paper px-3 py-2">
                <LaunchConfigLabel help={help} label={label} />
                <div className="mt-1 break-words font-mono text-[12px] font-semibold text-ink">
                  {value}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("runsTitle")}
          </h2>
          {detail.totals.runCount > 0 ? (
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] font-bold tracking-[0.04em] text-ink-2">
                {t("runsCount", { count: detail.totals.runCount })}
              </span>
              {canAct ? (
                <LaunchPopover
                  forceRelaunch
                  hasRuns
                  disabledLabel={t("runAgainUnavailable")}
                  disabledReason={forceLaunchDisabledReason}
                  label={t("runAgainConcurrent")}
                  taskId={detail.task.id}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <div
          className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-5"
          data-testid="task-run-aggregates"
        >
          {[
            [t("aggregateRuns"), String(detail.totals.runCount)],
            [
              t("aggregateInput"),
              formatTokenCount(locale, detail.totals.inputTokens),
            ],
            [
              t("aggregateOutput"),
              formatTokenCount(locale, detail.totals.outputTokens),
            ],
            [
              t("aggregateCache"),
              formatTokenCount(
                locale,
                detail.totals.cacheReadTokens +
                  detail.totals.cacheCreationTokens,
              ),
            ],
            [
              t("aggregateTokenTotal"),
              formatTokenCount(locale, detail.totals.tokenTotal),
            ],
          ].map(([label, value]) => (
            <div key={label} className="bg-paper px-3 py-2">
              <div className="font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] text-mute">
                {label}
              </div>
              <div className="mt-1 font-mono text-[12px] font-semibold text-ink">
                {value}
              </div>
            </div>
          ))}
        </div>
        {detail.runs.length === 0 ? (
          <p className="text-[13px] text-mute">{t("runsEmpty")}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[860px] text-left text-[12px]">
              <thead>
                <tr className="border-b border-line bg-ivory text-[11px] uppercase tracking-[0.08em] text-mute">
                  <th className="px-3 py-2 font-semibold">
                    {t("runsAttempt")}
                  </th>
                  <th className="px-3 py-2 font-semibold">{t("runsFlow")}</th>
                  <th className="px-3 py-2 font-semibold">
                    {t("runsRunnerModel")}
                  </th>
                  <th className="px-3 py-2 font-semibold">{t("runsStatus")}</th>
                  <th className="px-3 py-2 font-semibold">
                    {t("runsDelivery")}
                  </th>
                  <th className="px-3 py-2 font-semibold">
                    {t("runsDuration")}
                  </th>
                  <th className="px-3 py-2 font-semibold">
                    {t("runsTokenTotal")}
                  </th>
                  <th className="px-3 py-2 font-semibold">
                    {t("runsStarted")}
                  </th>
                  <th className="px-3 py-2 font-semibold">{t("runsEnded")}</th>
                  <th className="px-3 py-2 font-semibold">{t("runsLinks")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.runs.map((run, index) => (
                  <tr key={run.id} className="border-b border-line-soft">
                    <td className="px-3 py-2 font-mono">
                      #{detail.runs.length - index}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {run.flowRef ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {run.runnerModel ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-mono">{run.status}</td>
                    <td className="px-3 py-2 font-mono">
                      {run.deliveryStatus ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {formatDuration(run.durationMs)}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {formatTokenCount(locale, run.tokenTotal)}
                    </td>
                    <td
                      suppressHydrationWarning
                      className="px-3 py-2 font-mono"
                    >
                      {formatAt(run.startedAt)}
                    </td>
                    <td
                      suppressHydrationWarning
                      className="px-3 py-2 font-mono"
                    >
                      {formatAt(run.endedAt)}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        className="text-amber hover:underline"
                        href={`/runs/${run.id}`}
                      >
                        {t("runsOpen")}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-mute">
          {t("timelineTitle")}
        </h2>
        <TaskTimeline items={detail.timeline} labels={timelineLabels} />
        {canAct ? (
          <CommentComposer
            labels={{
              placeholder: t("composerPlaceholder"),
              submit: t("composerSubmit"),
              submitting: t("composerSubmitting"),
              hint: t("composerHint"),
              errorConfig: t("composerErrorConfig"),
              errorForbidden: t("errorForbidden"),
              errorGeneric: t("errorGeneric"),
            }}
            slug={slug}
            taskNumber={detail.task.number}
          />
        ) : null}
      </section>

      {graph ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("latestRunTitle")}
          </h2>
          <FlowGraphViewSection
            labels={graph.labels}
            layout={graph.layout}
            nodeTooltips={graph.nodeTooltips}
            runContext={{
              runId: graph.runId,
              initialStatuses: graph.statuses.nodes,
              currentStepId: graph.currentStepId,
              runStatus: graph.runStatus,
            }}
            topology={graph.topology}
          />
        </section>
      ) : null}

      {detail.latestFlowRun ? (
        <section className="flex flex-col gap-2">
          <RunDiff labels={diffLabels} runId={detail.latestFlowRun.id} />
        </section>
      ) : null}
    </div>
  );
}
