"use client";

import type { ReactElement } from "react";

import {
  ArrowPathIcon,
  BackwardIcon,
  PlayIcon,
  StopIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { readApiError } from "@/lib/api-error";

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
  runId: string;
  hitlRequestId: string;
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
}

const ICONS: Record<NodeInterruptOptionId, typeof PlayIcon> = {
  resume: PlayIcon,
  restart_node: ArrowPathIcon,
  restart_from: BackwardIcon,
  stop: StopIcon,
};

export function NodeInterruptControls({
  runId,
  hitlRequestId,
  interruptedNodeId,
  options,
  defaultOptionId,
  restartTargets,
  canAct,
}: NodeInterruptControlsProps): ReactElement {
  const t = useTranslations("nodeInterrupt");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");
  const [workspacePolicy, setWorkspacePolicy] =
    useState<NodeInterruptWorkspacePolicy>("keep");
  const [showRestartFrom, setShowRestartFrom] = useState(false);
  const [targetNodeId, setTargetNodeId] = useState(
    restartTargets[0]?.nodeId ?? "",
  );

  const disabled = busy || pending || !canAct;

  async function respond(optionId: NodeInterruptOptionId): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/runs/${runId}/hitl/${hitlRequestId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
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
          }),
        },
      );

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      startTransition(() => router.refresh());
    } catch {
      setError(tApiErrors("requestFailed"));
    } finally {
      setBusy(false);
    }
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
        onClick={() => void respond(optionId)}
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
    </div>
  );
}
