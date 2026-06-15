import type { ReactElement } from "react";
import type { RunStatus, TaskStatus } from "@/lib/db/schema";

import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";

import { LaunchPopover } from "@/components/board/launch-popover";
import { type FlowGraphViewLabels } from "@/components/board/flow-graph-view";
import { FlowGraphViewSection } from "@/components/board/flow-graph-view-section";
import { CommentComposer } from "@/components/social/comment-composer";
import { FollowButton } from "@/components/social/follow-button";
import { TaskAgentActions } from "@/components/social/task-agent-actions";
import { MarkdownBody } from "@/components/social/markdown-body";
import { RelationsEditor } from "@/components/social/relations-editor";
import { TaskTimeline } from "@/components/social/task-timeline";
import RunDiff from "@/components/workbench/run-diff";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { compileManifest } from "@/lib/flows/graph/compile";
import { presentationLayout } from "@/lib/flows/graph/presentation-layout";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";
import { loadRunManifest } from "@/lib/queries/run-manifest";
import { getRunNodeStatuses } from "@/lib/queries/run-node-status";
import { getProjectAgentsView } from "@/lib/agents/project-links";
import { getTaskDetail } from "@/lib/queries/task-detail";
import { classifyManualTaskLaunchability } from "@/lib/runs/launchability";
import { getPlatformStatus } from "@/lib/supervisor-client";

type PageProps = {
  params: Promise<{ slug: string; number: string }>;
};

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

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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
  const [t, platformStatus] = await Promise.all([
    getTranslations("taskDetail"),
    getPlatformStatus(),
  ]);
  const manualLaunchability = classifyManualTaskLaunchability(
    { status: detail.task.status as TaskStatus },
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

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 font-mono text-[11px] text-mute">
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
        </div>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-[20px] font-semibold leading-tight text-ink">
            {detail.task.title}
          </h1>
          <div className="flex flex-wrap items-center justify-end gap-2">
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
                label={t("runAgain")}
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
          </div>
        </div>
        <div className="rounded-lg border border-line-soft bg-paper p-3">
          <MarkdownBody text={detail.task.prompt} />
        </div>
        <RelationsEditor
          canEdit={canAct}
          labels={{
            title: t("relationsTitle"),
            empty: t("relationsEmpty"),
            add: t("relationsAdd"),
            adding: t("relationsAdding"),
            numberPlaceholder: t("relationsNumberPlaceholder"),
            remove: t("relationsRemove"),
            kindOut: {
              blocks: t("relationKind.blocks"),
              depends_on: t("relationKind.dependsOn"),
              parent_of: t("relationKind.parentOf"),
            },
            kindIn: {
              blocks: t("relationKindInverse.blocks"),
              depends_on: t("relationKindInverse.dependsOn"),
              parent_of: t("relationKindInverse.parentOf"),
            },
            errorConfig: t("relationsErrorConfig"),
            errorNotFound: t("relationsErrorNotFound"),
            errorForbidden: t("errorForbidden"),
            errorGeneric: t("errorGeneric"),
          }}
          relations={detail.relations}
          slug={slug}
          taskNumber={detail.task.number}
        />
      </header>

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

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("runsTitle")}
          </h2>
          {detail.totals.runCount > 0 ? (
            <span className="rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] font-bold tracking-[0.04em] text-ink-2">
              {t("runsCount", { count: detail.totals.runCount })}
            </span>
          ) : null}
        </div>
        <div
          className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-5"
          data-testid="task-run-aggregates"
        >
          {[
            [t("aggregateRuns"), String(detail.totals.runCount)],
            [t("aggregateInput"), formatTokens(detail.totals.inputTokens)],
            [t("aggregateOutput"), formatTokens(detail.totals.outputTokens)],
            [
              t("aggregateCache"),
              formatTokens(
                detail.totals.cacheReadTokens +
                  detail.totals.cacheCreationTokens,
              ),
            ],
            [t("aggregateTokenTotal"), formatTokens(detail.totals.tokenTotal)],
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
                      {formatTokens(run.tokenTotal)}
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

      {graph ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("latestRunTitle")}
          </h2>
          <FlowGraphViewSection
            labels={graph.labels}
            layout={graph.layout}
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
