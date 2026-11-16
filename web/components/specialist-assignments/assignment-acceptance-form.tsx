"use client";

import type { FormEvent, ReactElement } from "react";
import type { AssignmentReview } from "@/lib/specialist-assignments/workspace-view";

import { useRef, useState } from "react";
import { Button } from "@heroui/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";

import {
  knowledgeClientErrorKey,
  knowledgeDeliveryKey,
  sendKnowledgeRequest,
  type KnowledgeDelivery,
} from "@/components/brain/knowledge-client";

const receipt = z.object({ status: z.literal("completed") });

export function AssignmentAcceptanceForm({
  assignmentId,
  review,
}: {
  assignmentId: string;
  review: AssignmentReview;
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const router = useRouter();
  const delivery = useRef<KnowledgeDelivery | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const reason = String(
      new FormData(event.currentTarget).get("reason") ?? "",
    ).trim();

    if (!reason) {
      setError(knowledge("errorInput"));

      return;
    }
    const request = { ...review, reason };

    setPending(true);
    setError(null);
    try {
      await sendKnowledgeRequest(
        `/api/specialist-assignments/${encodeURIComponent(assignmentId)}/acceptance`,
        "POST",
        { ...request, idempotencyKey: knowledgeDeliveryKey(delivery, request) },
        receipt,
      );
      router.refresh();
    } catch (error) {
      setError(knowledge(knowledgeClientErrorKey(error)));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-3 rounded-xl border border-line bg-paper p-5"
      onSubmit={accept}
    >
      <h2 className="font-semibold">{t("accept")}</h2>
      <Link
        className="text-sm underline"
        href={`/runs/${encodeURIComponent(review.result.runId)}`}
      >
        {t("reviewResult")}
      </Link>
      {review.verificationIds.length ? (
        <p className="break-all text-xs">
          {t("verificationReceipts")} {review.verificationIds.join(", ")}
        </p>
      ) : null}
      <label className="block text-sm">
        {t("reason")}
        <input
          required
          className="mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2"
          maxLength={2000}
          name="reason"
        />
      </label>
      <Button isPending={pending} type="submit" variant="primary">
        {t("accept")}
      </Button>
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
