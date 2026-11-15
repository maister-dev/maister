"use client";

import type { ReactElement } from "react";
import type { KnowledgeDelivery } from "@/components/brain/knowledge-client";

import { StopCircleIcon } from "@heroicons/react/24/outline";
import { useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import {
  knowledgeClientErrorKey,
  knowledgeDeliveryKey,
} from "@/components/brain/knowledge-client";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { useFeedback } from "@/components/feedback/feedback-provider";
import { MaisterError, isMaisterErrorCode } from "@/lib/errors-core";

/** Retain cancellation intent and stop the assignment through its native Run owners. */
export function AssignmentLifecycle({
  assignmentId,
  revision,
  live,
}: {
  assignmentId: string;
  revision: number;
  live: boolean;
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const router = useRouter();
  const feedback = useFeedback();
  const delivery = useRef<KnowledgeDelivery | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) return;
    const body = { expectedRevision: revision, reason: reason.trim() };
    const idempotencyKey = knowledgeDeliveryKey(delivery, body);

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/specialist-assignments/${encodeURIComponent(assignmentId)}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, idempotencyKey }),
        },
      );
      const value: unknown = await response.json();

      if (!response.ok) {
        const code =
          value && typeof value === "object" && "code" in value
            ? value.code
            : null;
        const details =
          value && typeof value === "object" && "details" in value
            ? value.details
            : null;
        const reason =
          details && typeof details === "object" && "reason" in details
            ? details.reason
            : null;

        throw new MaisterError(
          isMaisterErrorCode(code) ? code : "CRASH",
          "The assignment action was refused",
          typeof reason === "string" ? { details: { reason } } : undefined,
        );
      }
      const pendingTeardown = response.status === 202;

      feedback.success({
        message: t(pendingTeardown ? "cancelPending" : "lifecycleDone.cancel"),
        mutationId: idempotencyKey,
      });
      setOpen(false);
      setReason("");
      router.refresh();
    } catch (failure) {
      const message =
        failure instanceof MaisterError &&
        failure.details?.reason === "assignment_run_unstoppable"
          ? t("cancelUnstoppable")
          : knowledge(knowledgeClientErrorKey(failure));

      setError(message);
      feedback.error({ message, mutationId: idempotencyKey });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-line bg-paper p-5">
      {live ? (
        <p className="text-sm text-mute">{t("cancelStopsWork")}</p>
      ) : null}
      <Button variant="danger-soft" onPress={() => setOpen(true)}>
        <StopCircleIcon aria-hidden="true" className="size-4" />
        {t("cancel")}
      </Button>
      {open ? (
        <ConfirmDialog
          body={t("lifecycleBody.cancel")}
          busy={busy}
          cancelLabel={t("dismiss")}
          testId={`assignment-cancel-${assignmentId}`}
          title={t("lifecycleTitle.cancel")}
          titleId={`assignment-cancel-title-${assignmentId}`}
          onClose={() => setOpen(false)}
        >
          <label className="block text-sm">
            {t("reason")}
            <textarea
              required
              className="mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm"
              disabled={busy}
              maxLength={2000}
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            isDisabled={busy || !reason.trim()}
            variant="danger"
            onPress={() => void submit()}
          >
            <StopCircleIcon aria-hidden="true" className="size-4" />
            {t("cancel")}
          </Button>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
