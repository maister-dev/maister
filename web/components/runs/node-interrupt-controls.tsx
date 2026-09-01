"use client";

import type { ReactElement } from "react";

import {
  ArrowPathIcon,
  BackwardIcon,
  PlayIcon,
  StopIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";

export type NodeInterruptOptionId =
  | "resume"
  | "restart_node"
  | "restart_from"
  | "stop";

export type NodeInterruptWorkspacePolicy =
  | "keep"
  | "rewind-to-node-checkpoint"
  | "fresh-attempt";

export interface NodeInterruptControlsProps {
  interruptedNodeId: string;
  // Server-owned. The client renders what it is given and never re-derives
  // which options are available.
  options: Array<{
    optionId: NodeInterruptOptionId;
    enabled: boolean;
    disabledReason: string | null;
  }>;
  defaultOptionId: NodeInterruptOptionId;
  // Ledger-derived: nodes with >= 1 prior attempt in THIS run.
  restartTargets: Array<{ nodeId: string; recommended: boolean }>;
  canAct: boolean;
  // Presentational: the host owns the request, the busy flag, and the error, so
  // this widget answers through the SAME respond path as every other HITL kind
  // instead of keeping a second copy of it.
  onRespond: (payload: Record<string, unknown>) => void;
  busy?: boolean;
  error?: string | null;
}

const ICONS: Record<NodeInterruptOptionId, typeof PlayIcon> = {
  resume: PlayIcon,
  restart_node: ArrowPathIcon,
  restart_from: BackwardIcon,
  stop: StopIcon,
};

export function NodeInterruptControls({
  interruptedNodeId,
  options,
  defaultOptionId,
  restartTargets,
  canAct,
  onRespond,
  busy = false,
  error = null,
}: NodeInterruptControlsProps): ReactElement {
  const t = useTranslations("nodeInterrupt");
  const [correction, setCorrection] = useState("");
  const [workspacePolicy, setWorkspacePolicy] =
    useState<NodeInterruptWorkspacePolicy>("keep");
  const [showRestartFrom, setShowRestartFrom] = useState(false);
  const [targetNodeId, setTargetNodeId] = useState(
    restartTargets[0]?.nodeId ?? "",
  );

  const disabled = busy || !canAct;
  const [pendingConfirm, setPendingConfirm] =
    useState<NodeInterruptOptionId | null>(null);

  // `stop` terminalizes the run; a restart under a non-`keep` policy runs
  // `reset --hard` + `git clean -fd` against the target's checkpoint. Both are
  // irreversible from the UI, so they go through the shared confirmation
  // instead of firing on a single misclick. `resume` and a `keep` restart
  // change nothing the operator cannot undo, and stay one-click.
  function isIrreversible(optionId: NodeInterruptOptionId): boolean {
    if (optionId === "stop") return true;

    return (
      (optionId === "restart_node" || optionId === "restart_from") &&
      workspacePolicy !== "keep"
    );
  }

  function requestRespond(optionId: NodeInterruptOptionId): void {
    if (isIrreversible(optionId)) {
      setPendingConfirm(optionId);

      return;
    }

    respond(optionId);
  }

  function respond(optionId: NodeInterruptOptionId): void {
    setPendingConfirm(null);
    onRespond({
      optionId,
      ...(optionId === "restart_node" || optionId === "restart_from"
        ? {
            workspacePolicy,
            ...(correction.trim().length > 0
              ? { correction: correction.trim() }
              : {}),
          }
        : {}),
      ...(optionId === "restart_from" ? { targetNodeId } : {}),
    });
  }

  const byId = Object.fromEntries(options.map((o) => [o.optionId, o]));
  const buttonBase =
    "inline-flex w-max items-center gap-1.5 rounded-lg border px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em]";

  function optionButton(
    optionId: NodeInterruptOptionId,
    label: string,
    tone: string,
  ): ReactElement {
    const opt = byId[optionId];
    const off = disabled || opt?.enabled === false;
    const Icon = ICONS[optionId];

    return (
      <button
        aria-label={label}
        className={clsx(buttonBase, tone, off && "opacity-60")}
        disabled={off}
        title={opt?.disabledReason ?? undefined}
        type="button"
        onClick={() => requestRespond(optionId)}
      >
        <Icon aria-hidden className="size-4" />
        {label}
        {optionId === defaultOptionId ? (
          <span className="ml-1 rounded-[4px] border border-current px-1 text-[9px]">
            {t("default")}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-[11px] text-mute">
        {t("interrupted", { node: interruptedNodeId })}
      </p>

      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
          {t("correctionLabel")}
        </span>
        <textarea
          className="min-h-[72px] rounded-[6px] border border-line-soft bg-paper px-2 py-1 font-mono text-[11px] text-ink-2"
          maxLength={4000}
          placeholder={t("correctionPlaceholder")}
          value={correction}
          onChange={(e) => setCorrection(e.currentTarget.value)}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
          {t("workspacePolicyLabel")}
        </span>
        <select
          className="w-max rounded-[6px] border border-line-soft bg-paper px-2 py-1 font-mono text-[11px] text-ink-2"
          value={workspacePolicy}
          onChange={(e) =>
            setWorkspacePolicy(
              e.currentTarget.value as NodeInterruptWorkspacePolicy,
            )
          }
        >
          <option value="keep">{t("policyKeep")}</option>
          <option value="rewind-to-node-checkpoint">{t("policyRewind")}</option>
          <option value="fresh-attempt">{t("policyFresh")}</option>
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        {optionButton(
          "restart_node",
          t("restartNode"),
          "border-amber bg-amber text-white hover:bg-amber-2",
        )}
        {optionButton(
          "resume",
          t("resume"),
          "border-line bg-paper text-ink-2 hover:text-ink",
        )}
        {optionButton(
          "stop",
          t("stop"),
          "border-line bg-paper text-mute hover:text-ink-2",
        )}
      </div>

      {/* Progressive disclosure: the rarer jump-back lives behind a toggle so
          the one-click default stays the obvious action. */}
      {byId.restart_from?.enabled && restartTargets.length > 0 ? (
        <div className="flex flex-col gap-2">
          <button
            className="w-max font-mono text-[11px] text-mute underline hover:text-ink-2"
            type="button"
            onClick={() => setShowRestartFrom((v) => !v)}
          >
            {showRestartFrom ? t("hideRestartFrom") : t("showRestartFrom")}
          </button>
          {showRestartFrom ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label={t("targetLabel")}
                className="rounded-[6px] border border-line-soft bg-paper px-2 py-1 font-mono text-[11px] text-ink-2"
                value={targetNodeId}
                onChange={(e) => setTargetNodeId(e.currentTarget.value)}
              >
                {restartTargets.map((target) => (
                  <option key={target.nodeId} value={target.nodeId}>
                    {target.recommended
                      ? t("targetRecommended", { node: target.nodeId })
                      : target.nodeId}
                  </option>
                ))}
              </select>
              {optionButton(
                "restart_from",
                t("restartFrom"),
                "border-line bg-paper text-ink-2 hover:text-ink",
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {options
        .filter((o) => !o.enabled && o.disabledReason)
        .map((o) => (
          <p key={o.optionId} className="font-mono text-[11px] text-mute">
            {o.disabledReason}
          </p>
        ))}

      {error ? (
        <p className="font-mono text-[12px] text-[#d9534f]">{error}</p>
      ) : null}

      {pendingConfirm ? (
        <ConfirmDialog
          body={
            pendingConfirm === "stop"
              ? t("confirmStopBody", { node: interruptedNodeId })
              : t("confirmRestartBody", {
                  node:
                    pendingConfirm === "restart_from"
                      ? targetNodeId
                      : interruptedNodeId,
                  policy: t(
                    workspacePolicy === "fresh-attempt"
                      ? "policyFresh"
                      : "policyRewind",
                  ),
                })
          }
          busy={busy}
          cancelLabel={t("confirmCancel")}
          testId="node-interrupt-confirm"
          title={
            pendingConfirm === "stop"
              ? t("confirmStopTitle")
              : t("confirmRestartTitle")
          }
          titleId="node-interrupt-confirm-title"
          onClose={() => setPendingConfirm(null)}
        >
          <div className="flex items-center justify-end gap-2">
            <button
              className="rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold text-mute hover:border-mute hover:text-ink-2 disabled:opacity-50"
              disabled={busy}
              type="button"
              onClick={() => setPendingConfirm(null)}
            >
              {t("confirmCancel")}
            </button>
            <button
              className="rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-50"
              data-testid="node-interrupt-confirm-accept"
              disabled={busy}
              type="button"
              onClick={() => respond(pendingConfirm)}
            >
              {t("confirmAccept")}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
