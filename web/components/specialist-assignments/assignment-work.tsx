"use client";

import type { ReactElement } from "react";
import type { KnowledgeDelivery } from "@/components/brain/knowledge-client";
import type { SpecialistWorkItem } from "@/lib/specialist-assignments/pages";

import { CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
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

type Decision = "accept" | "reject";

const stateTone: Record<SpecialistWorkItem["state"], string> = {
  queued: "border-line text-mute",
  running: "border-sky-500/40 text-sky-600 dark:text-sky-300",
  needs_clarification: "border-amber-500/40 text-amber-600 dark:text-amber-300",
  result_ready: "border-violet-500/40 text-violet-600 dark:text-violet-300",
  accepted: "border-emerald-500/40 text-emerald-600 dark:text-emerald-300",
  rework_requested: "border-amber-500/40 text-amber-600 dark:text-amber-300",
  interrupted: "border-rose-500/40 text-rose-600 dark:text-rose-300",
  cancelled: "border-line text-mute",
};

/** Delegated child work with the coordinator's accept/reject decision for a ready result. */
export function AssignmentWork({
  assignmentId,
  items,
  canDecide,
  nextCursor,
  paged,
}: {
  assignmentId: string;
  items: readonly SpecialistWorkItem[];
  canDecide: boolean;
  nextCursor: string | null;
  paged: boolean;
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const router = useRouter();
  const feedback = useFeedback();
  const delivery = useRef<KnowledgeDelivery | null>(null);
  const [deciding, setDeciding] = useState<{
    work: SpecialistWorkItem;
    decision: Decision;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(): Promise<void> {
    if (!deciding || busy || deciding.work.resultRevision === null) return;
    const { work, decision } = deciding;
    const body = {
      expectedRevision: work.revision,
      workRevision: work.workRevision,
      inputRevision: work.inputRevision,
      resultRevision: work.resultRevision,
      decision,
      reason: reason.trim(),
    };
    const idempotencyKey = knowledgeDeliveryKey(delivery, body);

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/specialist-assignments/${encodeURIComponent(assignmentId)}/work/${encodeURIComponent(work.id)}/decisions`,
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

        throw new MaisterError(
          isMaisterErrorCode(code) ? code : "CRASH",
          "The work decision was refused",
        );
      }
      feedback.success({
        message: t(`workDecisionDone.${decision}`),
        mutationId: idempotencyKey,
      });
      setDeciding(null);
      setReason("");
      router.refresh();
    } catch (failure) {
      const message = knowledge(knowledgeClientErrorKey(failure));

      setError(message);
      feedback.error({ message, mutationId: idempotencyKey });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="rounded-xl border border-line bg-paper p-5"
      id="assignment-work"
    >
      <h2 className="font-semibold">{t("work")}</h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-mute">{t("noWork")}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs text-mute">
              <tr>
                <th className="py-2 pr-3 font-normal">{t("workItem")}</th>
                <th className="py-2 pr-3 font-normal">{t("workState")}</th>
                <th className="py-2 pr-3 font-normal">{t("workResult")}</th>
                <th className="py-2 font-normal">
                  <span className="sr-only">{t("workActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((work) => (
                <tr key={`${work.id}:${work.workRevision}`}>
                  <td className="py-2 pr-3">
                    <p className="font-medium">{work.logicalWorkId}</p>
                    {work.childRunId ? (
                      <Link
                        className="text-xs underline"
                        href={`/runs/${encodeURIComponent(work.childRunId)}`}
                      >
                        {t("openRun")}
                      </Link>
                    ) : null}
                    {work.limitations.map((limitation) => (
                      <p key={limitation} className="text-xs text-mute">
                        {t(`workLimitation.${limitation}`)}
                      </p>
                    ))}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs ${stateTone[work.state]}`}
                    >
                      {t(`workStateLabel.${work.state}`)}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    {work.childRunId && work.resultRevision !== null ? (
                      <Link
                        className="underline"
                        href={`/knowledge/results/${encodeURIComponent(work.childRunId)}/${work.resultRevision}`}
                      >
                        {t("openResult")}
                      </Link>
                    ) : (
                      <span className="text-mute">—</span>
                    )}
                  </td>
                  <td className="py-2">
                    {canDecide && (work.canAccept || work.canReject) ? (
                      <div className="flex justify-end gap-2">
                        {work.canAccept ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onPress={() =>
                              setDeciding({ work, decision: "accept" })
                            }
                          >
                            <CheckIcon aria-hidden="true" className="size-4" />
                            {t("acceptWork")}
                          </Button>
                        ) : null}
                        {work.canReject ? (
                          <Button
                            size="sm"
                            variant="danger-soft"
                            onPress={() =>
                              setDeciding({ work, decision: "reject" })
                            }
                          >
                            <XMarkIcon aria-hidden="true" className="size-4" />
                            {t("rejectWork")}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {paged || nextCursor ? (
        <nav
          aria-label={t("workPages")}
          className="mt-3 flex justify-end gap-4"
        >
          {paged ? (
            <Link
              className="underline"
              href={`/specialist-assignments/${encodeURIComponent(assignmentId)}#assignment-work`}
            >
              {t("firstWorkPage")}
            </Link>
          ) : null}
          {nextCursor ? (
            <Link
              className="underline"
              href={`?workCursor=${encodeURIComponent(nextCursor)}#assignment-work`}
            >
              {t("nextWorkPage")}
            </Link>
          ) : null}
        </nav>
      ) : null}
      {deciding ? (
        <ConfirmDialog
          body={t(`workDecisionBody.${deciding.decision}`)}
          busy={busy}
          cancelLabel={t("dismiss")}
          testId={`work-decision-${deciding.work.id}`}
          title={t(`workDecisionTitle.${deciding.decision}`)}
          titleId={`work-decision-title-${deciding.work.id}`}
          onClose={() => setDeciding(null)}
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
            variant={deciding.decision === "accept" ? "primary" : "danger"}
            onPress={() => void decide()}
          >
            {t(deciding.decision === "accept" ? "acceptWork" : "rejectWork")}
          </Button>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
