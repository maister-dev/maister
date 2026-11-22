"use client";

import type { ReactElement } from "react";

import { InboxArrowDownIcon } from "@heroicons/react/24/outline";
import { Button } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { useFeedback } from "@/components/feedback/feedback-provider";

export function TaskBacklogAdmission({
  endpoint,
  inputRevision,
  qualificationRevision,
}: {
  endpoint: string;
  inputRevision: number;
  qualificationRevision: number | null;
}): ReactElement {
  const t = useTranslations("taskQualification");
  const router = useRouter();
  const feedback = useFeedback();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function admit(): Promise<void> {
    if (busy || pending) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedInputRevision: inputRevision,
          expectedQualificationRevision: qualificationRevision,
        }),
      });

      if (!response.ok) {
        setError(
          t(
            response.status === 409
              ? "backlogChanged"
              : response.status === 403
                ? "permission"
                : "backlogError",
          ),
        );
        if (response.status === 409) startTransition(() => router.refresh());

        return;
      }
      feedback.success({
        message: t("backlogAdmitted"),
        mutationId: `${endpoint}:${inputRevision}`,
      });
      startTransition(() => router.refresh());
    } catch {
      setError(t("backlogError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button
        isDisabled={busy || pending}
        size="sm"
        type="button"
        variant="outline"
        onPress={() => void admit()}
      >
        <InboxArrowDownIcon aria-hidden="true" className="size-4" />
        {t("admitToBacklog")}
      </Button>
      {error ? (
        <p className="mt-1 text-sm text-rust" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
