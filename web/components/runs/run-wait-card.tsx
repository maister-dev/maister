"use client";

import type {
  WaitConditionKind,
  WaitJson,
  WaitSource,
} from "@/lib/waits/contracts";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

import { useWorkbenchStream } from "@/components/runs/run-workbench-stream-provider";

type Action = "deliver_signal" | "resolve_now" | "extend" | "cancel";
type Inspection = {
  id: string;
  status: "reserved" | "parking" | "open" | "resolved" | "closed";
  version: number;
  deadline: string | null;
  condition: { kind: WaitConditionKind; label?: string };
  allowedActions: Action[];
  allowedOutcomes: string[];
  allowedSignalOutcomes: string[];
  result?: {
    outcome: string;
    source: WaitSource;
    redacted: boolean;
    data?: WaitJson;
  };
  deliveries: Array<{
    id: string;
    status: "accepted" | "stale" | "rejected";
    receivedAt: string;
  }>;
  nextCursor: string | null;
};

export function RunWaitCard({
  runId,
  waitId,
}: {
  runId: string;
  waitId: string;
}) {
  const t = useTranslations("flowWait");
  const stream = useWorkbenchStream();
  const [view, setView] = useState<Inspection | null>(null);
  const [revision, refresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | "">("");
  const pending = useRef<{ body: string; key: string } | null>(null);
  const url = `/api/runs/${encodeURIComponent(runId)}/waits/${encodeURIComponent(waitId)}`;

  useEffect(() => {
    const controller = new AbortController();

    void fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(t("unavailable"));
        const next: Inspection = await response.json();

        if (!controller.signal.aborted) setView(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(t("unavailable"));
      });

    return () => controller.abort();
  }, [url, revision, stream?.mainSummaryTick, stream?.main.liveness, t]);

  useEffect(() => {
    if (view?.status !== "open") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [view?.status]);

  const currentAction =
    view?.allowedActions.find((value) => value === action) ?? "";

  async function loadDeliveries(): Promise<void> {
    if (!view?.nextCursor || loadingDeliveries) return;
    const query = new URLSearchParams({ cursor: view.nextCursor });

    setLoadingDeliveries(true);
    setError(null);
    try {
      const response = await fetch(`${url}?${query}`, { cache: "no-store" });

      if (!response.ok) throw new Error(t("unavailable"));
      const page: Inspection = await response.json();

      setView((current) =>
        current === view
          ? {
              ...current,
              deliveries: [...current.deliveries, ...page.deliveries],
              nextCursor: page.nextCursor,
            }
          : current,
      );
    } catch {
      setError(t("unavailable"));
    } finally {
      setLoadingDeliveries(false);
    }
  }

  async function operate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!view || !currentAction || busy) return;

    const fields = new FormData(event.currentTarget);
    const reason = String(fields.get("reason") ?? "").trim();
    const outcome = String(fields.get("outcome") ?? "");
    const detail: Record<string, unknown> = {};

    if (currentAction === "resolve_now") detail.outcome = outcome;
    if (currentAction === "extend")
      detail.deadline = new Date(String(fields.get("deadline"))).toISOString();
    if (currentAction === "deliver_signal") {
      const payload = String(fields.get("payload") ?? "").trim();
      const headSha = String(fields.get("headSha") ?? "").trim();

      try {
        detail.signal = {
          name: view.condition.label,
          outcome,
          ...(headSha ? { headSha } : {}),
          ...(payload ? { payload: JSON.parse(payload) } : {}),
        };
      } catch (parseError: unknown) {
        if (!(parseError instanceof SyntaxError)) throw parseError;
        setError(t("invalidPayload"));

        return;
      }
    }
    const body = JSON.stringify({
      action: currentAction,
      expectedVersion: view.version,
      reason,
      ...detail,
    });

    if (pending.current?.body !== body)
      pending.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`${url}/actions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": pending.current.key,
        },
        body,
      });

      if (!response.ok) {
        const refusal: { message?: string } = await response.json();

        setError(refusal.message ?? t("unavailable"));

        return;
      }
      pending.current = null;
      setAction("");
    } catch {
      setError(t("unavailable"));
    } finally {
      setBusy(false);
      refresh((value) => value + 1);
    }
  }

  if (!view && !error) return null;
  const deadline = view?.deadline ? new Date(view.deadline) : null;
  const remaining = deadline
    ? Math.max(0, Math.ceil((deadline.getTime() - now) / 1000))
    : null;
  const options =
    (currentAction === "deliver_signal"
      ? view?.allowedSignalOutcomes
      : view?.allowedOutcomes) ?? [];

  return (
    <section
      aria-label={t("waitTitle")}
      className="flex flex-col gap-3 rounded-lg border border-line bg-paper p-3 text-sm"
      data-testid="run-wait-card"
    >
      <h3 className="font-semibold">
        {view?.status === "open"
          ? t("waitingFor", {
              condition:
                view.condition.label ?? t(`kind.${view.condition.kind}`),
            })
          : t("waitTitle")}
      </h3>
      {view?.status === "open" && deadline && (
        <p>
          {remaining
            ? t("secondsRemaining", { seconds: remaining })
            : t("overdue")}{" "}
          ·{" "}
          <time dateTime={deadline.toISOString()}>
            {deadline.toLocaleString()}
          </time>
        </p>
      )}
      {view?.result && <p>{t("outcome", { outcome: view.result.outcome })}</p>}
      {view?.result?.data !== undefined && (
        <details>
          <summary>{t("resultData")}</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
            {JSON.stringify(view.result.data, null, 2)}
          </pre>
        </details>
      )}
      {view?.deliveries.length ? (
        <ul aria-label={t("deliveries")}>
          {view.deliveries.map((delivery) => (
            <li key={delivery.id}>
              {t(`delivery.${delivery.status}`)} ·{" "}
              <time dateTime={delivery.receivedAt}>
                {new Date(delivery.receivedAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ul>
      ) : null}
      {view?.nextCursor && (
        <button
          className="self-start rounded border border-line px-2 py-1"
          disabled={loadingDeliveries}
          type="button"
          onClick={() => void loadDeliveries()}
        >
          {t("moreDeliveries")}
        </button>
      )}
      {view?.allowedActions.length ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => void operate(event)}
        >
          <label className="flex flex-col gap-1">
            {t("action")}
            <select
              className="rounded border border-line bg-paper p-1"
              disabled={busy}
              value={currentAction}
              onChange={(event) => setAction(event.target.value as Action | "")}
            >
              <option value="">{t("chooseAction")}</option>
              {view.allowedActions.map((option) => (
                <option key={option} value={option}>
                  {t(`actions.${option}`)}
                </option>
              ))}
            </select>
          </label>
          {(currentAction === "resolve_now" ||
            currentAction === "deliver_signal") && (
            <label>
              {t("chooseOutcome")}
              <select required name="outcome">
                {options.map((outcome) => (
                  <option key={outcome}>{outcome}</option>
                ))}
              </select>
            </label>
          )}
          {currentAction === "extend" && (
            <label>
              {t("newDeadline")}{" "}
              <input required name="deadline" type="datetime-local" />
            </label>
          )}
          {currentAction === "deliver_signal" && (
            <>
              <label>
                {t("headSha")} <input maxLength={64} name="headSha" />
              </label>
              <label>
                {t("payload")} <textarea name="payload" rows={3} />
              </label>
            </>
          )}
          {currentAction && (
            <>
              <label>
                {t("reason")} <input required maxLength={1024} name="reason" />
              </label>
              <button
                className="self-start rounded border border-line px-2 py-1"
                disabled={busy}
                type="submit"
              >
                {t("applyAction")}
              </button>
            </>
          )}
        </form>
      ) : null}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
