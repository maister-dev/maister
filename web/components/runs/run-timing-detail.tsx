"use client";

import type { ReactElement } from "react";
import type { RunTiming } from "@/lib/runs/run-timing";

import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { Button, Popover } from "@heroui/react";
import { useTranslations } from "next-intl";

import { formatDurationMs } from "@/lib/format/duration";

// ADR-208: Duration + Execution with an on-demand breakdown. A real button
// (not hover-only): Enter/Space/tap open it, Escape closes and restores focus.
export function RunTimingFacts({
  timing,
  testId,
}: {
  timing: RunTiming;
  testId: string;
}): ReactElement {
  const t = useTranslations("runTiming");
  const units = { h: t("units.h"), min: t("units.min"), s: t("units.s") };
  const format = (ms: number | null) => formatDurationMs(ms, units);
  const execution =
    timing.executionMs === null
      ? "—"
      : `${timing.quality === "partial" ? "≈ " : ""}${format(timing.executionMs)}`;

  return (
    <span
      className="inline-flex items-center gap-1 tabular-nums"
      data-testid={testId}
    >
      <span data-testid={`${testId}-execution`}>{execution}</span>
      <Popover>
        <Button
          isIconOnly
          aria-label={t("breakdownOpen")}
          className="h-5 min-w-5 text-mute"
          data-testid={`${testId}-breakdown-open`}
          size="sm"
          variant="ghost"
        >
          <InformationCircleIcon aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        <Popover.Content className="rounded-md border border-line bg-paper p-3 shadow-lg">
          <Popover.Dialog
            aria-label={t("breakdownTitle")}
            data-testid={`${testId}-breakdown`}
          >
            <dl className="m-0 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 font-mono text-[11px]">
              <dt className="text-mute">
                {t(timing.live ? "durationLive" : "duration")}
              </dt>
              <dd className="m-0 text-right tabular-nums">
                {format(timing.durationMs)}
              </dd>
              <dt className="text-mute">{t("execution")}</dt>
              <dd className="m-0 text-right tabular-nums">{execution}</dd>
              {timing.breakdown ? (
                <>
                  <dt className="text-mute">{t("admission")}</dt>
                  <dd className="m-0 text-right tabular-nums">
                    {format(timing.breakdown.admissionMs)}
                  </dd>
                  <dt className="text-mute">{t("humanInput")}</dt>
                  <dd className="m-0 text-right tabular-nums">
                    {format(timing.breakdown.humanInputMs)}
                  </dd>
                  <dt className="text-mute">{t("idle")}</dt>
                  <dd className="m-0 text-right tabular-nums">
                    {format(timing.breakdown.idleMs)}
                  </dd>
                  <dt className="text-mute">{t("childExecution")}</dt>
                  <dd className="m-0 text-right tabular-nums">
                    {format(timing.breakdown.childExecutionMs)}
                  </dd>
                  <dt className="text-mute">{t("other")}</dt>
                  <dd className="m-0 text-right tabular-nums">
                    {format(timing.breakdown.otherMs)}
                  </dd>
                </>
              ) : (
                <dd className="col-span-2 m-0 text-mute">{t("unavailable")}</dd>
              )}
              {timing.quality === "partial" ? (
                <dd className="col-span-2 m-0 text-mute">{t("partial")}</dd>
              ) : null}
            </dl>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </span>
  );
}
