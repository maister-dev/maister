"use client";

import type { OperationalOutcome } from "@/lib/run-results/operational-types";
import type { ReactElement, ReactNode } from "react";

import { ArrowPathIcon, CheckIcon } from "@heroicons/react/24/outline";
import { Button } from "@heroui/react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { WorkspaceIntegrityNotice } from "./workspace-integrity-notice";

import { useFeedback } from "@/components/feedback/feedback-provider";

export function OperationalRunResult({
  runId,
  outcome,
  canAct,
  isGlobalAdmin = false,
}: {
  runId: string;
  outcome: OperationalOutcome;
  canAct: boolean;
  isGlobalAdmin?: boolean;
}): ReactElement {
  const t = useTranslations("operationalAgents");
  const router = useRouter();
  const feedback = useFeedback();
  const [busy, setBusy] = useState(false);
  const attention = outcome.continuationAttention;

  async function mutate(
    path: "acknowledge" | "cleanup/retry" | "continuation/retry",
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
        const stale = path === "continuation/retry" && response.status === 409;
        feedback.error({
          message: t(stale ? "continuationStale" : "actionFailed"),
          mutationId,
        });
        if (stale) router.refresh();

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
      <OperationalOutcomeDetails
        cleanupNotice={
          outcome.cleanupIntegrityLimit ? (
            <WorkspaceIntegrityNotice
              isGlobalAdmin={isGlobalAdmin}
              limit={outcome.cleanupIntegrityLimit}
              runId={runId}
            />
          ) : null
        }
        executionNotices={
          <OperationalExecutionIntegrityNotices
            isGlobalAdmin={isGlobalAdmin}
            outcome={outcome}
            runId={runId}
          />
        }
        outcome={outcome}
      />
      {canAct && attention ? (
        <Button
          className="mt-3"
          isDisabled={busy}
          size="sm"
          variant="secondary"
          onClick={() =>
            void mutate(
              "continuation/retry",
              { observation: attention.observation },
              t("continuationScheduled"),
            )
          }
        >
          <ArrowPathIcon aria-hidden="true" className="size-4" />
          {t("continuationRecheck")}
        </Button>
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

export function OperationalExecutionIntegrityNotices({
  outcome,
  runId,
  isGlobalAdmin,
}: {
  outcome: OperationalOutcome;
  runId: string;
  isGlobalAdmin: boolean;
}): ReactElement {
  return (
    <>
      {[
        outcome.continuationAttention?.integrityLimit,
        outcome.infrastructureFailure?.integrityLimit,
        outcome.integrityLimit,
      ].map((limit, index) =>
        limit ? (
          <WorkspaceIntegrityNotice
            key={index}
            isGlobalAdmin={isGlobalAdmin}
            limit={limit}
            runId={runId}
          />
        ) : null,
      )}
    </>
  );
}

/** Read-only operational projection; evidence and actions keep their separate grants. */
export function OperationalOutcomeDetails({
  outcome,
  executionNotices,
  cleanupNotice,
}: {
  outcome: OperationalOutcome;
  executionNotices?: ReactNode;
  cleanupNotice?: ReactNode;
}): ReactElement {
  const t = useTranslations("operationalAgents");
  const reported = outcome.reportedResult;
  const attention = outcome.continuationAttention;
  const integrityRefused = outcome.reasonCodes.some(
    (reason) =>
      reason === "operational_integrity_refused" ||
      reason === "operational_legacy_baseline_unverifiable",
  );

  return (
    <>
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      <p data-testid="operational-outcome" role="status">
        {t(
          attention
            ? "continuationAttention"
            : (outcome.effectiveOutcome ?? "pending"),
        )}
      </p>
      {executionNotices}
      {attention ? (
        <div className="my-3 space-y-2">
          <p>{t("continuationGuidance")}</p>
          <details>
            <summary>{t("continuationDetails")}</summary>
            <dl className="my-2 space-y-1 text-sm">
              <dt>{t("continuationCause")}</dt>
              <dd className="break-words font-mono">{attention.reason}</dd>
              <dt>{t("continuationBlocker")}</dt>
              <dd className="break-words font-mono">
                {attention.blockedReason}
              </dd>
              <dt>{t("continuationEpoch")}</dt>
              <dd>{attention.assignmentEpoch}</dd>
            </dl>
          </details>
        </div>
      ) : reported ? (
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
      ) : outcome.infrastructureFailure ? (
        <div className="my-3 space-y-2" role="status">
          <p>{t("preparationFailed")}</p>
          <p>{t("preparationRemediation")}</p>
          <details>
            <summary>{t("preparationDetails")}</summary>
            <pre className="overflow-auto whitespace-pre-wrap text-sm">
              {JSON.stringify(outcome.infrastructureFailure, null, 2)}
            </pre>
          </details>
        </div>
      ) : integrityRefused ? (
        <div className="my-3 space-y-2">
          <p>{t("continuationRefused")}</p>
          <p>{t("continuationRefusedGuidance")}</p>
        </div>
      ) : (
        <p>
          {t(outcome.state === "pending" ? "awaitingResult" : "invalidResult")}
        </p>
      )}
      {outcome.validationDiagnostics?.length ? (
        <div aria-label={t("validation.title")} className="my-3 space-y-3">
          <h3 className="font-semibold">{t("validation.title")}</h3>
          {outcome.validationDiagnostics.map((diagnostic, index) => (
            <div
              key={`${diagnostic.code}:${diagnostic.path}:${index}`}
              className="rounded border border-line p-3"
            >
              <p>{t(`validation.rules.${diagnostic.code}.message`)}</p>
              <p>
                {t("validation.field")}: <code>{diagnostic.path}</code>
              </p>
              <p>
                {t("remediation")}:{" "}
                {t(`validation.rules.${diagnostic.code}.remediation`)}
              </p>
            </div>
          ))}
        </div>
      ) : null}
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
      {cleanupNotice}
    </>
  );
}
