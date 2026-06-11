"use client";

import type {
  DeliveryAttemptDto,
  DeliveryDto,
} from "@/lib/webhooks/subscriptions";
import type { ReactElement } from "react";

import { useTranslations } from "next-intl";

export type { DeliveryDto, DeliveryAttemptDto };

export interface PingOutcome {
  ok: boolean;
  httpStatus?: number;
}

export interface DeliveriesDrawerProps {
  deliveries: DeliveryDto[];
  canWrite: boolean;
  onReplay: (deliveryId: string) => void;
  onClose: () => void;
  // Last test-ping result for this subscription, surfaced inline at the top of
  // the drawer. The parent triggers the ping and feeds the result back here.
  pingResult?: PingOutcome | null;
}

function statusDotClass(status: string): string {
  if (status === "delivered") return "bg-emerald-500";
  if (status === "dead") return "bg-red-500";
  if (status === "pending") return "bg-amber";

  return "bg-line";
}

const cell = "px-3 py-1.5 font-mono text-[11px] text-ink-2";

function AttemptsTable({
  attempts,
}: {
  attempts: DeliveryAttemptDto[];
}): ReactElement {
  const t = useTranslations("webhooks");

  return (
    <table className="w-full border-collapse text-left">
      <thead>
        <tr className="font-mono text-[9px] uppercase tracking-[0.1em] text-mute">
          <th className="px-3 py-1">{t("attemptNo")}</th>
          <th className="px-3 py-1">{t("attemptHttpStatus")}</th>
          <th className="px-3 py-1">{t("attemptErrorKind")}</th>
          <th className="px-3 py-1">{t("attemptDuration")}</th>
          <th className="px-3 py-1">{t("attemptResponse")}</th>
        </tr>
      </thead>
      <tbody>
        {attempts.map((attempt) => (
          <tr key={attempt.attemptNo} className="border-t border-line">
            <td className={cell}>{attempt.attemptNo}</td>
            <td className={cell}>{attempt.httpStatus ?? "—"}</td>
            <td className={cell}>
              {attempt.errorKind ? t(`errorKind.${attempt.errorKind}`) : "—"}
            </td>
            <td className={cell}>{attempt.durationMs}</td>
            <td className={cell}>{attempt.responseSnippet ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DeliveriesDrawer({
  deliveries,
  canWrite,
  onReplay,
  onClose,
  pingResult,
}: DeliveriesDrawerProps): ReactElement {
  const t = useTranslations("webhooks");

  return (
    <div className="fixed inset-y-0 right-0 z-[200] flex w-full max-w-[560px] flex-col border-l border-line bg-paper shadow-[var(--shadow-lg)]">
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {t("deliveriesTitle")}
        </h2>
        <button
          aria-label={t("close")}
          className="font-mono text-[14px] text-mute hover:text-ink"
          type="button"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {pingResult ? (
        <div
          aria-live="polite"
          className="border-b border-line px-5 py-3 font-mono text-[11px] text-ink-2"
          role="status"
        >
          {pingResult.ok
            ? t("pingOk", { status: pingResult.httpStatus ?? 0 })
            : t("pingFailed", { status: pingResult.httpStatus ?? 0 })}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 overflow-y-auto overscroll-contain px-5 py-5">
        {deliveries.length === 0 ? (
          <p className="m-0 text-[12px] leading-[1.5] text-mute">
            {t("deliveriesEmpty")}
          </p>
        ) : (
          deliveries.map((delivery) => {
            const replayable =
              delivery.status === "delivered" || delivery.status === "dead";

            return (
              <details
                key={delivery.id}
                className="rounded-lg border border-line bg-ivory"
              >
                <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3">
                  <span className="flex items-center gap-2 text-[12px] text-ink">
                    <span
                      aria-hidden="true"
                      className={`inline-block h-2 w-2 rounded-full ${statusDotClass(
                        delivery.status,
                      )}`}
                    />
                    <span className="font-semibold">
                      {t(`deliveryStatus.${delivery.status}`)}
                    </span>
                    <span className="font-mono text-[11px] text-ink-2">
                      {delivery.type}
                    </span>
                  </span>
                  <span className="flex items-center gap-3 font-mono text-[11px] text-mute">
                    <span>
                      {t("attemptCount", { count: delivery.attemptCount })}
                    </span>
                    <span>{delivery.lastHttpStatus ?? "—"}</span>
                    {canWrite && replayable ? (
                      <button
                        className="h-7 rounded-[8px] border border-line px-2.5 text-[11px] font-semibold text-ink"
                        type="button"
                        onClick={() => onReplay(delivery.id)}
                      >
                        {t("replayAction")}
                      </button>
                    ) : null}
                  </span>
                </summary>
                <div className="border-t border-line px-4 py-3">
                  {delivery.attempts.length === 0 ? (
                    <p className="m-0 font-mono text-[11px] text-mute">
                      {t("attemptsEmpty")}
                    </p>
                  ) : (
                    <AttemptsTable attempts={delivery.attempts} />
                  )}
                </div>
              </details>
            );
          })
        )}
      </div>
    </div>
  );
}
