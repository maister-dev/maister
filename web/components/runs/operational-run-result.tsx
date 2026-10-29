"use client";

import type { OperationalOutcome } from "@/lib/run-results/operational-types";
import type { ReactElement } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reported = outcome.reportedResult;

  async function mutate(path: string, body: object): Promise<void> {
    setBusy(true);
    setError(null);
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
        setError(t("actionFailed", { status: response.status }));

        return;
      }
      router.refresh();
    } catch {
      setError(t("connectionFailed"));
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
            <button
              disabled={busy}
              onClick={() =>
                void mutate("acknowledge", {
                  reason: "operation_failure",
                  revision: 1,
                })
              }
            >
              {t("acknowledge")}
            </button>
          ) : null}
          {outcome.cleanup?.state === "exhausted" ? (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  void mutate("acknowledge", {
                    reason: "cleanup_failure",
                    revision: outcome.cleanup!.revision,
                  })
                }
              >
                {t("acknowledgeCleanup")}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void mutate("cleanup/retry", {
                    expectedRevision: outcome.cleanup!.revision,
                  })
                }
              >
                {t("retryCleanup")}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
