"use client";

import type { ReactElement } from "react";
import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";

import { ArrowPathIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Button } from "@heroui/react";
import { useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";

import { RunStreamLiveness } from "@/components/feedback/run-stream-liveness";
import { useAttentionStream } from "@/lib/use-attention-stream";
import { taskLaunchReasonKey } from "@/lib/tasks/launch-reason";

export { taskLaunchReasonKey } from "@/lib/tasks/launch-reason";

export function TaskLaunchIntentStatus({
  receipt,
  busy,
  uncertain,
  errorReason,
  onRefresh,
  onRetryRequest,
  onCancel,
  onReplace,
  onNewLaunch,
}: {
  receipt: TaskLaunchReceipt | null;
  busy: boolean;
  uncertain: boolean;
  errorReason: string | null;
  onRefresh: () => Promise<void>;
  onRetryRequest: () => Promise<void>;
  onCancel: () => Promise<void>;
  onReplace: () => void;
  onNewLaunch: () => void;
}): ReactElement {
  const t = useTranslations("launch");
  const locale = useLocale();
  const { tick, liveness, reconnect } = useAttentionStream();

  useEffect(() => {
    if (tick > 0) void onRefresh();
  }, [tick, onRefresh]);
  useEffect(() => {
    if (liveness === "live") void onRefresh();
  }, [liveness, onRefresh]);
  const canChange =
    receipt &&
    !uncertain &&
    ["queued", "preparing", "held", "run_bound"].includes(receipt.state) &&
    (!receipt.runId || receipt.runStatus === "Pending");
  const complete =
    receipt && ["cancelled", "failed", "settled"].includes(receipt.state);
  const stateKey = complete
    ? receipt.state
    : receipt?.state === "held"
      ? "held"
      : receipt?.queueReason === "capacity" ||
          receipt?.runStatus === "Pending" ||
          receipt?.reason === "launch_parent_capacity_wait" ||
          receipt?.reason === "launch_capacity_wait"
        ? "waiting"
        : receipt?.state === "queued"
          ? "queued"
          : receipt?.state === "preparing"
            ? "preparing"
            : receipt?.state === "run_bound"
              ? "running"
              : (receipt?.state ?? "accepted");
  const deliveryStrategy = receipt?.snapshot.deliveryPolicy?.strategy;
  const deliveryKey =
    deliveryStrategy === "publish_branch"
      ? "strategyPublishBranch"
      : deliveryStrategy === "rebase_merge"
        ? "strategyRebaseMerge"
        : deliveryStrategy === "ai_rebase_merge"
          ? "strategyAiRebaseMerge"
          : deliveryStrategy === "pull_request" ||
              receipt?.snapshot.promotionMode === "pull_request"
            ? "strategyPullRequest"
            : "strategyMerge";

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="task-launch-intent-status"
    >
      {uncertain ? (
        <p
          className="rounded-md border border-amber-line bg-amber-soft p-3 text-sm text-amber"
          role="alert"
        >
          {t("admission.uncertain")}
        </p>
      ) : null}
      {receipt ? (
        <>
          <p className="text-sm font-semibold" role="status">
            {t(`admission.${stateKey}`)}
          </p>
          <p className="text-sm text-ink-2">
            {t(`admission.${receipt.basis}`)}
          </p>
          <dl className="grid gap-3 rounded-lg border border-line-soft bg-ivory/50 p-3 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-mute">{t("admission.revision")}</dt>
              <dd>{receipt.taskRevision}</dd>
            </div>
            {receipt.snapshot.flowRefId ? (
              <div>
                <dt className="text-mute">{t("flow")}</dt>
                <dd>{receipt.snapshot.flowRefId}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-mute">{t("admission.runners")}</dt>
              <dd>
                {receipt.snapshot.sessions
                  ?.map(
                    (slot) =>
                      `${slot.sessionName}: ${slot.runnerId} · ${slot.model}`,
                  )
                  .join(", ") ?? receipt.snapshot.runnerIds.join(", ")}
              </dd>
            </div>
            {deliveryStrategy !== "publish_branch" ? (
              <div>
                <dt className="text-mute">{t("admission.target")}</dt>
                <dd>{receipt.snapshot.targetBranch}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-mute">{t("admission.delivery")}</dt>
              <dd>{t(deliveryKey)}</dd>
            </div>
            <div>
              <dt className="text-mute">{t("admission.promotion")}</dt>
              <dd>
                {t(
                  deliveryStrategy === "publish_branch" ||
                    (receipt.snapshot.autoPromote &&
                      receipt.snapshot.deliveryPolicy?.trigger ===
                        "auto_on_ready")
                    ? "triggerAutoOnReady"
                    : "triggerManual",
                )}
              </dd>
            </div>
            <div>
              <dt className="text-mute">{t("admission.acceptedAt")}</dt>
              <dd>
                <time dateTime={receipt.acceptedAt}>
                  {new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(receipt.acceptedAt))}
                </time>
              </dd>
            </div>
          </dl>
          {!complete && receipt.state !== "held" && receipt.queuePosition ? (
            <p role="status">
              {t("admission.queuePosition", {
                position: receipt.queuePosition,
              })}
            </p>
          ) : null}
          {receipt.reason ? (
            <p role="note">{t(taskLaunchReasonKey(receipt.reason))}</p>
          ) : null}
        </>
      ) : null}
      {errorReason && errorReason !== "launch_response_unknown" ? (
        <p role="alert">{t(taskLaunchReasonKey(errorReason))}</p>
      ) : null}
      <RunStreamLiveness
        labels={{
          live: t("admission.live"),
          disconnected: t("admission.disconnected"),
          reconnecting: t("admission.reconnecting"),
          reconnect: t("admission.reconnect"),
        }}
        liveness={liveness}
        onReconnect={reconnect}
      />
      <div className="flex flex-wrap gap-2">
        {uncertain ? (
          <Button
            isDisabled={busy}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void onRetryRequest()}
          >
            <ArrowPathIcon aria-hidden="true" className="size-4" />
            {t("admission.retryRequest")}
          </Button>
        ) : null}
        {receipt ? (
          <Button
            isDisabled={busy}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void onRefresh()}
          >
            <ArrowPathIcon aria-hidden="true" className="size-4" />
            {t("admission.refresh")}
          </Button>
        ) : null}
        {canChange ? (
          <Button
            isDisabled={busy}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void onCancel()}
          >
            <XMarkIcon aria-hidden="true" className="size-4 text-rose-600" />
            {t("admission.cancel")}
          </Button>
        ) : null}
        {canChange && receipt.state === "held" ? (
          <Button
            isDisabled={busy}
            size="sm"
            type="button"
            variant="primary"
            onClick={onReplace}
          >
            {t("admission.replace")}
          </Button>
        ) : null}
        {receipt?.runId ? (
          <Link
            className="self-center text-sm font-semibold text-amber underline"
            href={`/runs/${receipt.runId}`}
          >
            {t(
              receipt.runStatus === "Crashed"
                ? "admission.recoveryOnRun"
                : receipt.terminalOutcome === "Failed"
                  ? "admission.retryOnRun"
                  : "admission.openRun",
            )}
          </Link>
        ) : null}
        {complete && !uncertain ? (
          <Button
            isDisabled={busy}
            size="sm"
            type="button"
            variant="outline"
            onClick={onNewLaunch}
          >
            {t("admission.newLaunch")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
