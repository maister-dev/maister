"use client";

import type { ReactElement } from "react";
import type { AssignmentDeliveryView } from "@/lib/specialist-assignments/delivery-read-types";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { Button } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { knowledgeClientErrorKey } from "@/components/brain/knowledge-client";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { useFeedback } from "@/components/feedback/feedback-provider";
import { MaisterError, isMaisterErrorCode } from "@/lib/errors-core";

const transportTone: Record<
  AssignmentDeliveryView["transport"]["state"],
  string
> = {
  awaiting_dispatch: "border-line text-mute",
  pending: "border-sky-500/40 text-sky-600 dark:text-sky-300",
  delivered: "border-emerald-500/40 text-emerald-600 dark:text-emerald-300",
  dead: "border-rose-500/40 text-rose-600 dark:text-rose-300",
  suppressed: "border-line text-mute",
};

/** Origin delivery of the accepted result, with replay of a delivered or dead attempt. */
export function AssignmentDelivery({
  assignmentId,
  delivery,
  canReplay,
}: {
  assignmentId: string;
  delivery: AssignmentDeliveryView;
  canReplay: boolean;
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const router = useRouter();
  const feedback = useFeedback();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { transport } = delivery;
  const replayable =
    canReplay &&
    transport.stateSha256 !== null &&
    (transport.state === "delivered" || transport.state === "dead");

  async function replay(): Promise<void> {
    if (busy || !transport.stateSha256) return;
    const mutationId = `${delivery.deliveryId}:${transport.stateSha256}`;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/specialist-assignments/${encodeURIComponent(assignmentId)}/delivery/${encodeURIComponent(delivery.deliveryId)}/replay`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            expectedStateSha256: transport.stateSha256,
          }),
        },
      );
      const value: unknown = await response.json();

      if (!response.ok) {
        const code =
          value && typeof value === "object" && "code" in value
            ? value.code
            : null;

        throw new MaisterError(
          isMaisterErrorCode(code) ? code : "CRASH",
          "The delivery replay was refused",
        );
      }
      feedback.success({ message: t("deliveryReplayed"), mutationId });
      setOpen(false);
      router.refresh();
    } catch (failure) {
      const message = knowledge(knowledgeClientErrorKey(failure));

      setError(message);
      feedback.error({ message, mutationId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-line bg-paper p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{t("delivery")}</h2>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs ${transportTone[transport.state]}`}
        >
          {t(`deliveryState.${transport.state}`)}
        </span>
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-mute">{t("deliveryAttempts")}</dt>
          <dd>{transport.attemptCount}</dd>
        </div>
        <div>
          <dt className="text-mute">{t("deliveryLastStatus")}</dt>
          <dd>
            {transport.lastHttpStatus ??
              (transport.lastErrorKind
                ? t(`deliveryError.${transport.lastErrorKind}`)
                : "—")}
          </dd>
        </div>
        <div>
          <dt className="text-mute">{t("deliveryResult")}</dt>
          <dd>
            {t("revision")} {delivery.resultRevision}
          </dd>
        </div>
      </dl>
      {replayable ? (
        <Button
          className="mt-3"
          size="sm"
          variant="secondary"
          onPress={() => setOpen(true)}
        >
          <ArrowPathIcon aria-hidden="true" className="size-4" />
          {t("replayDelivery")}
        </Button>
      ) : null}
      {open ? (
        <ConfirmDialog
          body={t("replayDeliveryBody")}
          busy={busy}
          cancelLabel={t("dismiss")}
          testId={`delivery-replay-${delivery.deliveryId}`}
          title={t("replayDelivery")}
          titleId={`delivery-replay-title-${delivery.deliveryId}`}
          onClose={() => setOpen(false)}
        >
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <Button isDisabled={busy} onPress={() => void replay()}>
            <ArrowPathIcon aria-hidden="true" className="size-4" />
            {t("replayDelivery")}
          </Button>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
