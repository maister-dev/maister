"use client";

import type { ReactElement } from "react";
import type { PromotionOperationInput } from "@/lib/runs/promotion-operation";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { useFeedback } from "@/components/feedback/feedback-provider";
import { resolveUiErrorMessageKey } from "@/lib/ui-error-message";
import {
  buildPromotionRequestBody,
  isMergedPrBehindResponse,
  isPublicationDivergedResponse,
  isTargetDriftResponse,
} from "@/lib/runs/promotion-operation";

interface RunHeaderPromotionActionProps {
  operation: PromotionOperationInput & { runId: string };
  reviewHref: string;
  labels: {
    promote: string;
    started: string;
    targetDrift: string;
  };
}

export function RunHeaderPromotionAction({
  operation,
  reviewHref,
  labels,
}: RunHeaderPromotionActionProps): ReactElement {
  const feedback = useFeedback();
  const router = useRouter();
  const t = useTranslations("run");
  const [busy, setBusy] = useState(false);

  // ADR-181: a refusal with a way out of its own reads as that, not as its
  // code's copy — the PR branch keeps commits the run lacks (C), or the PR was
  // merged without the run's later commits (Codex F4).
  function refusalMessage(data: { code?: string } | null): string {
    if (isPublicationDivergedResponse(data)) return t("publicationDiverged");
    if (isMergedPrBehindResponse(data)) return t("mergedPrBehind");

    return t(resolveUiErrorMessageKey(data?.code));
  }

  async function promote(): Promise<void> {
    const body = buildPromotionRequestBody(operation);

    if (!body || busy) return;

    setBusy(true);

    try {
      const response = await fetch(`/api/runs/${operation.runId}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        feedback.success({
          mutationId: `run-promote:${operation.runId}:${operation.reviewedTargetCommit}`,
          message: labels.started,
        });
        router.refresh();

        return;
      }

      const data = (await response.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;

      if (isTargetDriftResponse(data)) {
        feedback.error({
          mutationId: `run-promote:${operation.runId}:target-drift`,
          message: labels.targetDrift,
        });
        window.location.hash = reviewHref;

        return;
      }

      feedback.error({
        mutationId: `run-promote:${operation.runId}:failure`,
        message: refusalMessage(data),
      });
    } catch {
      feedback.error({
        mutationId: `run-promote:${operation.runId}:network`,
        message: t("error.generic"),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className="rounded-[6px] border border-line bg-paper px-2.5 py-1.5 font-mono text-[11px] font-semibold text-ink-2 hover:bg-ivory disabled:cursor-not-allowed disabled:opacity-60"
      data-testid="run-header-promote"
      disabled={busy}
      type="button"
      onClick={() => void promote()}
    >
      {labels.promote}
    </button>
  );
}
