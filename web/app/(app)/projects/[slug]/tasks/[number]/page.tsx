import type { ReactElement, ReactNode } from "react";
import type {
  RunStatus,
  TaskActivityEventKind,
  TaskStatus,
} from "@/lib/db/schema";
import type { TaskEditableTarget } from "@/components/board/task-card-editing";
import type {
  CheckStrictness,
  ExecutionPreset,
  HumanGateAutonomy,
  PromotionTrigger,
} from "@/lib/runs/execution-policy";

import { QuestionMarkCircleIcon } from "@heroicons/react/24/outline";
import { and, eq, inArray } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";

import { TaskQualificationControl } from "@/components/agents/task-qualification-control";
import { getTaskQualificationSummaries } from "@/lib/tasks/qualification-queries";
import { LaunchPopover } from "@/components/board/launch-popover";
import { TaskLaunchHoldControl } from "@/components/board/task-launch-hold-control";
import { isManualTriageHold } from "@/lib/tasks/manual-launch-hold";
import {
  TaskCardEditModal,
  TaskInlineEditableField,
} from "@/components/board/task-card-editing";
import { TaskQueueControls } from "@/components/board/task-queue-controls";
import { TaskClarificationHistory } from "@/components/board/task-clarification-history";
import { TaskUserClarifications } from "@/components/board/task-user-clarifications";
import { type FlowGraphViewLabels } from "@/components/board/flow-graph-view";
import { FlowGraphViewSection } from "@/components/board/flow-graph-view-section";
import { CommentComposer } from "@/components/social/comment-composer";
import { FollowButton } from "@/components/social/follow-button";
import { TaskAgentActions } from "@/components/social/task-agent-actions";
import { TaskCompleteAction } from "@/components/social/task-complete-action";
import { RelationsEditor } from "@/components/social/relations-editor";
import { TaskDetailPromptEditor } from "@/components/social/task-detail-prompt-editor";
import { TaskTimeline } from "@/components/social/task-timeline";
import RunDiff from "@/components/workbench/run-diff";
import { LazyDisclosure } from "@/components/tasks/lazy-disclosure";
import { TaskResultCard } from "@/components/tasks/task-result-card";
import { TaskRunArtifactView } from "@/components/tasks/task-run-artifact";
import { TaskSourceChip } from "@/components/tasks/task-source-chip";
import { LocalTime } from "@/components/ui/local-time";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { projectMembers, users } from "@/lib/db/schema";
import { compileManifest } from "@/lib/flows/graph/compile";
import { buildFlowNodeTooltipsFromManifest } from "@/lib/flows/graph/node-tooltips";
import { presentationLayout } from "@/lib/flows/graph/presentation-layout";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";
import { loadRunManifest } from "@/lib/queries/run-manifest";
import { getRunNodeStatuses } from "@/lib/queries/run-node-status";
import { getProjectAgentsView } from "@/lib/agents/project-links";
import { listMentionCandidateAgents } from "@/lib/agents/summonability";
import { getTaskDetail } from "@/lib/queries/task-detail";
import { countOpenBlockingClarifications } from "@/lib/tasks/clarification-gate";
import { expandExecutionPolicy } from "@/lib/runs/execution-policy";
import {
  classifyForceRelaunchLaunchability,
  classifyManualTaskLaunchability,
} from "@/lib/runs/launchability";
import { resolveTaskLaunchConfig } from "@/lib/runs/task-launch-config";
import { getPlatformStatus } from "@/lib/execution-host";
import { formatTokenCount } from "@/lib/runs/cost-summary-facts";
import { formatDurationMs } from "@/lib/format/duration";
import { RunTimingFacts } from "@/components/runs/run-timing-detail";
import {
  taskNextAction,
  type TaskPrimaryAction,
  type TaskSecondaryAction,
} from "@/lib/tasks/task-next-action";

const DELIVERY_STRATEGY_LABEL: Record<string, string> = {
  merge: "strategyMerge",
  rebase_merge: "strategyRebaseMerge",
  pull_request: "strategyPullRequest",
  ai_rebase_merge: "strategyAiRebaseMerge",
  publish_branch: "strategyPublishBranch",
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

// D10: a longer statement opens collapsed to a preview.
const STATEMENT_PREVIEW_LINES = 8;

function parseTaskNumber(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);

  return Number.isInteger(parsed) && parsed >= 1 && String(parsed) === raw
    ? parsed
    : null;
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
  const clarificationUserIds = [
    ...new Set(
      detail.task.clarifications.flatMap((row) =>
        [row.requesterUserId, row.recipientUserId].filter(
          (id): id is string => id !== null,
        ),
      ),
    ),
  ];
  const clarificationPeople =
    clarificationUserIds.length === 0
      ? []
      : await getDb()
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            globalRole: users.role,
            accountStatus: users.accountStatus,
            projectRole: projectMembers.role,
          })
          .from(users)
          .leftJoin(
            projectMembers,
            and(
              eq(projectMembers.userId, users.id),
              eq(projectMembers.projectId, detail.project.id),
            ),
          )
          .where(inArray(users.id, clarificationUserIds));
  const nameById = Object.fromEntries(
    clarificationPeople.map((person) => [
      person.id,
      person.name ?? person.email,
    ]),
  );
  const recipientEligibleById = Object.fromEntries(
    clarificationPeople.map((person) => [
      person.id,
      person.accountStatus === "active" &&
        (person.globalRole === "admin" ||
          person.projectRole === "member" ||
          person.projectRole === "admin" ||
          person.projectRole === "owner"),
    ]),
  );
  const [
    t,
    tLaunch,
    tBoard,
    tTiming,
    tRun,
    tRunStatus,
    locale,
    platformStatus,
    launchConfig,
  ] = await Promise.all([
    getTranslations("taskDetail"),
    getTranslations("launch"),
    getTranslations("board"),
    getTranslations("runTiming"),
    getTranslations("run"),
    getTranslations("run.runStatus"),
    getLocale(),
    getPlatformStatus(),
    resolveTaskLaunchConfig(detail.task.id),
  ]);
  const openBlocking = await countOpenBlockingClarifications(detail.task.id);
  const manualLaunchability = classifyManualTaskLaunchability(
    {
      status: detail.task.status as TaskStatus,
      triageStatus: detail.task.triageStatus,
      triageFlagOrigin: detail.task.triageFlagOrigin,
      queuePaused: detail.task.queuePaused,
    },
    detail.latestFlowRun
      ? { status: detail.latestFlowRun.status as RunStatus }
      : null,
    { openBlockers: detail.openBlockers },
    { openBlocking },
  );
  const qualification = (
    await getTaskQualificationSummaries(getDb(), [detail.task.id])
  ).get(detail.task.id);
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
      triageFlagOrigin: detail.task.triageFlagOrigin,
      queuePaused: detail.task.queuePaused,
    },
    detail.latestFlowRun
      ? { status: detail.latestFlowRun.status as RunStatus }
      : null,
    { openBlockers: detail.openBlockers },
    { openBlocking },
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

  // (ADR-151) Composer mention candidates — SUMMONABLE agents only, through the
  // one eligibility helper the write path and the consumer also read. No
  // autocomplete endpoint: this is an RSC page prop (D10).
  const mentionCandidates = canAct
    ? (await listMentionCandidateAgents(undefined, detail.project.id))
        .filter((agent) => agent.summonable)
        .map((agent) => ({ id: agent.id, name: agent.name }))
    : [];

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
          flowRef: (row.agent.flowRef as string | null) ?? null,
          kind: row.agent.kind as "operational" | "code_delivery",
          workspace: row.agent.workspace as "none" | "repo_read" | "worktree",
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

    if (loaded?.compatible) {
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
    mentionNotSummonable: t("mentionNotSummonable"),
    viaLibrarian: t("viaLibrarian"),
    // P-4: every activity kind has a label — compile-time exhaustive.
    event: {
      task_created: t("event.taskCreated"),
      comment_added: t("event.commentAdded"),
      task_mentioned: t("event.taskMentioned"),
      relation_added: t("event.relationAdded"),
      relation_removed: t("event.relationRemoved"),
      run_launched: t("event.runLaunched"),
      triage_set: t("event.triageSet"),
      triage_requeued: t("event.triageRequeued"),
      agent_quarantined: t("event.agentQuarantined"),
      experiment_concluded: t("event.experimentConcluded"),
      run_pr_merged: t("event.runPrMerged"),
      evaluation_decided: t("event.evaluationDecided"),
      agent_summon_suppressed: t("event.agentSummonSuppressed"),
      statement_accepted: t("event.statementAccepted"),
      clarification_requested: t("event.clarificationRequested"),
      clarification_answered: t("event.clarificationAnswered"),
      clarification_cancelled: t("event.clarificationCancelled"),
      task_completed: t("event.taskCompleted"),
      delivery_completion_not_applied: t("event.deliveryCompletionNotApplied"),
      source_detached: t("event.sourceDetached"),
    } satisfies Record<TaskActivityEventKind, string>,
  };
  const artifactLabels = {
    notDelivered: t("notDelivered"),
    merged: t("mergedLocally"),
    pr: {
      open: tRun("prOpen"),
      merged: tRun("prMerged"),
      closed: tRun("prClosed"),
      conflicts: tRun("prConflicts"),
      reopen: tRun("prReopen"),
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
    priority: detail.task.priority,
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

  // A current, ready assessment is the only one that may stay collapsed.
  const qualificationSettled =
    qualification?.decision === "ready" &&
    qualification.freshness === "current" &&
    !qualification.blockedReason;
  // D10: the page is organized around the task's state and its next action.
  const latestRun = detail.runs[0] ?? null;
  const latestPr =
    latestRun?.delivery.artifact.kind === "pr"
      ? latestRun.delivery.artifact
      : null;
  const resolvingRun =
    detail.runs.find((run) => run.id === detail.resolvingRunId) ?? null;
  const nextAction = taskNextAction({
    taskStatus: detail.task.status as TaskStatus,
    needsQualification:
      Boolean(qualification?.required) && !qualificationSettled,
    launchable: launchDisabledReason === undefined,
    latestRun: latestRun
      ? { status: latestRun.status as RunStatus, hasPr: latestPr !== null }
      : null,
    completionReady: detail.latestFlowRun?.completionReady ?? false,
    canAct,
  });
  const actionLink =
    "inline-flex h-8 items-center rounded-md border border-amber bg-amber px-3 font-mono text-[11px] font-semibold text-white hover:bg-amber-2";
  const secondaryLink =
    "inline-flex h-8 items-center rounded-md border border-line bg-paper px-3 font-mono text-[11px] font-semibold text-ink-2 hover:border-amber hover:text-amber";
  const relaunch = (label: string, title?: string) =>
    canAct ? (
      <span title={title}>
        <LaunchPopover
          forceRelaunch
          hasRuns
          disabledLabel={t("runAgainUnavailable")}
          disabledReason={forceLaunchDisabledReason}
          label={label}
          taskId={detail.task.id}
        />
      </span>
    ) : null;
  const renderAction = (
    action: TaskPrimaryAction | TaskSecondaryAction,
    primary: boolean,
  ): ReactNode => {
    const linkClass = primary ? actionLink : secondaryLink;

    switch (action) {
      case "qualify":
        return (
          <a className={linkClass} href="#task-qualification">
            {t("action.qualify")}
          </a>
        );
      case "launch":
        return canAct ? (
          <LaunchPopover
            disabledLabel={t("runAgainUnavailable")}
            disabledReason={launchDisabledReason}
            hasRuns={false}
            label={t("launchFirst")}
            taskId={detail.task.id}
          />
        ) : (
          <span className="font-mono text-[11px] text-mute">
            {t("launchFirst")}
          </span>
        );
      case "blocked":
        return (
          <span className="font-mono text-[11px] text-amber" role="status">
            {launchDisabledReason ?? t("launchBlocked")}
          </span>
        );
      case "open_run":
        return latestRun ? (
          <Link className={linkClass} href={`/runs/${latestRun.id}`}>
            {t("action.openRun")}
          </Link>
        ) : null;
      case "respond":
        return latestRun ? (
          <Link className={linkClass} href={`/runs/${latestRun.id}`}>
            {t("action.respond")}
          </Link>
        ) : null;
      case "open_review":
        return latestRun ? (
          <Link className={linkClass} href={`/runs/${latestRun.id}#review`}>
            {t("action.openReview")}
          </Link>
        ) : null;
      case "open_pr":
        return latestPr ? (
          <a
            className={linkClass}
            href={latestPr.url}
            rel="noreferrer"
            target="_blank"
          >
            {t("action.openPr", { number: latestPr.number ?? "?" })}
          </a>
        ) : null;
      case "complete":
        return canAct ? (
          <TaskCompleteAction
            expectedRevision={detail.task.revision}
            labels={{
              complete: t("completeTask"),
              completing: t("completingTask"),
              error: t("completeTaskFailed"),
            }}
            slug={slug}
            taskNumber={detail.task.number}
          />
        ) : null;
      case "run_again":
        return relaunch(t("runAgain"));
      case "new_attempt":
        return relaunch(t("startNewAttempt"), t("startNewAttemptHint"));
      case "result":
        return (
          <a className={linkClass} href="#task-result">
            {t("action.viewResult")}
          </a>
        );
      case "abandoned":
        return (
          <span className="font-mono text-[11px] text-mute">
            {t("status.Abandoned")}
          </span>
        );
      case "queue":
        return (
          <TaskQueueControls
            canAct={canAct}
            labels={{
              priorityLow: tBoard("priorityLow"),
              priorityNormal: tBoard("priorityNormal"),
              priorityHigh: tBoard("priorityHigh"),
              priorityUrgent: tBoard("priorityUrgent"),
              pause: tBoard("queuePause"),
              resume: tBoard("queueResume"),
              paused: tBoard("queuePaused"),
              error: tBoard("editErrorGeneric"),
            }}
            queuePaused={detail.task.queuePaused}
            slug={slug}
            taskNumber={detail.task.number}
            taskPriority={detail.task.priority}
          />
        );
      case "run_agent":
      case "send_to_triage": {
        const both = nextAction.secondary.includes("run_agent");

        // One control renders both entries when both are offered.
        if (action === "send_to_triage" && both) return null;

        return canAct ? (
          <TaskAgentActions
            agents={action === "run_agent" ? manualAgents : []}
            labels={{
              runAgent: t("runAgent"),
              sendToTriage: t("sendToTriage"),
              busy: t("agentActionBusy"),
              agentPickerLabel: t("agentPickerLabel"),
              errorGeneric: t("agentActionFailed"),
            }}
            showSendToTriage={nextAction.secondary.includes("send_to_triage")}
            slug={slug}
            taskId={detail.task.id}
            taskNumber={detail.task.number}
          />
        ) : null;
      }
    }
  };

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
            {detail.task.source ? (
              <TaskSourceChip
                kindLabel={
                  t.has(`sourceKind.${detail.task.source.kind}`)
                    ? t(`sourceKind.${detail.task.source.kind}`)
                    : detail.task.source.kind
                }
                source={detail.task.source}
              />
            ) : null}
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
            {detail.task.triageConfidence != null ? (
              <span className="rounded border border-line px-1.5 py-px uppercase tracking-[0.08em] text-mute">
                {t("confidence", {
                  value: Math.round(detail.task.triageConfidence * 100),
                })}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {/* D10: one primary next action; the rest live under "More". */}
            <div data-testid="task-primary-action">
              {renderAction(nextAction.primary, true)}
            </div>
            {nextAction.secondary.length > 0 ? (
              <details className="relative" data-testid="task-more-actions">
                <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-md border border-line bg-paper px-2.5 font-mono text-[11px] font-semibold text-ink-2 hover:border-amber hover:text-amber">
                  {t("moreActions")}
                </summary>
                <div className="absolute right-0 z-20 mt-1 flex min-w-[220px] flex-col gap-2 rounded-lg border border-line bg-paper p-2 shadow-lg">
                  {nextAction.secondary.map((action) => (
                    <div key={action}>{renderAction(action, false)}</div>
                  ))}
                </div>
              </details>
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
        {detail.task.status === "Done" ? (
          <TaskResultCard
            artifactLabels={artifactLabels}
            labels={{
              title: t("resultTitle"),
              resolvingRun: t("resolvingRun"),
              resolvingUnknown: t("resolvingUnknown"),
              openChanges: t("openChanges"),
            }}
            resolvingRun={resolvingRun}
          />
        ) : null}
        {detail.completionRefusal ? (
          <p
            className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 text-[12px] text-amber"
            data-testid="task-completion-refusal"
            role="status"
          >
            {t("completionRefused", {
              reason: t(`refusalReason.${detail.completionRefusal.reason}`),
            })}
          </p>
        ) : null}
        <details
          className="rounded-lg border border-line-soft bg-paper p-3"
          data-testid="task-statement"
          open={
            detail.task.status !== "Done" &&
            detail.task.prompt.split("\n").length <= STATEMENT_PREVIEW_LINES
          }
        >
          <summary className="cursor-pointer list-none">
            <span className="line-clamp-3 whitespace-pre-line text-[13px] text-ink-2">
              {detail.task.prompt}
            </span>
            <span className="mt-1 block font-mono text-[11px] text-amber">
              {t("statementShowFull")}
            </span>
          </summary>
          <div className="mt-2">
            <TaskDetailPromptEditor
              canEdit={canAct}
              prompt={detail.task.prompt}
              slug={slug}
              taskNumber={detail.task.number}
            />
          </div>
        </details>
        <TaskClarificationHistory
          awaitingClarification={detail.task.awaitingClarification}
          history={detail.task.clarifications}
          labels={{
            answer: t("clarificationAnswer"),
            awaiting: t("awaitingClarification"),
            question: t("clarificationQuestion"),
            title: t("clarificationsTitle"),
          }}
        />
        <TaskUserClarifications
          canAct={canAct}
          history={detail.task.clarifications}
          labels={{
            title: t("clarificationsTitle"),
            blocking: t("clarificationBlocking"),
            nonBlocking: t("clarificationNonBlocking"),
            requestedBy: t("clarificationRequestedBy"),
            recipient: t("clarificationRecipient"),
            reason: t("clarificationReason"),
            open: t("clarificationOpen"),
            answered: t("clarificationAnswered"),
            cancelled: t("clarificationCancelled"),
            superseded: t("clarificationSuperseded"),
            answer: t("clarificationAnswer"),
            submit: t("clarificationSubmit"),
            cancel: t("clarificationCancel"),
            recipientUnavailable: t("clarificationRecipientUnavailable"),
            yes: t("clarificationYes"),
            no: t("clarificationNo"),
          }}
          nameById={nameById}
          recipientEligibleById={recipientEligibleById}
          slug={slug}
          taskNumber={detail.task.number}
          userId={user.id}
        />
        <RelationsEditor
          collapsedForm
          canEdit={canAct}
          labels={{
            title: t("relationsTitle"),
            openForm: t("relationsOpenForm"),
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
      {isManualTriageHold(detail.task) ? (
        <TaskLaunchHoldControl
          canAct={canAct}
          origin={
            detail.task.triageFlagOrigin === "explicit" ||
            detail.task.triageFlagOrigin === "dispatch_failure"
              ? detail.task.triageFlagOrigin
              : "unknown"
          }
          revision={detail.task.revision}
          taskId={detail.task.id}
        />
      ) : null}
      {qualification ? (
        <details
          className="rounded-lg border border-line-soft bg-paper p-3"
          data-testid="task-qualification-section"
          id="task-qualification"
          open={!qualificationSettled}
        >
          <summary className="cursor-pointer text-[12px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("qualificationTitle")}
            {qualification.decision ? ` · ${qualification.decision}` : ""}
          </summary>
          <div className="mt-2">
            <TaskQualificationControl
              canAct={canAct}
              slug={slug}
              summary={qualification}
              taskId={detail.task.id}
            />
          </div>
        </details>
      ) : null}

      {launchConfig ? (
        <details
          className="flex flex-col gap-2"
          data-testid="task-next-launch-settings"
        >
          <summary className="cursor-pointer text-[12px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("nextLaunchSettings")}
            <span className="ml-2 font-normal normal-case tracking-normal">
              {t("nextLaunchSettingsHint")}
            </span>
          </summary>
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
        </details>
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
            </div>
          ) : null}
        </div>
        {detail.totals.runCount > 0 ? (
          <p
            className="m-0 font-mono text-[11px] tabular-nums text-mute"
            data-testid="task-run-aggregates"
          >
            {t("runsTokensLine", {
              total: formatTokenCount(locale, detail.totals.tokenTotal),
              input: formatTokenCount(locale, detail.totals.inputTokens),
              output: formatTokenCount(locale, detail.totals.outputTokens),
              cache: formatTokenCount(
                locale,
                detail.totals.cacheReadTokens +
                  detail.totals.cacheCreationTokens,
              ),
            })}
          </p>
        ) : null}
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
                  <th className="px-3 py-2 text-right font-semibold tabular-nums">
                    {tTiming("duration")}
                  </th>
                  <th className="px-3 py-2 text-right font-semibold tabular-nums">
                    {tTiming("execution")}
                  </th>
                  <th className="px-3 py-2 text-right font-semibold tabular-nums">
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
                    <td className="px-3 py-2">
                      <span className="rounded-full border border-line bg-ivory px-2 py-0.5 font-mono text-[10.5px] font-semibold">
                        {tRunStatus.has(run.status)
                          ? tRunStatus(run.status)
                          : run.status}
                      </span>
                      {run.resolving ? (
                        <span
                          className="ml-1.5 font-mono text-[10px] font-semibold text-good"
                          data-testid="task-run-resolving"
                        >
                          {t("resolvingBadge")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-mono text-[10.5px] text-mute">
                        {run.delivery.strategy === "publish_branch"
                          ? tLaunch("strategyPublishBranch")
                          : (run.delivery.strategy ?? "—")}
                      </div>
                      <TaskRunArtifactView
                        artifact={run.delivery.artifact}
                        labels={artifactLabels}
                      />
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {formatDurationMs(run.timing?.durationMs ?? null, {
                        h: tTiming("units.h"),
                        min: tTiming("units.min"),
                        s: tTiming("units.s"),
                      })}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {run.timing ? (
                        <RunTimingFacts
                          testId={`task-run-timing-${run.id}`}
                          timing={run.timing}
                        />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {run.tokenTotal === null
                        ? "—"
                        : formatTokenCount(locale, run.tokenTotal)}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      <LocalTime iso={run.startedAt} />
                    </td>
                    <td className="px-3 py-2 font-mono">
                      <LocalTime iso={run.endedAt} />
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
              errorTimeout: t("composerErrorTimeout"),
              errorGeneric: t("errorGeneric"),
              mentionListLabel: t("composerMentionListLabel"),
              mentionMatchCount: t("composerMentionMatchCount"),
            }}
            mentionCandidates={mentionCandidates}
            slug={slug}
            taskNumber={detail.task.number}
          />
        ) : null}
      </section>

      {graph ? (
        <LazyDisclosure summary={t("latestRunTitle")} testId="task-run-graph">
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
        </LazyDisclosure>
      ) : null}

      {detail.latestFlowRun ? (
        <LazyDisclosure summary={t("runDiffTitle")} testId="task-run-diff">
          <RunDiff labels={diffLabels} runId={detail.latestFlowRun.id} />
        </LazyDisclosure>
      ) : null}
    </div>
  );
}
