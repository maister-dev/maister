"use client";

import type { AgentRetryOptions } from "@/lib/agents/retry-preparation";
import type { AgentRetryReceipt } from "@/lib/agents/retry";
import type { ReactElement } from "react";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import {
  retryRefusalKey,
  retryResponseErrorKey,
} from "@/components/agents/retry-refusal";

type AcceptedRequest = {
  runnerId: string;
  requestKey: string;
  previewFingerprint: string;
  strategy: AgentRetryOptions["strategy"];
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
  const [refreshed, setRefreshed] = useState(false);
  const load = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setRefreshed(false);
    try {
      const response = await fetch(`/api/runs/${runId}/retry-options`, {
        cache: "no-store",
      });

      if (!response.ok) {
        setError(
          t(response.status === 403 ? "permissionChanged" : "loadError"),
        );

        return;
      }
      const next = (await response.json()) as AgentRetryOptions;

      setOptions(next);
      setRunnerId((current) =>
        next.existingIntentId && request
          ? request.runnerId
          : next.runners.some((item) => item.id === current && item.ready)
            ? current
            : (next.selectedRunnerId ?? ""),
      );
      if (!next.existingIntentId) {
        setReceipt(null);
        setRequest(null);
        setCleanupRequest(null);
        setPreviewRefused(false);
      }
      setRefreshed(true);
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
      strategy: options.strategy,
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
        if (response.status >= 400 && response.status < 500)
          setPreviewRefused(true);
        setError(t(await retryResponseErrorKey(response)));

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
        if (response.status === 409) {
          setCleanupRequest(null);
          setError(t("cleanupConflict"));
          try {
            const current = await fetch(
              `/api/runs/${runId}/retry/${receipt.retryIntentId}`,
              { cache: "no-store" },
            );

            if (current.ok)
              setReceipt((await current.json()) as AgentRetryReceipt);
            else setError(t("loadError"));
          } catch {
            setError(t("loadError"));
          }
        } else setError(t("cleanupError"));

        return;
      }
      const status = await fetch(
        `/api/runs/${runId}/retry/${receipt.retryIntentId}`,
        { cache: "no-store" },
      );

      if (!status.ok) {
        setError(t("loadError"));

        return;
      }
      setReceipt((await status.json()) as AgentRetryReceipt);
      setCleanupRequest(null);
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
          if (!request || receipt || previewRefused) void load();
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
            {refreshed && !busy ? (
              <p className="text-xs text-mute" role="status">
                {t("previewRefreshed")}
              </p>
            ) : null}
            {receipt ? (
              <>
                <p data-testid="agent-retry-receipt">
                  {t(`retryState.${receipt.intentState}`)}
                </p>
                {receipt.runStatus ? (
                  <p>
                    {t("successorStatus")}: {t(`status.${receipt.runStatus}`)}
                  </p>
                ) : null}
                {receipt.queueReason ? <p>{t("queuePending")}</p> : null}
                {receipt.refusalReason ? (
                  <p>{t(retryRefusalKey(receipt.refusalReason))}</p>
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
                <button
                  className={button}
                  disabled={busy}
                  type="button"
                  onClick={() => void refreshReceipt()}
                >
                  {t("refresh")}
                </button>

                {receipt.intentState === "refused" &&
                (!receipt.cleanup || receipt.cleanup.state === "released") ? (
                  <button
                    className={button}
                    disabled={busy}
                    type="button"
                    onClick={() => void load()}
                  >
                    {t("prepareAnotherAttempt")}
                  </button>
                ) : null}
              </>
            ) : options ? (
              <>
                <p>
                  <span className="text-mute">{t("sourceRunner")}: </span>
                  {options.sourceRunnerId ?? t("unavailable")}
                  <span className="mt-1 block">
                    <span className="text-mute">{t("currentRunner")}: </span>
                    {options.runners.find(
                      (item) => item.id === options.selectedRunnerId,
                    )?.label ?? t("unavailable")}
                  </span>
                  <span className="mt-1 block text-mute">
                    {t(
                      options.strategy === "fresh_qualification"
                        ? "retryAction"
                        : "failureStage",
                    )}
                    :{" "}
                    {t(
                      options.strategy === "fresh_qualification"
                        ? "freshQualification"
                        : options.eligible
                          ? "stageBeforeWork"
                          : "stageInspectEvidence",
                    )}
                  </span>
                </p>
                {options.differences.length ? (
                  <details>
                    <summary className="font-semibold">
                      {t("currentDifferences")}
                    </summary>
                    <ul className="list-disc pl-5">
                      {options.differences.map((item) => (
                        <li key={item.field} className="break-words">
                          {t(`difference.${item.field}`)}:{" "}
                          {item.source?.slice(0, 16) ?? "—"} →{" "}
                          {item.current?.slice(0, 16) ?? "—"}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {!options.eligible && !request ? (
                  <p
                    className="rounded-lg border border-amber/40 p-3"
                    role="status"
                  >
                    {t(retryRefusalKey(options.reason))}
                  </p>
                ) : null}
                {options.qualificationOptIn ? (
                  <p className="rounded-lg border border-amber/40 p-3">
                    {t("qualificationOptIn")}
                  </p>
                ) : null}
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
                    disabled={
                      busy ||
                      !runnerId ||
                      (!options.eligible && request === null)
                    }
                    type="button"
                    onClick={() => void accept()}
                  >
                    {request
                      ? t("retrySameRequest")
                      : options.strategy === "fresh_qualification"
                        ? t("confirmQualification")
                        : t("confirmRetry")}
                  </button>
                </>
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
