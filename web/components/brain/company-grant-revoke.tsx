"use client";

import type { ReactElement } from "react";
import type { KnowledgeDelivery } from "./knowledge-client";

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

export function CompanyGrantRevoke({
  grantId,
  revision,
}: {
  grantId: string;
  revision: number;
}): ReactElement {
  const t = useTranslations("knowledge");
  const router = useRouter();
  const feedback = useFeedback();
  const delivery = useRef<KnowledgeDelivery | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke(): Promise<void> {
    if (busy) return;
    const input = { expectedRevision: revision, reason };
    const idempotencyKey = knowledgeDeliveryKey(delivery, input);

    setBusy(true);
    setError(null);
    try {
      await sendKnowledgeRequest(
        `/api/company/grants/${encodeURIComponent(grantId)}`,
        "DELETE",
        { ...input, idempotencyKey },
        knowledgeMutationReceiptSchema,
      );
      feedback.success({
        message: t("companyAccess"),
        mutationId: idempotencyKey,
      });
      setOpen(false);
      router.refresh();
    } catch (failure) {
      const key = knowledgeClientErrorKey(failure);
      const message = t(key === "errorConflict" ? "errorPolicyConflict" : key);

      setError(message);
      feedback.error({ message, mutationId: idempotencyKey });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="danger-soft" onPress={() => setOpen(true)}>
        {t("revokeGrant")}
      </Button>
      {open ? (
        <ConfirmDialog
          body={t("grantRevokeBody")}
          busy={busy}
          cancelLabel={t("cancel")}
          testId={`company-grant-revoke-${grantId}`}
          title={t("grantRevokeTitle")}
          titleId={`company-grant-revoke-title-${grantId}`}
          onClose={() => setOpen(false)}
        >
          <label className="block text-sm">
            {t("grantReason")}
            <textarea
              required
              aria-label={t("grantReason")}
              className="mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink"
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
            onPress={() => void revoke()}
          >
            {t(busy ? "busy" : "revokeGrant")}
          </Button>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
