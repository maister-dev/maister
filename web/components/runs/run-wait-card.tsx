"use client";

import type {
  WaitConditionKind,
  WaitJson,
  WaitSource,
} from "@/lib/waits/contracts";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { useFeedback } from "@/components/feedback/feedback-provider";
import { useWorkbenchStream } from "@/components/runs/run-workbench-stream-provider";
import { WaitCountdown } from "@/components/runs/wait-countdown";

type Action = "deliver_signal" | "resolve_now" | "extend" | "cancel";
type ActionRequest = { body: string; key: string; action: Action };
const waitErrorLabels = {
  wait_version_changed: "changed",
  wait_key_conflict: "changed",
  wait_closed: "closed",
  wait_deadline_elapsed: "closed",
  wait_deadline_cap: "invalidDeadline",
  wait_wrong_head: "wrongHead",
  wait_invalid_payload: "invalidAction",
} as const;

async function waitActionErrorKey(response: Response) {
  if (response.status === 401 || response.status === 403) return "forbidden";

  const refusal: { details?: { reason?: string } } = await response.json();
  const reason = refusal.details?.reason;

  if (reason && Object.hasOwn(waitErrorLabels, reason))
    return waitErrorLabels[reason as keyof typeof waitErrorLabels];

  return "actionFailed";
}

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
  const feedback = useFeedback();
  const stream = useWorkbenchStream();
  const [view, setView] = useState<Inspection | null>(null);
  const [revision, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | "">("");
  const [cancelRequest, setCancelRequest] = useState<ActionRequest | null>(
    null,
  );
  const confirmTitleId = useId();
  const pending = useRef<ActionRequest | null>(null);
  const sending = useRef(false);
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
    if (!view || !currentAction || sending.current || cancelRequest) return;

    const fields = new FormData(event.currentTarget);
    const reason = String(fields.get("reason") ?? "").trim();
    const outcome = String(fields.get("outcome") ?? "");
    const detail: Record<string, unknown> = {};

    if (currentAction === "resolve_now") detail.outcome = outcome;
    if (currentAction === "extend") {
      const deadline = Date.parse(String(fields.get("deadline")));

      if (!Number.isFinite(deadline)) {
        setError(t("invalidDeadline"));

        return;
      }
      detail.deadline = new Date(deadline).toISOString();
    }
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

    const request =
      pending.current?.body === body
        ? pending.current
        : { body, key: crypto.randomUUID(), action: currentAction };

    pending.current = request;
    if (currentAction === "cancel") {
      setError(null);
      setCancelRequest(request);

      return;
    }
    await sendAction(request);
  }

  async function sendAction(request: ActionRequest): Promise<void> {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);

    function reportError(message: string): void {
      setError(message);
      feedback.error({ message, mutationId: request.key });
    }

    try {
      const response = await fetch(`${url}/actions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": request.key,
        },
        body: request.body,
      });

      if (!response.ok) {
        reportError(t(await waitActionErrorKey(response)));

        return;
      }
      pending.current = null;
      setAction("");
      feedback.success({
        message: t(
          request.action === "deliver_signal"
            ? "signalAccepted"
            : "actionSaved",
        ),
        mutationId: request.key,
      });
    } catch {
      reportError(t("actionFailed"));
    } finally {
      sending.current = false;
      setBusy(false);
      setCancelRequest(null);
      refresh((value) => value + 1);
    }
  }

  if (!view && !error) return null;
  const deadline = view?.deadline ? new Date(view.deadline) : null;
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
          <WaitCountdown deadline={deadline.toISOString()} /> ·{" "}
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
      {cancelRequest ? (
        <ConfirmDialog
          body={t("cancelBody")}
          busy={busy}
          cancelLabel={t("keepWaiting")}
          testId="wait-cancel-confirm"
          title={t("cancelTitle")}
          titleId={confirmTitleId}
          onClose={() => setCancelRequest(null)}
        >
          <div className="flex justify-end gap-2">
            <button
              className="rounded border border-line px-3 py-2"
              disabled={busy}
              type="button"
              onClick={() => setCancelRequest(null)}
            >
              {t("keepWaiting")}
            </button>
            <button
              className="rounded border border-amber-line bg-amber-soft px-3 py-2 font-semibold text-amber"
              disabled={busy}
              type="button"
              onClick={() => void sendAction(cancelRequest)}
            >
              {t("actions.cancel")}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
