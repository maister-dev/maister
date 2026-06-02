import type { EnforcementSnapshotEntry } from "@/lib/db/schema";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";

import { AssignmentActions } from "@/components/board/assignment-actions";
import { EvidenceGraphSection } from "@/components/board/evidence-graph-section";
import { type EvidenceGraphLabels } from "@/components/board/evidence-graph";
import {
  FlowSettingsPanel,
  type FlowSettingsPanelLabels,
} from "@/components/board/panels/flow-settings-panel";
import { RunHitlResponse } from "@/components/board/run-hitl-response";
import { RunTakeoverActions } from "@/components/board/run-takeover-actions";
import {
  RunTimeline,
  type TimelineEntry,
  type TimelineLabels,
} from "@/components/board/run-timeline";
import { RunRecoverActions } from "@/components/runs/run-recover-actions";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { buildEvidenceGraph } from "@/lib/queries/evidence-graph";
import {
  getRunDetail,
  getRunSettings,
  getRunTimeline,
} from "@/lib/queries/run";

type RouteParams = { params: Promise<{ runId: string }> };

function offersTakeover(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as { review?: boolean; allowedDecisions?: string[] };

  return Boolean(s.review) && (s.allowedDecisions ?? []).includes("takeover");
}

function staleSummaryText(summary: Record<string, unknown> | null): string | null {
  if (summary === null) return null;
  const count = summary.count;

  if (typeof count === "number" && count > 0) {
    return String(count);
  }

  return "!";
}

export default async function RunDetailPage({
  params,
}: RouteParams): Promise<ReactElement> {
  const { runId } = await params;

  const user = await getSessionUser();

  if (!user) redirect("/login");

  const detail = await getRunDetail(runId);

  if (!detail) notFound();

  const role =
    user.role === "admin"
      ? "owner"
      : await getProjectRole(user.id, detail.projectId);

  // Hide existence from non-members (mirrors the project board page).
  if (!role) notFound();

  const canAct = role === "owner" || role === "admin" || role === "member";
  const t = await getTranslations("run");

  const timeline = await getRunTimeline(runId);
  const settings = await getRunSettings(runId);
  const evidence = await buildEvidenceGraph(runId);
  const tEvidence = await getTranslations("evidence");

  const evidenceLabels: EvidenceGraphLabels = {
    title: tEvidence("title"),
    empty: tEvidence("empty"),
    openPayload: tEvidence("openPayload"),
    payloadGone: tEvidence("payloadGone"),
    payloadError: tEvidence("payloadError"),
    payloadLoading: tEvidence("payloadLoading"),
    close: tEvidence("close"),
    filterNode: tEvidence("filterNode"),
    filterKind: tEvidence("filterKind"),
    filterState: tEvidence("filterState"),
    filterAny: tEvidence("filterAny"),
    stateCurrent: tEvidence("stateCurrent"),
    stateStale: tEvidence("stateStale"),
    stateSuperseded: tEvidence("stateSuperseded"),
    stateFailed: tEvidence("stateFailed"),
    stateSkipped: tEvidence("stateSkipped"),
    kindTaskInput: tEvidence("kindTaskInput"),
    kindNodeAttempt: tEvidence("kindNodeAttempt"),
    kindArtifact: tEvidence("kindArtifact"),
    kindGate: tEvidence("kindGate"),
    kindDecision: tEvidence("kindDecision"),
  };

  const settingsClassLabel: Record<EnforcementSnapshotEntry["class"], string> =
    {
      mcps: t("settingsClassMcps"),
      tools: t("settingsClassTools"),
      skills: t("settingsClassSkills"),
      restrictions: t("settingsClassRestrictions"),
      permissionMode: t("settingsClassPermissionMode"),
      workspaceAccess: t("settingsClassWorkspaceAccess"),
    };

  const settingsLabels: FlowSettingsPanelLabels = {
    title: t("settingsTitle"),
    declaredIntentNote: t("settingsDeclaredIntentNote"),
    verdictEnforced: t("settingsVerdictEnforced"),
    verdictInstructed: t("settingsVerdictInstructed"),
    verdictRefused: t("settingsVerdictRefused"),
    noConstraints: t("settingsNoConstraints"),
    refusalReason: t("settingsRefusalReason"),
    classLabel: (cls) => settingsClassLabel[cls],
  };

  const canClaim =
    detail.status === "NeedsInput" &&
    offersTakeover(detail.pendingHitl?.schema);
  const isHumanWorking = detail.status === "HumanWorking";

  const timelineLabels: TimelineLabels = {
    title: t("timelineTitle"),
    staleGate: t("staleGate"),
    currentGate: t("currentGate"),
    rerunRequired: t("rerunRequired"),
    handoff: t("handoff"),
    claimedBy: t("claimedBy"),
    elapsed: t("elapsed"),
    returnedCommits: t("returnedCommits"),
    returnedDiff: t("returnedDiff"),
    empty: t("timelineEmpty"),
    decisionLabel: (d) =>
      d === "approve"
        ? t("decisionApprove")
        : d === "rework"
          ? t("decisionRework")
          : d === "takeover"
            ? t("takeOver")
            : d,
  };

  return (
    <div className="mx-auto max-w-[760px]">
      <Link
        className="font-mono text-[11px] text-mute hover:text-ink"
        href={`/projects/${detail.projectSlug}`}
      >
        {t("backToBoard")}
      </Link>

      <header className="mb-6 mt-3 border-b border-line pb-5">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-mute">
          {t("eyebrow")} · {detail.projectSlug}
        </div>
        <h1 className="mt-1 font-mono text-[20px] font-bold tracking-[-0.01em] text-ink">
          {detail.branch}
        </h1>
        <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px] text-mute">
          <span className="rounded-full border border-line bg-ivory px-2.5 py-1 text-ink-2">
            {detail.status}
          </span>
          <span>{detail.agent}</span>
          {detail.currentStepId ? (
            <span>
              {t("step")} · {detail.currentStepId}
            </span>
          ) : null}
        </div>
      </header>

      {detail.status === "Crashed" ? (
        <section
          className="mb-6 rounded-[14px] border border-red-300 bg-red-50/60 p-5 dark:border-red-900/60 dark:bg-red-950/30"
          data-testid="run-crashed-section"
        >
          <h2 className="mb-1 inline-flex items-center gap-2 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-red-500 before:content-['']">
            {t("crashTitle")}
          </h2>
          {detail.recoverable ? (
            <p className="mb-4 text-[13px] leading-[1.4] text-body">
              {t("crashRecoverableHint")}
            </p>
          ) : (
            <p
              className="mb-4 text-[13px] leading-[1.4] text-body"
              data-testid="run-not-recoverable"
            >
              {t("notRecoverable")}
            </p>
          )}
          {/* Discard is available for EVERY Crashed run (it is the only path
              into the GC countdown); Recover is hidden when there is no
              resumable session. */}
          <RunRecoverActions
            canRecover={detail.recoverable}
            runId={detail.runId}
          />
        </section>
      ) : null}

      {detail.pendingHitl
        ? (() => {
            const staleText = staleSummaryText(
              detail.pendingHitl.assignmentStaleEvidenceSummary,
            );

            return (
              <section className="rounded-[14px] border border-amber-line bg-[color-mix(in_oklab,var(--amber-soft)_45%,var(--paper))] p-5">
          <h2 className="mb-1 inline-flex items-center gap-2 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-amber before:content-['']">
            {t("pendingTitle")}
          </h2>
          <p className="mb-4 text-[14px] leading-[1.4] text-ink">
            {detail.pendingHitl.prompt}
          </p>
          <div className="mb-4 flex flex-wrap gap-2 font-mono text-[10.5px] tracking-[0.02em] text-mute">
            {detail.pendingHitl.assignmentActionKind ? (
              <span className="rounded-md border border-amber-line bg-paper px-2 py-1 font-semibold text-ink-2">
                {t("assignmentAction", {
                  action: detail.pendingHitl.assignmentActionKind,
                })}
              </span>
            ) : null}
            {detail.pendingHitl.assignmentRoleRefs.length > 0 ? (
              <span className="rounded-md border border-amber-line bg-paper px-2 py-1 font-semibold text-ink-2">
                {t("assignmentRoles", {
                  roles: detail.pendingHitl.assignmentRoleRefs.join(", "),
                })}
              </span>
            ) : null}
            {staleText ? (
              <span className="rounded-md border border-amber-line bg-paper px-2 py-1 font-semibold text-amber">
                {t("assignmentStaleEvidence", {
                  count: staleText,
                })}
              </span>
            ) : null}
            <span className="rounded-md border border-amber-line bg-paper px-2 py-1 font-semibold text-ink-2">
              {detail.pendingHitl.assigneeLabel
                ? t("assignmentClaimedBy", {
                    actor: detail.pendingHitl.assigneeLabel,
                  })
                : t("assignmentUnclaimed")}
            </span>
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            <AssignmentActions
              assigneeUserId={detail.pendingHitl.assigneeUserId}
              assignmentId={detail.pendingHitl.assignmentId}
              canAct={canAct}
              currentUserId={user.id}
              labels={{
                claim: t("assignmentClaim"),
                release: t("assignmentRelease"),
                takeOver: t("assignmentTakeOver"),
              }}
              status={detail.pendingHitl.assignmentStatus}
            />
          </div>
          <RunHitlResponse
            canAct={canAct}
            hitlRequestId={detail.pendingHitl.hitlRequestId}
            kind={detail.pendingHitl.kind}
            options={detail.pendingHitl.options}
            runId={detail.runId}
            schema={detail.pendingHitl.schema}
          />
          {canClaim ? (
            <div className="mt-4 border-t border-dashed border-amber-line pt-4">
              <RunTakeoverActions
                branch={detail.branch}
                canAct={canAct}
                isOwner={false}
                mode="claimable"
                runId={detail.runId}
                worktreePath={detail.worktreePath}
              />
            </div>
          ) : null}
              </section>
            );
          })()
        : (
        <p className="rounded-[14px] border border-dashed border-line p-6 text-center font-mono text-[12px] text-mute">
          {t("noPending")}
        </p>
      )}

      {isHumanWorking ? (
        <section className="mt-6 rounded-[14px] border border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))] bg-accent-4-soft/30 p-5">
          <h2 className="mb-3 inline-flex items-center gap-2 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-accent-4 before:content-['']">
            {t("handoff")}
          </h2>
          <RunTakeoverActions
            branch={detail.branch}
            canAct={canAct}
            isOwner={detail.takeoverOwnerUserId === user.id}
            mode="working"
            runId={detail.runId}
            worktreePath={detail.worktreePath}
          />
        </section>
      ) : null}

      <RunTimeline
        entries={timeline.entries as TimelineEntry[]}
        labels={timelineLabels}
      />

      <section className="mt-6">
        <h2 className="mb-3 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
          {evidenceLabels.title}
        </h2>
        <EvidenceGraphSection
          graph={evidence}
          labels={evidenceLabels}
          runId={detail.runId}
        />
      </section>

      {settings ? (
        <FlowSettingsPanel
          labels={settingsLabels}
          nodes={settings.nodes}
          refusalReason={settings.refusalReason}
        />
      ) : null}
    </div>
  );
}
