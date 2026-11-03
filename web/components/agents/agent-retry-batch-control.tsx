"use client";

import type {
  AgentRetryBatchOptions as BatchOptions,
  AgentRetryBatchRequest as BatchRequest,
  AgentRetryBatchResultItem as BatchResultItem,
  AgentRetryBatchResult,
} from "@/lib/agents/retry-batch-types";
import type { AgentRetryReceipt } from "@/lib/agents/retry";
import type { ReactElement } from "react";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import {
  retryRefusalKey,
  retryResponseErrorKey,
} from "@/components/agents/retry-refusal";

const button =
  "inline-flex min-h-8 items-center rounded-lg border border-line bg-ivory px-3 text-xs font-semibold text-ink hover:border-mute disabled:opacity-50";

export function AgentRetryBatchControl({
  slug,
  agentId,
  runIds,
  initialRunnerId,
  offerAfterRunnerChange = false,
  onDismiss,
}: {
  slug: string;
  agentId: string;
  runIds?: readonly string[];
  initialRunnerId?: string | null;
  offerAfterRunnerChange?: boolean;
  onDismiss?: () => void;
}): ReactElement {
  const t = useTranslations("agentActivity");
  const router = useRouter();
  const [open, setOpen] = useState(offerAfterRunnerChange);
  const [options, setOptions] = useState<BatchOptions | null>(null);
  const [windowCursor, setWindowCursor] = useState<string | null>(null);
  const [windowStart, setWindowStart] = useState(0);
  const [selectedWork, setSelectedWork] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [runnerId, setRunnerId] = useState(initialRunnerId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<BatchRequest | null>(null);
  const [results, setResults] = useState<BatchResultItem[] | null>(null);
  const [refreshed, setRefreshed] = useState(false);
  const [previewRefused, setPreviewRefused] = useState(false);
  const offered = useRef(false);
  const selectedIds = runIds?.join(",") ?? "";
  const endpoint = `/api/projects/${slug}/agents/${encodeURIComponent(agentId)}`;
  const loadPreview = useCallback(
    async (
      cursor: string | null,
      offset: number,
      selectedRunner?: string,
    ): Promise<void> => {
      setBusy(true);
      setError(null);
      setRefreshed(false);
      try {
        const search = new URLSearchParams();

        if (cursor) search.set("cursor", cursor);
        if (selectedRunner) search.set("runnerId", selectedRunner);
        const response = await fetch(
          `${endpoint}/retry-options${search.size ? `?${search}` : ""}`,
          selectedIds && cursor === null
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  runIds: selectedIds.split(","),
                  ...(selectedRunner ? { runnerId: selectedRunner } : {}),
                }),
              }
            : { cache: "no-store" },
        );

        if (!response.ok) {
          setError(t(await retryResponseErrorKey(response)));

          return;
        }
        const next = (await response.json()) as BatchOptions;

        setOptions(next);
        setWindowCursor(cursor);
        setWindowStart(offset);
        setSelectedWork(
          new Set(
            next.items
              .filter((item) => item.options?.eligible)
              .map((item) => item.runId),
          ),
        );
        setResults(null);
        setRequest(null);
        setPreviewRefused(false);
        setRunnerId((current) =>
          next.items.some((item) => item.options?.launchRequest)
            ? (next.selectedRunnerId ?? "")
            : next.runners.some((item) => item.id === current && item.ready)
              ? current
              : (next.selectedRunnerId ?? ""),
        );
        setRefreshed(true);
        if (offerAfterRunnerChange && next.totalFailed === 0) {
          setOpen(false);
          onDismiss?.();
        }
      } catch {
        setError(t("loadError"));
      } finally {
        setBusy(false);
      }
    },
    [endpoint, selectedIds, t, offerAfterRunnerChange, onDismiss],
  );

  useEffect(() => {
    if (!offerAfterRunnerChange || offered.current) return;
    offered.current = true;
    void loadPreview(null, 0);
  }, [offerAfterRunnerChange, loadPreview]);

  const eligible =
    options?.items.filter(
      (item) => item.options?.eligible && selectedWork.has(item.runId),
    ) ?? [];
  const uncertain = results?.some((item) => item.state === "unknown") ?? false;
  const pendingRequest =
    request !== null && !previewRefused && (results === null || uncertain);
  const canReplacePreview =
    request === null || previewRefused || (results !== null && !uncertain);

  async function accept(): Promise<void> {
    if (!options || !runnerId || (!request && eligible.length === 0)) return;
    const accepted = request ?? {
      runnerId,
      items: eligible.map((item) => ({
        runId: item.runId,
        requestKey: crypto.randomUUID(),
        previewFingerprint: item.options!.previewFingerprint,
        strategy: item.options!.strategy,
        ...(item.options!.launchRequest
          ? { launchRequest: item.options!.launchRequest }
          : {}),
      })),
    };

    setRequest(accepted);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(accepted),
      });

      if (!response.ok) {
        if (response.status >= 400 && response.status < 500)
          setPreviewRefused(true);
        setError(t(await retryResponseErrorKey(response)));

        return;
      }
      const result = (await response.json()) as AgentRetryBatchResult;

      setResults(result.items);
      router.refresh();
    } catch {
      setError(t("retryUnknown"));
    } finally {
      setBusy(false);
    }
  }

  async function refreshResults(): Promise<void> {
    if (!results) return;
    setBusy(true);
    setError(null);
    try {
      const next = await Promise.all(
        results.map(async (item): Promise<BatchResultItem> => {
          if (!item.receipt) return item;
          const response = await fetch(
            `/api/runs/${item.runId}/retry/${item.receipt.retryIntentId}`,
            { cache: "no-store" },
          );

          if (!response.ok) throw new Error("receipt_unavailable");

          return {
            ...item,
            receipt: (await response.json()) as AgentRetryReceipt,
          };
        }),
      );

      setResults(next);
      setRefreshed(true);
      router.refresh();
    } catch {
      setError(t("loadError"));
    } finally {
      setBusy(false);
    }
  }

  async function loadMore(): Promise<void> {
    if (!options?.nextCursor || options.items.length >= 100) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `${endpoint}/retry-options?cursor=${encodeURIComponent(options.nextCursor)}`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        setError(t(await retryResponseErrorKey(response)));

        return;
      }
      const next = (await response.json()) as BatchOptions;
      const merged = [
        ...options.items,
        ...next.items.filter(
          (item) =>
            !options.items.some((previous) => previous.runId === item.runId),
        ),
      ];

      const deduplicated = merged.slice(0, 100).map((item, index) =>
        item.options?.eligible &&
        item.taskId &&
        merged
          .slice(0, index)
          .some(
            (previous) =>
              previous.options?.eligible && previous.taskId === item.taskId,
          )
          ? {
              ...item,
              options: {
                ...item.options,
                eligible: false,
                reason: "retry_duplicate_task",
              },
              reason: "retry_duplicate_task",
            }
          : item,
      );

      setSelectedWork(
        (previous) =>
          new Set([
            ...previous,
            ...deduplicated
              .filter(
                (item) =>
                  item.options?.eligible &&
                  !options.items.some((old) => old.runId === item.runId),
              )
              .map((item) => item.runId),
          ]),
      );
      setOptions({
        ...next,
        items: deduplicated,
        hasMore: next.hasMore || merged.length > 100,
        runners: options.runners.map((runner) => ({
          ...runner,
          ready:
            runner.ready &&
            next.runners.some((item) => item.id === runner.id && item.ready),
        })),
      });
    } catch {
      setError(t("loadError"));
    } finally {
      setBusy(false);
    }
  }

  function close(): void {
    setOpen(false);
    onDismiss?.();
  }

  if (offerAfterRunnerChange && options?.totalFailed === 0) return <></>;

  return (
    <>
      <button
        className={button}
        disabled={
          !pendingRequest && runIds !== undefined && runIds.length === 0
        }
        type="button"
        onClick={() => {
          setOpen(true);
          if (canReplacePreview) void loadPreview(windowCursor, windowStart);
        }}
      >
        {pendingRequest
          ? t("recoverPendingBatch")
          : runIds === undefined
            ? t("retryAllFailed")
            : t("retrySelected", { count: runIds.length })}
      </button>
      {open ? (
        <ConfirmDialog
          body={t(
            offerAfterRunnerChange
              ? "runnerChangedRetryOffer"
              : "retryBatchHint",
          )}
          busy={busy}
          cancelLabel={t("close")}
          testId="agent-retry-batch-dialog"
          title={t("retryBatchTitle")}
          titleId={`retry-batch-${agentId}`}
          onClose={close}
        >
          <div
            aria-busy={busy}
            aria-live="polite"
            className="space-y-4 text-sm"
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
            {pendingRequest ? (
              <p
                className="rounded-lg border border-amber/40 p-3"
                role="status"
              >
                {t("pendingBatchHint")}
              </p>
            ) : null}
            {!options && !busy ? (
              <button
                className={button}
                type="button"
                onClick={() => void loadPreview(windowCursor, windowStart)}
              >
                {t("refresh")}
              </button>
            ) : null}
            {options ? (
              <>
                <p className="text-xs text-mute">
                  {t("batchWindowRange", {
                    start: options.items.length ? windowStart + 1 : 0,
                    end: windowStart + options.items.length,
                    total: options.totalFailed,
                  })}
                </p>
                <p>
                  {t("batchPreviewSummary", {
                    eligible: eligible.length,
                    total: options.items.length,
                  })}
                </p>
                {options.items.some(
                  (item) => item.options?.qualificationOptIn,
                ) ? (
                  <p className="rounded-lg border border-amber/40 p-3">
                    {t("qualificationOptIn")}
                  </p>
                ) : null}
                <label
                  className="block font-semibold"
                  htmlFor={`batch-runner-${agentId}`}
                >
                  {t("batchRunner")}
                </label>
                <select
                  className="w-full rounded-lg border border-line bg-paper p-2"
                  disabled={busy || request !== null}
                  id={`batch-runner-${agentId}`}
                  value={runnerId}
                  onChange={(event) => {
                    const selected = event.target.value;

                    setRunnerId(selected);
                    if (
                      options.items.some((item) => item.options?.launchRequest)
                    )
                      void loadPreview(windowCursor, windowStart, selected);
                  }}
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
                <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line px-3">
                  {options.items.map((item) => {
                    const result = results?.find(
                      (entry) => entry.runId === item.runId,
                    );

                    return (
                      <li
                        key={item.runId}
                        className="space-y-1 py-3"
                        data-testid="agent-retry-batch-item"
                      >
                        <label className="flex items-center gap-2">
                          <input
                            aria-label={t("selectFailedRun", {
                              runId: item.runId.slice(0, 8),
                            })}
                            checked={
                              item.options?.eligible === true &&
                              selectedWork.has(item.runId)
                            }
                            disabled={
                              busy ||
                              request !== null ||
                              !item.options?.eligible
                            }
                            type="checkbox"
                            onChange={() =>
                              setSelectedWork(
                                (previous) =>
                                  new Set(
                                    previous.has(item.runId)
                                      ? [...previous].filter(
                                          (id) => id !== item.runId,
                                        )
                                      : [...previous, item.runId],
                                  ),
                              )
                            }
                          />
                          <Link
                            className="break-words font-semibold underline underline-offset-2"
                            href={`/runs/${item.runId}`}
                          >
                            {item.title}
                          </Link>
                        </label>
                        {item.options?.launchPreview &&
                        item.options.launchRequest ? (
                          <details>
                            <summary>
                              {t("retryTaskRevision", {
                                revision:
                                  item.options.launchRequest
                                    .expectedTaskRevision,
                              })}
                            </summary>
                            <p className="whitespace-pre-wrap break-words">
                              {item.options.launchPreview.prompt}
                            </p>
                            <p>
                              {t("retryTarget")}:{" "}
                              {item.options.launchRequest.agentId} ·{" "}
                              {t(
                                `retryWorkspace.${item.options.launchRequest.workspace}`,
                              )}
                            </p>
                          </details>
                        ) : null}
                        {result ? (
                          <>
                            <p>
                              {result.receipt
                                ? t(`retryState.${result.receipt.intentState}`)
                                : t(
                                    result.state === "unknown"
                                      ? "retryUnknown"
                                      : retryRefusalKey(result.reason),
                                  )}
                            </p>
                            {result.receipt?.runStatus ? (
                              <p>
                                {t("successorStatus")}:{" "}
                                {t(`status.${result.receipt.runStatus}`)}
                              </p>
                            ) : null}
                            {result.receipt?.runId ? (
                              <Link
                                className="underline"
                                href={`/runs/${result.receipt.runId}`}
                              >
                                {t("openSuccessor")}
                              </Link>
                            ) : null}
                            {result.receipt?.refusalReason ? (
                              <p>
                                {t(
                                  retryRefusalKey(result.receipt.refusalReason),
                                )}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <p className="text-xs text-mute">
                            {item.options?.eligible
                              ? t(
                                  item.options.strategy ===
                                    "fresh_qualification"
                                    ? "freshQualification"
                                    : "batchEligible",
                                )
                              : t(
                                  retryRefusalKey(
                                    item.reason ?? item.options?.reason ?? null,
                                  ),
                                )}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {options.hasMore ? (
                  <p className="text-xs text-mute">
                    {t("batchMoreAvailable", { count: options.totalFailed })}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {windowCursor !== null && canReplacePreview ? (
                    <button
                      className={button}
                      disabled={busy}
                      type="button"
                      onClick={() => void loadPreview(null, 0)}
                    >
                      {t("latestFailedWork")}
                    </button>
                  ) : null}
                  {!results || uncertain ? (
                    <button
                      className={button}
                      disabled={
                        busy ||
                        !runnerId ||
                        (eligible.length === 0 && request === null)
                      }
                      type="button"
                      onClick={() => void accept()}
                    >
                      {request
                        ? t("retrySameRequest")
                        : t("confirmBatchRetry", { count: eligible.length })}
                    </button>
                  ) : null}
                  {results ? (
                    <button
                      className={button}
                      disabled={busy}
                      type="button"
                      onClick={() => void refreshResults()}
                    >
                      {t("refresh")}
                    </button>
                  ) : null}
                  {!request || previewRefused || (results && !uncertain) ? (
                    <button
                      className={button}
                      disabled={busy}
                      type="button"
                      onClick={() =>
                        void loadPreview(windowCursor, windowStart)
                      }
                    >
                      {t(results ? "prepareAnotherBatch" : "refresh")}
                    </button>
                  ) : null}
                  {options.nextCursor && canReplacePreview ? (
                    <button
                      className={button}
                      disabled={busy}
                      type="button"
                      onClick={() =>
                        void loadPreview(
                          options.nextCursor,
                          windowStart + options.items.length,
                        )
                      }
                    >
                      {t("nextFailedWindow")}
                    </button>
                  ) : null}
                  {!request && options.hasMore && options.items.length < 100 ? (
                    <button
                      className={button}
                      disabled={busy}
                      type="button"
                      onClick={() => void loadMore()}
                    >
                      {t("previewMoreFailed")}
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
