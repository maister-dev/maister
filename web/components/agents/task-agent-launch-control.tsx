"use client";

import type { StoredDeliveryPolicy } from "@/lib/runs/delivery-policy";
import type { ReactElement } from "react";
import type { TaskLaunchOptionsSnapshot } from "@/lib/tasks/launch-options";
import type { NodeEnforcementRefusal } from "@/lib/flows/enforcement-refusal";

import { useEffect, useId, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import { useTaskLaunchIntent } from "@/components/board/use-task-launch-intent";
import { TaskEnforcementRefusalNotice } from "@/components/board/task-enforcement-refusal-notice";
import { nodeEnforcementRefusalSchema } from "@/lib/flows/enforcement-refusal";
import {
  TaskLaunchIntentStatus,
  taskLaunchReasonKey,
} from "@/components/board/task-launch-intent-status";
import { TaskQualificationSourceFailureNotice } from "@/components/agents/task-qualification-source-failure-notice";

type AgentWorkspace = "none" | "repo_read" | "worktree";
const WORKSPACES: readonly AgentWorkspace[] = ["none", "repo_read", "worktree"];

const PUBLISH_BRANCH_POLICY: StoredDeliveryPolicy = {
  strategy: "publish_branch",
  push: "on_success",
  trigger: "auto_on_ready",
  targetBranch: null,
};

function isWorkspace(value: string): value is AgentWorkspace {
  return WORKSPACES.some((workspace) => workspace === value);
}

/** Reading settings and choosing a runner are separate from the explicit one-shot Launch action. */
export function TaskAgentLaunchControl({
  taskId,
  agentId,
  target,
  label,
}: {
  taskId: string;
  agentId: string;
  target:
    | Readonly<{ kind: "agent"; workspace: AgentWorkspace }>
    | Readonly<{ kind: "flow" }>;
  label: string;
}): ReactElement {
  const t = useTranslations("launch");
  const controlId = useId();
  const [open, setOpen] = useState(false);
  const [workspace, setWorkspace] = useState<AgentWorkspace>(
    target.kind === "agent" ? target.workspace : "worktree",
  );
  const [publishBranch, setPublishBranch] = useState(false);
  const [runnerId, setRunnerId] = useState("");
  const [reload, setReload] = useState(0);
  const [preview, setPreview] = useState<{
    key: string;
    snapshot: TaskLaunchOptionsSnapshot;
  } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewEnforcement, setPreviewEnforcement] = useState<Readonly<{
    key: string;
    refusal: NodeEnforcementRefusal;
  }> | null>(null);
  const [replacement, setReplacement] = useState<{
    intentId: string;
    stateVersion: number;
  } | null>(null);
  const intent = useTaskLaunchIntent(taskId, "ordinary");
  const replacementCurrent =
    replacement &&
    (!intent.receipt || intent.receipt.intentId === replacement.intentId)
      ? replacement
      : null;
  const tracking =
    !replacementCurrent && Boolean(intent.receipt || intent.uncertain);
  const canPublishBranch = target.kind === "flow" || workspace === "worktree";
  const selectPublishBranch = canPublishBranch && publishBranch;
  const selection = useMemo(
    () => ({
      taskId,
      agentId,
      ...(target.kind === "agent" ? { workspace } : {}),
      ...(runnerId ? { runnerId } : {}),
      ...(selectPublishBranch ? { deliveryPolicy: PUBLISH_BRANCH_POLICY } : {}),
    }),
    [taskId, agentId, workspace, runnerId, target.kind, selectPublishBranch],
  );
  const key = JSON.stringify(selection);
  const currentPreview = preview?.key === key ? preview.snapshot : null;
  const publishesBranch =
    currentPreview?.target?.deliveryPolicy.strategy === "publish_branch";
  const enforcementRefusal =
    previewEnforcement?.key === key ? previewEnforcement.refusal : null;

  useEffect(() => {
    if (!open || tracking || intent.attempt || intent.busy) return;
    const controller = new AbortController();
    const { deliveryPolicy, ...params } = selection;
    const query = new URLSearchParams(params);

    if (deliveryPolicy)
      query.set("deliveryPolicy", JSON.stringify(deliveryPolicy));

    void fetch(`/api/task-launch-intents/options?${query}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload: unknown = await response.json();
          const refusal = nodeEnforcementRefusalSchema.safeParse(
            payload && typeof payload === "object" && "details" in payload
              ? payload.details
              : null,
          );

          if (refusal.success && !controller.signal.aborted) {
            setPreviewEnforcement({ key, refusal: refusal.data });
            setPreviewFailed(true);

            return;
          }
          throw new Error("Agent launch preview unavailable");
        }
        const snapshot = (await response.json()) as TaskLaunchOptionsSnapshot;

        if (
          snapshot.taskId !== taskId ||
          !snapshot.target ||
          snapshot.target.agentId !== agentId ||
          snapshot.target.kind !== target.kind ||
          (target.kind === "agent" &&
            snapshot.target.workspace !== workspace) ||
          !Array.isArray(snapshot.target.sessions) ||
          !snapshot.target.sessions.every(
            (slot) => slot && typeof slot.model === "string",
          ) ||
          !Array.isArray(snapshot.target.runners) ||
          !snapshot.target.runners.every(
            (runner) =>
              runner &&
              typeof runner.id === "string" &&
              typeof runner.model === "string",
          ) ||
          !Number.isSafeInteger(snapshot.taskRevision) ||
          snapshot.taskRevision < 0 ||
          typeof snapshot.settingsToken !== "string" ||
          snapshot.settingsToken.length === 0
        )
          throw new Error("Agent launch preview invalid");
        if (!controller.signal.aborted) {
          setPreview({ key, snapshot });
          setPreviewFailed(false);
          setPreviewEnforcement(null);
          if (snapshot.activeLaunch && !intent.attempt && !intent.busy)
            intent.observe(snapshot.activeLaunch);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPreviewEnforcement(null);
          setPreviewFailed(true);
        }
      });

    return () => controller.abort();
  }, [
    open,
    tracking,
    selection,
    key,
    taskId,
    agentId,
    workspace,
    target.kind,
    reload,
    intent.receipt,
    intent.attempt,
    intent.busy,
    intent.observe,
  ]);

  async function launch(): Promise<void> {
    if (!currentPreview || previewFailed || intent.busy || intent.attempt)
      return;
    await intent.submit(
      replacementCurrent
        ? `/api/task-launch-intents/${encodeURIComponent(replacementCurrent.intentId)}/replace`
        : "/api/task-launch-intents",
      {
        ...selection,
        expectedTaskRevision: currentPreview.taskRevision,
        expectedSettingsToken: currentPreview.settingsToken,
        ...(replacementCurrent
          ? { expectedStateVersion: replacementCurrent.stateVersion }
          : {}),
      },
    );
  }

  const qualification = currentPreview?.qualification;
  const explanation =
    qualification?.freshness === "current" && qualification.decision === "ready"
      ? "triageAccepted"
      : qualification?.freshness === "stale"
        ? "triageStale"
        : qualification?.sourceFailure ||
            qualification?.candidate?.publicationReason ===
              "qualification_source_failed"
          ? "triageFailed"
          : qualification?.decision && qualification.decision !== "ready"
            ? "triageNegative"
            : "triageMissing";
  const buttonClass =
    "inline-flex items-center rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em] text-ink transition-colors hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex flex-col gap-2">
      <button
        aria-controls={controlId}
        aria-expanded={open}
        className={buttonClass}
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open ? (
        <section
          aria-label={t("agent.title")}
          className="flex min-w-0 flex-col gap-3 rounded-lg border border-line-soft bg-paper p-3"
          id={controlId}
        >
          {tracking ? (
            <TaskLaunchIntentStatus
              busy={intent.busy}
              errorReason={intent.errorReason}
              receipt={intent.receipt}
              uncertain={intent.uncertain}
              onCancel={async () => {
                if (intent.receipt)
                  await intent.submit(
                    `/api/task-launch-intents/${encodeURIComponent(intent.receipt.intentId)}/cancel`,
                    { expectedStateVersion: intent.receipt.stateVersion },
                  );
              }}
              onNewLaunch={() => {
                intent.clearCompleted();
                setPreview(null);
                setPreviewFailed(false);
                setReload((value) => value + 1);
              }}
              onRefresh={intent.refresh}
              onReplace={() => {
                if (intent.receipt) {
                  setReplacement({
                    intentId: intent.receipt.intentId,
                    stateVersion: intent.receipt.stateVersion,
                  });
                  setPreview(null);
                  setPreviewFailed(false);
                  setReload((value) => value + 1);
                }
              }}
              onRetryRequest={intent.retryRequest}
            />
          ) : (
            <>
              <p className="text-sm font-semibold">{t("agent.title")}</p>
              {target.kind === "agent" ? (
                <label className="flex flex-col gap-1 text-sm">
                  {t("agent.workspace")}
                  <select
                    className="rounded-md border border-line-soft bg-paper px-2 py-1.5"
                    disabled={intent.busy}
                    value={workspace}
                    onChange={(event) => {
                      if (isWorkspace(event.target.value)) {
                        setWorkspace(event.target.value);
                        setPreviewFailed(false);
                      }
                    }}
                  >
                    {WORKSPACES.map((value) => (
                      <option key={value} value={value}>
                        {t(`agent.workspaceOptions.${value}`)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {preview?.snapshot.target ? (
                <label className="flex flex-col gap-1 text-sm">
                  {t("agent.runner")}
                  <select
                    className="rounded-md border border-line-soft bg-paper px-2 py-1.5"
                    disabled={intent.busy}
                    value={runnerId}
                    onChange={(event) => {
                      setRunnerId(event.target.value);
                      setPreviewFailed(false);
                    }}
                  >
                    <option value="">{t("agent.runnerDefault")}</option>
                    {preview.snapshot.target.runners.map((runner) => (
                      <option key={runner.id} value={runner.id}>
                        {runner.capabilityAgent} · {runner.model}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {canPublishBranch ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    checked={publishBranch}
                    disabled={intent.busy}
                    type="checkbox"
                    onChange={(event) => setPublishBranch(event.target.checked)}
                  />
                  {t("strategyPublishBranch")}
                </label>
              ) : null}
              {currentPreview?.target ? (
                <>
                  {currentPreview.target.flowRefId ? (
                    <p>
                      {t("flow")}: {currentPreview.target.flowRefId}
                    </p>
                  ) : null}
                  <p role="status">
                    {t("agent.selectedModel", {
                      model: currentPreview.target.sessions
                        .map((slot) => slot.model)
                        .join(", "),
                    })}
                  </p>
                  <p>
                    {t("admission.revision")}: {currentPreview.taskRevision}
                  </p>
                  <dl className="grid gap-2 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-mute">{t("admission.delivery")}</dt>
                      <dd>
                        {t(
                          publishesBranch
                            ? "strategyPublishBranch"
                            : currentPreview.target.deliveryPolicy.strategy ===
                                "pull_request"
                              ? "strategyPullRequest"
                              : currentPreview.target.deliveryPolicy
                                    .strategy === "rebase_merge"
                                ? "strategyRebaseMerge"
                                : currentPreview.target.deliveryPolicy
                                      .strategy === "ai_rebase_merge"
                                  ? "strategyAiRebaseMerge"
                                  : "strategyMerge",
                        )}
                      </dd>
                    </div>
                    {!publishesBranch ? (
                      <div>
                        <dt className="text-mute">{t("admission.target")}</dt>
                        <dd>{currentPreview.target.targetBranch}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt className="text-mute">{t("admission.promotion")}</dt>
                      <dd>
                        {t(
                          publishesBranch ||
                            (currentPreview.target.autoPromote &&
                              currentPreview.target.deliveryPolicy.trigger ===
                                "auto_on_ready")
                            ? "triggerAutoOnReady"
                            : "triggerManual",
                        )}
                      </dd>
                    </div>
                  </dl>
                  <p role="note">{t(`admission.${explanation}`)}</p>
                  {qualification?.sourceFailure ? (
                    <TaskQualificationSourceFailureNotice
                      failure={qualification.sourceFailure}
                    />
                  ) : null}
                </>
              ) : !previewFailed ? (
                <p role="status">{t("loading")}</p>
              ) : null}
              {replacementCurrent ? (
                <p role="note">{t("admission.replaceHint")}</p>
              ) : null}
              {previewFailed ? (
                <div>
                  {enforcementRefusal ? (
                    <TaskEnforcementRefusalNotice
                      refusal={enforcementRefusal}
                    />
                  ) : (
                    <p role="alert">{t("optionsError")}</p>
                  )}
                  <button
                    className={buttonClass}
                    type="button"
                    onClick={() => {
                      setPreviewFailed(false);
                      setReload((value) => value + 1);
                    }}
                  >
                    {t("retryPreview")}
                  </button>
                </div>
              ) : null}
              {intent.errorReason === "flow_settings_enforcement_refused" &&
              intent.enforcementRefusal ? (
                <TaskEnforcementRefusalNotice
                  refusal={intent.enforcementRefusal}
                />
              ) : intent.errorReason ? (
                <p role="alert">{t(taskLaunchReasonKey(intent.errorReason))}</p>
              ) : null}
              <button
                className={buttonClass}
                disabled={
                  !currentPreview ||
                  previewFailed ||
                  intent.busy ||
                  Boolean(intent.attempt) ||
                  intent.errorReason === "launch_storage_unavailable"
                }
                type="button"
                onClick={() => void launch()}
              >
                {t("createRun")}
              </button>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
