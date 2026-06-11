"use client";

import type { WebhookSubscriptionDto } from "@/lib/webhooks/subscriptions";
import type { ReactElement } from "react";

import { useTranslations } from "next-intl";

export type { WebhookSubscriptionDto };

export interface SubscriptionsTableProps {
  subscriptions: WebhookSubscriptionDto[];
  canWrite: boolean;
  onEdit: (subscription: WebhookSubscriptionDto) => void;
  onPing: (subscription: WebhookSubscriptionDto) => void;
  onShowDeliveries: (subscription: WebhookSubscriptionDto) => void;
  onToggleEnabled: (subscription: WebhookSubscriptionDto) => void;
}

// `url` is a validated http(s) URL at write time; parse it only for a compact
// host-only display, falling back to the raw string if parsing ever fails.
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function deliveryDotClass(status: string | undefined): string {
  if (status === "delivered") return "bg-emerald-500";
  if (status === "dead") return "bg-red-500";
  if (status === "pending") return "bg-amber";

  return "bg-line";
}

export function SubscriptionsTable({
  subscriptions,
  canWrite,
  onEdit,
  onPing,
  onShowDeliveries,
  onToggleEnabled,
}: SubscriptionsTableProps): ReactElement {
  const t = useTranslations("webhooks");

  if (subscriptions.length === 0) {
    return (
      <p className="m-0 text-[12px] leading-[1.5] text-mute">{t("empty")}</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] border-collapse text-left">
        <thead className="border-b border-line bg-ivory">
          <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
            <th className="px-4 py-3">{t("colName")}</th>
            <th className="px-4 py-3">{t("colHost")}</th>
            <th className="px-4 py-3">{t("colScope")}</th>
            <th className="px-4 py-3">{t("colEvents")}</th>
            <th className="px-4 py-3">{t("colEnabled")}</th>
            <th className="px-4 py-3">{t("colLastDelivery")}</th>
            <th className="px-4 py-3 text-right">{t("colActions")}</th>
          </tr>
        </thead>
        <tbody>
          {subscriptions.map((sub) => (
            <tr
              key={sub.id}
              className="border-b border-line align-middle text-[12px] last:border-b-0"
            >
              <td className="px-4 py-3 font-semibold text-ink">{sub.name}</td>
              <td className="px-4 py-3 font-mono text-ink-2">
                {urlHost(sub.url)}
              </td>
              <td className="px-4 py-3">
                <span className="rounded-full border border-line px-2 py-1 text-[11px] font-semibold text-mute">
                  {sub.projectId === null
                    ? t("scopePlatform")
                    : t("scopeProject")}
                </span>
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1">
                  {sub.event_types.map((type) => (
                    <span
                      key={type}
                      className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-ink-2"
                    >
                      {type === "*" ? t("allEvents") : type}
                    </span>
                  ))}
                </div>
              </td>
              <td className="px-4 py-3">
                {canWrite ? (
                  <button
                    aria-label={sub.enabled ? t("disable") : t("enable")}
                    aria-pressed={sub.enabled}
                    className="font-mono text-[12px] text-ink-2 hover:text-ink"
                    type="button"
                    onClick={() => onToggleEnabled(sub)}
                  >
                    {sub.enabled ? t("enabledOn") : t("enabledOff")}
                  </button>
                ) : (
                  <span className="font-mono text-[12px] text-ink-2">
                    {sub.enabled ? t("enabledOn") : t("enabledOff")}
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                <span className="flex items-center gap-2 text-[11px] text-mute">
                  <span
                    aria-hidden="true"
                    className={`inline-block h-2 w-2 rounded-full ${deliveryDotClass(
                      sub.lastDelivery?.status,
                    )}`}
                  />
                  {sub.lastDelivery
                    ? t(`deliveryStatus.${sub.lastDelivery.status}`)
                    : t("deliveryStatus.none")}
                </span>
              </td>
              <td className="px-4 py-3 text-right">
                <div className="flex justify-end gap-2">
                  {canWrite ? (
                    <button
                      className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink"
                      type="button"
                      onClick={() => onEdit(sub)}
                    >
                      {t("editAction")}
                    </button>
                  ) : null}
                  <button
                    className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink-2"
                    type="button"
                    onClick={() => onPing(sub)}
                  >
                    {t("pingAction")}
                  </button>
                  <button
                    className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink-2"
                    type="button"
                    onClick={() => onShowDeliveries(sub)}
                  >
                    {t("deliveriesAction")}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
