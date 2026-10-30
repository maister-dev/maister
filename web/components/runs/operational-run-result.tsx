"use client";

import type { OperationalOutcome } from "@/lib/run-results/operational-types";
import type { ReactElement } from "react";

import { ArrowPathIcon, CheckIcon } from "@heroicons/react/24/outline";
import { Button } from "@heroui/react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { useFeedback } from "@/components/feedback/feedback-provider";

export function OperationalRunResult({
  runId,
  outcome,
  canAct,
}: {
  runId: string;
  outcome: OperationalOutcome;
  canAct: boolean;
}): ReactElement {
  const t = useTranslations("operationalAgents");
  const router = useRouter();
  const feedback = useFeedback();
  const [busy, setBusy] = useState(false);
  const reported = outcome.reportedResult;

  async function mutate(
    path: "acknowledge" | "cleanup/retry",
    body: Record<string, string | number>,
    successMessage: string,
  ): Promise<void> {
    const mutationId = `operational:${runId}:${path}:${crypto.randomUUID()}`;

    setBusy(true);
    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/operational/${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        feedback.error({ message: t("actionFailed"), mutationId });

        return;
      }
      feedback.success({ message: successMessage, mutationId });
      router.refresh();
    } catch {
      feedback.error({ message: t("connectionFailed"), mutationId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={t("title")}
      className="rounded-xl border border-line bg-paper p-5"
      data-testid="operational-result"
    >
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      <p data-testid="operational-outcome" role="status">
        {t(outcome.effectiveOutcome ?? "pending")}
      </p>
      {reported ? (
        <>
          <p>{reported.summary}</p>
          {outcome.successful && reported.counts.attempted === 0 ? (
            <p>{t("zeroWork")}</p>
          ) : null}
          <dl className="flex flex-wrap gap-4">
            {Object.entries(reported.counts).map(([key, count]) => (
              <div key={key}>
                <dt>{t(`counts.${key}`)}</dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
          <ul>
            {reported.references.map((reference) => (
              <li key={`${reference.kind}:${reference.id}`}>
                {outcome.referenceLinks.some(
                  (link) =>
                    link.kind === reference.kind && link.id === reference.id,
                ) ? (
                  <a
                    href={
                      outcome.referenceLinks.find(
                        (link) =>
                          link.kind === reference.kind &&
                          link.id === reference.id,
                      )!.href
                    }
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {reference.id}
                  </a>
                ) : (
                  reference.id
                )}{" "}
                · {t(reference.state)}
              </li>
            ))}
          </ul>
          {reported.diagnostics.map((diagnostic, index) => (
            <div
              key={`${diagnostic.code}:${index}`}
              className="my-2 rounded border border-line p-3"
            >
              <p>
                {diagnostic.code}
                {diagnostic.httpStatus
                  ? ` · HTTP ${diagnostic.httpStatus}`
                  : ""}
                : {diagnostic.message}
              </p>
              <p>
                {t("remediation")}: {diagnostic.remediation}
              </p>
            </div>
          ))}
        </>
      ) : (
        <p>
          {t(outcome.state === "pending" ? "awaitingResult" : "invalidResult")}
        </p>
      )}
      {!outcome.successful && outcome.reasonCodes.length ? (
        <p>
          {t("reasons")}: {outcome.reasonCodes.join(", ")}
        </p>
      ) : null}
      <p>
        {t("integrity")}: {t(`integrityState.${outcome.integrity}`)}
      </p>
      {outcome.cleanup ? (
        <p>
          {t("cleanup")}: {t(`cleanupState.${outcome.cleanup.state}`)}
          {outcome.cleanup.errorCode ? ` · ${outcome.cleanup.errorCode}` : ""}
        </p>
      ) : null}
      {outcome.cleanup?.evidenceIds.length ? (
        <details>
          <summary>{t("evidence")}</summary>
          <ul>
            {outcome.cleanup.evidenceIds.map((id) => (
              <li key={id}>
                <a
                  href={`/api/runs/${encodeURIComponent(runId)}/runtime-objects/${encodeURIComponent(id)}/content`}
                >
                  {id}
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {canAct && outcome.state === "terminal" ? (
        <div className="mt-3 flex gap-3">
          {!outcome.successful && outcome.effectiveOutcome !== "cancelled" ? (
            <Button
              isDisabled={busy}
              size="sm"
              variant="secondary"
              onClick={() =>
                void mutate(
                  "acknowledge",
                  {
                    reason: "operation_failure",
                    revision: 1,
                  },
                  t("operationAcknowledged"),
                )
              }
            >
              <CheckIcon aria-hidden="true" className="size-4" />
              {t("acknowledge")}
            </Button>
          ) : null}
          {outcome.cleanup?.state === "exhausted" ? (
            <>
              <Button
                isDisabled={busy}
                size="sm"
                variant="secondary"
                onClick={() =>
                  void mutate(
                    "acknowledge",
                    {
                      reason: "cleanup_failure",
                      revision: outcome.cleanup!.revision,
                    },
                    t("cleanupAcknowledged"),
                  )
                }
              >
                <CheckIcon aria-hidden="true" className="size-4" />
                {t("acknowledgeCleanup")}
              </Button>
              <Button
                isDisabled={busy}
                size="sm"
                variant="secondary"
                onClick={() =>
                  void mutate(
                    "cleanup/retry",
                    {
                      expectedRevision: outcome.cleanup!.revision,
                    },
                    t("cleanupScheduled"),
                  )
                }
              >
                <ArrowPathIcon aria-hidden="true" className="size-4" />
                {t("retryCleanup")}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
