"use client";

import type { ReactElement } from "react";
import type { TriageFlagOrigin } from "@/lib/tasks/manual-launch-hold";

import {
  CheckIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { Button } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

/** Resolving an independent hold is a separate human decision, never a launch or an accepted assessment. */
export function TaskLaunchHoldControl({
  taskId,
  revision,
  origin,
  canAct,
}: {
  taskId: string;
  revision: number;
  origin: Exclude<TriageFlagOrigin, "qualification">;
  canAct: boolean;
}): ReactElement {
  const t = useTranslations("launch");
  const router = useRouter();
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function resolveHold(): Promise<void> {
    if (busy || pending) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/task-launch-holds/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskId,
          expectedRevision: revision,
          expectedOrigin: origin,
        }),
      });

      if (!response.ok) {
        setError(
          t(
            response.status === 409
              ? "admission.holdChanged"
              : response.status === 403
                ? "admission.reason.authorityRevoked"
                : "admission.holdResolveFailed",
          ),
        );

        return;
      }
      setReviewing(false);
      startTransition(() => router.refresh());
    } catch {
      setError(t("admission.holdResolveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="rounded-lg border border-amber-line bg-amber-soft p-3 text-sm"
      data-testid="task-launch-hold"
    >
      <p className="flex items-center gap-2">
        <ExclamationTriangleIcon aria-hidden="true" className="size-4" />
        {t("admission.holdHint")}
      </p>
      {reviewing ? (
        <p className="mt-2 text-ink-2">
          {t(`admission.holdOrigin.${origin}`)} {t("admission.holdDecision")}
        </p>
      ) : null}
      {canAct ? (
        <Button
          className="mt-2"
          isDisabled={busy || pending}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => (reviewing ? void resolveHold() : setReviewing(true))}
        >
          <CheckIcon aria-hidden="true" className="size-4" />
          {t(
            reviewing
              ? "admission.confirmResolveHold"
              : "admission.resolveHold",
          )}
        </Button>
      ) : null}
      {error ? (
        <p className="mt-2" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
