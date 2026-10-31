"use client";

import type { AgentRetryOptions } from "@/lib/agents/retry-preparation";
import type { AgentRetryReceipt } from "@/lib/agents/retry";
import type { ReactElement } from "react";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";

type AcceptedRequest = {
  runnerId: string;
  requestKey: string;
  previewFingerprint: string;
};
const button =
  "inline-flex min-h-8 items-center rounded-lg border border-line bg-ivory px-3 text-xs font-semibold text-ink hover:border-mute disabled:opacity-50";

export function AgentRetryControl({ runId }: { runId: string }): ReactElement {
  const t = useTranslations("agentActivity");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<AgentRetryOptions | null>(null);
  const [receipt, setReceipt] = useState<AgentRetryReceipt | null>(null);
  const [runnerId, setRunnerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<AcceptedRequest | null>(null);
  const [cleanupRequest, setCleanupRequest] = useState<{
    expectedDispositionRevision: number;
    requestKey: string;
  } | null>(null);
  const [previewRefused, setPreviewRefused] = useState(false);
  const refusalKey = (reason: string | null): string =>
    reason === "reconciliation_required"
      ? "refusal.reconciliation"
      : reason === "retry_task_changed"
        ? "refusal.taskChanged"
        : reason === "retry_runner_unavailable"
          ? "refusal.runner"
          : reason === "retry_source_not_failed"
            ? "refusal.notFailed"
            : "retryRefused";
  const load = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/retry-options`);

      if (!response.ok) {
        setError(
          t(response.status === 403 ? "permissionChanged" : "loadError"),
        );

        return;
      }
      const next = (await response.json()) as AgentRetryOptions;

      setOptions(next);
      if (!next.existingIntentId && previewRefused) {
        setRequest(null);
        setPreviewRefused(false);
      }
      setRunnerId(
        request?.runnerId ?? next.runners.find((item) => item.ready)?.id ?? "",
      );
      if (next.existingIntentId) {
        const status = await fetch(
          `/api/runs/${runId}/retry/${next.existingIntentId}`,
        );

        if (!status.ok) {
          setError(t("loadError"));

          return;
        }
        setReceipt((await status.json()) as AgentRetryReceipt);
      }
    } catch {
      setError(t("loadError"));
    } finally {
      setBusy(false);
    }
  };
  const accept = async (): Promise<void> => {
    if (!options || !runnerId) return;
    const acceptedRequest = request ?? {
      runnerId,
      requestKey: crypto.randomUUID(),
      previewFingerprint: options.previewFingerprint,
    };

    setRequest(acceptedRequest);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(acceptedRequest),
      });

      if (!response.ok) {
        if (response.status === 409) setPreviewRefused(true);
        setError(
          t(
            response.status === 403
              ? "permissionChanged"
              : response.status === 409
                ? "retryConflict"
                : "retryError",
          ),
        );

        return;
      }
      setReceipt((await response.json()) as AgentRetryReceipt);
      router.refresh();
    } catch {
      setError(t("retryUnknown"));
    } finally {
      setBusy(false);
    }
  };
  const refreshReceipt = async (): Promise<void> => {
    if (!receipt) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/runs/${runId}/retry/${receipt.retryIntentId}`,
      );

      if (!response.ok) {
        setError(t("loadError"));

        return;
      }
      setReceipt((await response.json()) as AgentRetryReceipt);
      router.refresh();
    } catch {
      setError(t("loadError"));
    } finally {
      setBusy(false);
    }
  };

  const retryCleanup = async (): Promise<void> => {
    if (!receipt?.cleanup) return;
    const body = cleanupRequest ?? {
      expectedDispositionRevision: receipt.cleanup.revision,
      requestKey: crypto.randomUUID(),
    };

    setCleanupRequest(body);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/runs/${runId}/retry/${receipt.retryIntentId}/cleanup`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        setError(
          t(response.status === 409 ? "cleanupConflict" : "cleanupError"),
        );

        return;
      }
      setReceipt((await response.json()) as AgentRetryReceipt);
      router.refresh();
    } catch {
      setError(t("cleanupUnknown"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className={button}
        type="button"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        {t("retry")}
      </button>
      {open ? (
        <ConfirmDialog
          body={t("retryOneOff")}
          busy={busy}
          cancelLabel={t("close")}
          testId="agent-retry-dialog"
          title={t("retry")}
          titleId={`retry-${runId}`}
          onClose={() => setOpen(false)}
        >
          <div
            aria-busy={busy}
            aria-live="polite"
            className="space-y-3 text-sm"
          >
            {error ? (
              <p className="text-red-700" role="alert">
                {error}
              </p>
            ) : null}
            {busy ? <p role="status">{t("loading")}</p> : null}
            {receipt ? (
              <>
                <p data-testid="agent-retry-receipt">
                  {t(`retryState.${receipt.intentState}`)}
                </p>
                {receipt.refusalReason ? (
                  <p>{t(refusalKey(receipt.refusalReason))}</p>
                ) : null}
                {receipt.cleanup ? (
                  <p>{t(`retryCleanup.${receipt.cleanup.state}`)}</p>
                ) : null}
                {receipt.cleanup?.state === "exhausted" ? (
                  <button
                    className={button}
                    disabled={busy}
                    type="button"
                    onClick={() => void retryCleanup()}
                  >
                    {t("retryCleanupAction")}
                  </button>
                ) : null}
                {receipt.runId ? (
                  <Link className={button} href={`/runs/${receipt.runId}`}>
                    {t("openSuccessor")}
                  </Link>
                ) : null}
                {receipt.intentState === "accepted" ||
                receipt.cleanup?.state === "armed" ? (
                  <button
                    className={button}
                    disabled={busy}
                    type="button"
                    onClick={() => void refreshReceipt()}
                  >
                    {t("refresh")}
                  </button>
                ) : null}
              </>
            ) : options ? (
              <>
                <p>
                  <span className="text-mute">{t("sourceRunner")}: </span>
                  {options.sourceRunnerId ?? t("unavailable")}
                  <span className="mt-1 block text-mute">
                    {t("failureStage")}:{" "}
                    {t(
                      options.eligible
                        ? "stageBeforeWork"
                        : "stageInspectEvidence",
                    )}
                  </span>
                </p>
                {options.differences.length ? (
                  <section>
                    <h3 className="font-semibold">{t("currentDifferences")}</h3>
                    <ul className="list-disc pl-5">
                      {options.differences.map((item) => (
                        <li key={item.field} className="break-words">
                          {t(`difference.${item.field}`)}: {item.source ?? "—"}{" "}
                          → {item.current ?? "—"}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {!options.eligible && !request ? (
                  <p role="status">{t(refusalKey(options.reason))}</p>
                ) : (
                  <>
                    <label
                      className="block font-semibold"
                      htmlFor={`retry-runner-${runId}`}
                    >
                      {t("oneOffRunner")}
                    </label>
                    <select
                      className="w-full rounded-lg border border-line bg-paper p-2"
                      disabled={busy || request !== null}
                      id={`retry-runner-${runId}`}
                      value={runnerId}
                      onChange={(event) => setRunnerId(event.target.value)}
                    >
                      <option value="">{t("chooseRunner")}</option>
                      {options.runners.map((item) => (
                        <option
                          key={item.id}
                          disabled={!item.ready}
                          value={item.id}
                        >
                          {item.label}
                          {item.ready ? "" : ` · ${t("runnerUnavailable")}`}
                        </option>
                      ))}
                    </select>
                    <button
                      className={button}
                      disabled={busy || !runnerId}
                      type="button"
                      onClick={() => void accept()}
                    >
                      {request ? t("retrySameRequest") : t("confirmRetry")}
                    </button>
                  </>
                )}
              </>
            ) : null}
            {!busy && !receipt && (!request || previewRefused) ? (
              <button
                className={button}
                type="button"
                onClick={() => void load()}
              >
                {t("refresh")}
              </button>
            ) : null}
          </div>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
