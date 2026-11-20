"use client";

import type { ReactElement } from "react";
import type { KnowledgeDelivery } from "./knowledge-client";
import type { KnowledgeRecordDto } from "@/lib/brain/knowledge-read-types";

import { Button } from "@heroui/react";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  knowledgeDeliveryKey,
  sendKnowledgeRequest,
  knowledgeClientErrorKey,
} from "./knowledge-client";

import { knowledgeMutationReceiptSchema } from "@/lib/brain/knowledge-write-types";
import { useFeedback } from "@/components/feedback/feedback-provider";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";

const fieldClass =
  "block w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink";

export function KnowledgeConfirmation({
  record,
}: {
  record: KnowledgeRecordDto;
}): ReactElement {
  const t = useTranslations("knowledge");
  const router = useRouter();
  const feedback = useFeedback();
  const delivery = useRef<KnowledgeDelivery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [revoking, setRevoking] = useState(false);
  const supporting = record.evidence.flatMap((entry) =>
    "witness" in entry &&
    entry.relation === "supports" &&
    entry.witness.availability === "available"
      ? [entry.witness]
      : [],
  );

  async function decide(decision: "confirm" | "revoke"): Promise<void> {
    if (busy) return;
    const input = {
      expectedRevision: record.revision,
      decision,
      witnessIds: decision === "confirm" ? selected : [],
      reason,
    };
    const idempotencyKey = knowledgeDeliveryKey(delivery, input);

    setBusy(true);
    setError(null);
    try {
      await sendKnowledgeRequest(
        `/api/knowledge/${encodeURIComponent(record.id)}/confirmations`,
        "POST",
        { ...input, idempotencyKey },
        knowledgeMutationReceiptSchema,
      );
      feedback.success({ message: t("title"), mutationId: idempotencyKey });
      setRevoking(false);
      router.refresh();
    } catch (failure) {
      const message = t(knowledgeClientErrorKey(failure));

      setError(message);
      feedback.error({ message, mutationId: idempotencyKey });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-mute">{t("publicationSeparate")}</p>
      <fieldset className="space-y-2" disabled={busy}>
        <legend className="text-sm font-semibold">
          {t("confirmationEvidence")}
        </legend>
        {supporting.map((witness) => (
          <label key={witness.id} className="flex items-start gap-2 text-sm">
            <input
              checked={selected.includes(witness.id)}
              type="checkbox"
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, witness.id]
                    : current.filter((id) => id !== witness.id),
                )
              }
            />
            <span>
              {t("useWitness")}
              <span className="block break-all font-mono text-xs text-mute">
                {witness.sourceVersion} · {witness.id}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="block text-sm">
        {t("confirmationReason")}
        <textarea
          required
          aria-label={t("confirmationReason")}
          className={`${fieldClass} mt-1`}
          disabled={busy}
          maxLength={2000}
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      {record.confirmation.state === "confirmed" ? (
        <Button
          isDisabled={busy || !reason.trim()}
          variant="danger-soft"
          onPress={() => setRevoking(true)}
        >
          {t("revokeConfirmation")}
        </Button>
      ) : (
        <Button
          isDisabled={busy || !reason.trim() || selected.length === 0}
          onPress={() => void decide("confirm")}
        >
          {t(busy ? "busy" : "confirm")}
        </Button>
      )}
      {supporting.length === 0 && record.confirmation.state !== "confirmed" ? (
        <p className="text-sm text-mute">{t("confirmationUnavailable")}</p>
      ) : null}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {revoking ? (
        <ConfirmDialog
          body={t("publicationSeparate")}
          busy={busy}
          cancelLabel={t("cancel")}
          testId="knowledge-confirmation-revoke"
          title={t("revokeConfirmation")}
          titleId="knowledge-confirmation-revoke-title"
          onClose={() => setRevoking(false)}
        >
          <Button
            isDisabled={busy}
            variant="danger"
            onPress={() => void decide("revoke")}
          >
            {t("revokeConfirmation")}
          </Button>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
