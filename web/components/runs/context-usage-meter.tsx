"use client";

import type { ContextSnapshot } from "@/lib/runs/context-snapshot";

import {
  ArrowPathIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";
import { Button, Popover } from "@heroui/react";
import clsx from "clsx";
import { useFormatter, useLocale, useTranslations } from "next-intl";

export function ContextUsageMeter({
  snapshot,
}: {
  snapshot: ContextSnapshot | null;
}) {
  const t = useTranslations("contextUsage");
  const locale = useLocale();
  const format = useFormatter();
  const usage = snapshot?.usage ?? null;
  const fraction = usage ? usage.used / usage.size : null;
  const active = Boolean(snapshot?.activeCompactions);
  const unverified = snapshot?.windowAdvisory === "window_unverified";
  const percentage =
    fraction === null
      ? null
      : format.number(fraction, {
          style: "percent",
          maximumFractionDigits: 1,
          roundingMode: "floor",
        });
  const tokenText = usage ? t("tokenPair", usage) : t("notReported");
  const activity = active ? t("in_progress") : "";

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mute"
      data-testid="context-usage"
    >
      <span>{t("label")}</span>
      <div
        aria-label={usage ? t("label") : undefined}
        aria-valuemax={usage ? usage.size : undefined}
        aria-valuemin={usage ? 0 : undefined}
        aria-valuenow={usage ? Math.min(usage.used, usage.size) : undefined}
        aria-valuetext={usage ? `${percentage} · ${tokenText}` : undefined}
        className={clsx(
          "h-1.5 w-16 overflow-hidden rounded-full bg-ivory ring-1 ring-line",
          active && "ring-2 ring-amber",
        )}
        role={usage ? "meter" : undefined}
      >
        {fraction !== null ? (
          <div
            aria-hidden="true"
            className={clsx(
              "h-full",
              fraction < 0.6
                ? "bg-accent-4"
                : fraction < 0.85
                  ? "bg-amber"
                  : "bg-danger",
            )}
            style={{ width: `${Math.min(100, fraction * 100)}%` }}
          />
        ) : null}
      </div>
      <span className="font-mono tabular-nums" title={tokenText}>
        {percentage ?? t("notReported")}
      </span>
      <span
        aria-live="polite"
        className="inline-flex items-center gap-1 text-amber"
      >
        {active ? (
          <ArrowPathIcon aria-hidden="true" className="size-3.5" />
        ) : null}
        {activity}
      </span>
      {unverified ? (
        <span className="text-amber">{t("unverified")}</span>
      ) : null}
      <Popover>
        <Button
          isIconOnly
          aria-label={t("details")}
          className="h-6 min-w-6"
          size="sm"
          variant="ghost"
        >
          <InformationCircleIcon aria-hidden="true" className="size-4" />
        </Button>
        <Popover.Content className="rounded-md border border-line bg-paper p-3 shadow-lg">
          <Popover.Dialog
            aria-label={t("details")}
            className="grid gap-1 text-xs"
          >
            <p>{percentage ? `${percentage} · ${tokenText}` : tokenText}</p>
            {usage ? (
              <>
                <p>{t("agentReported")}</p>
                <p>
                  {t("updated", {
                    time: format.dateTime(new Date(usage.observedAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
                </p>
              </>
            ) : null}
            {snapshot ? (
              <p>
                {t(
                  snapshot.coverage === "partial"
                    ? "observedCompactions"
                    : "completedCompactions",
                  { count: snapshot.completedCompactions },
                )}
              </p>
            ) : null}
            {snapshot?.configuredWindowTokens ? (
              <p>
                {t(
                  usage && usage.size !== snapshot.configuredWindowTokens
                    ? "windowDiscrepancy"
                    : "runnerConfigured",
                  { size: snapshot.configuredWindowTokens },
                )}
              </p>
            ) : null}
            {unverified ? (
              <>
                <p>{t("windowGuidance")}</p>
                <a
                  className="underline"
                  href={`https://docs.imaister.dev/${locale === "ru" ? "ru/" : ""}administration/runners-and-models`}
                >
                  {t("runnerReference")}
                </a>
              </>
            ) : null}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
  );
}
