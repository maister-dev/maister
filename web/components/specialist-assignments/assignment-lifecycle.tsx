"use client";

import type { ReactElement } from "react";
import type { KnowledgeDelivery } from "@/components/brain/knowledge-client";

import {
  ArrowUturnLeftIcon,
  StopCircleIcon,
} from "@heroicons/react/24/outline";
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

/** Cancel stops the assignment's running work first; reopen queues failed or cancelled work again. */
export function AssignmentLifecycle({
  assignmentId,
  revision,
  action,
  live,
}: {
  assignmentId: string;
  revision: number;
  action: "cancel" | "reopen";
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
        `/api/specialist-assignments/${encodeURIComponent(assignmentId)}/${action === "cancel" ? "cancel" : "continue"}`,
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
      const pendingTeardown = action === "cancel" && response.status === 202;

      feedback.success({
        message: t(
          pendingTeardown ? "cancelPending" : `lifecycleDone.${action}`,
        ),
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

  const Icon = action === "cancel" ? StopCircleIcon : ArrowUturnLeftIcon;

  return (
    <div className="space-y-2 rounded-xl border border-line bg-paper p-5">
      {action === "cancel" && live ? (
        <p className="text-sm text-mute">{t("cancelStopsWork")}</p>
      ) : null}
      <Button
        variant={action === "cancel" ? "danger-soft" : "secondary"}
        onPress={() => setOpen(true)}
      >
        <Icon aria-hidden="true" className="size-4" />
        {t(action)}
      </Button>
      {open ? (
        <ConfirmDialog
          body={t(`lifecycleBody.${action}`)}
          busy={busy}
          cancelLabel={t("dismiss")}
          testId={`assignment-${action}-${assignmentId}`}
          title={t(`lifecycleTitle.${action}`)}
          titleId={`assignment-${action}-title-${assignmentId}`}
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
            variant={action === "cancel" ? "danger" : "primary"}
            onPress={() => void submit()}
          >
            <Icon aria-hidden="true" className="size-4" />
            {t(action)}
          </Button>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
