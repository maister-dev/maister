import type { BoardColumn } from "@/lib/board";
import type { BoardData } from "@/lib/queries/board";
import type { PlatformStatus } from "@/types/platform-status";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import clsx from "clsx";

import { FlightCard } from "@/components/board/flight-card";
import { TaskCard } from "@/components/board/task-card";

export interface BoardProps {
  data: BoardData;
  canAct: boolean;
  platformStatus: PlatformStatus;
}

const STAGE_KEY: Record<BoardColumn, string> = {
  Backlog: "backlog",
  Prepare: "prepare",
  InProduction: "production",
  OnReview: "review",
  InDelivery: "delivery",
  Done: "done",
};

const STAGE_DOT: Record<BoardColumn, string> = {
  Backlog:
    "bg-[repeating-linear-gradient(45deg,var(--mute-2)_0_2px,transparent_2px_3px)] !rounded-[2px]",
  Prepare: "bg-accent-2",
  InProduction:
    "bg-accent-4 shadow-[0_0_0_0_var(--accent-4)] animate-[pulse-dot_2.2s_ease-out_infinite]",
  OnReview: "bg-amber",
  InDelivery: "bg-accent-3",
  Done: "bg-accent-4 opacity-[0.45]",
};

const COLUMN_ORDER: readonly BoardColumn[] = [
  "Backlog",
  "Prepare",
  "InProduction",
  "OnReview",
  "InDelivery",
  "Done",
];

const COLUMN_LABEL: Record<BoardColumn, string> = {
  Backlog: "colBacklog",
  Prepare: "colPrepare",
  InProduction: "colProduction",
  OnReview: "colReview",
  InDelivery: "colDelivery",
  Done: "colDone",
};

export async function Board({
  data,
  canAct,
  platformStatus,
}: BoardProps): Promise<ReactElement> {
  const t = await getTranslations("board");
  const tCommon = await getTranslations("common");
  const tRun = await getTranslations("run");
  const reworkingLabel = tRun("reworking");
  const launchDisabledReason =
    platformStatus.kind === "ready"
      ? undefined
      : t("launchSupervisorUnavailable");

  return (
    <section
      data-board
      aria-label="Task board"
      className={clsx(
        "flex items-stretch gap-3.5 overflow-x-auto overflow-y-visible pb-3.5 [scroll-snap-type:x_proximity]",
        "data-[layout=swimlanes]:flex-col data-[layout=swimlanes]:overflow-x-visible",
        "data-[layout=list]:flex-col data-[layout=list]:overflow-x-visible data-[layout=list]:gap-2",
      )}
      data-layout="board"
    >
      {COLUMN_ORDER.map((col) => {
        const column = data.columns[col];

        return (
          <div
            key={col}
            className={clsx(
              "flex min-h-[420px] w-[296px] flex-none flex-col rounded-[14px] border border-line bg-[color-mix(in_oklab,var(--ivory)_40%,var(--paper))] [scroll-snap-align:start]",
              "[[data-layout=swimlanes]_&]:min-h-0 [[data-layout=swimlanes]_&]:w-auto [[data-layout=swimlanes]_&]:flex-1 [[data-layout=swimlanes]_&]:flex-row",
              "[[data-layout=list]_&]:min-h-0 [[data-layout=list]_&]:w-auto [[data-layout=list]_&]:flex-1",
            )}
            data-stage={STAGE_KEY[col]}
          >
            <header
              className={clsx(
                "sticky top-0 z-[2] flex items-center justify-between gap-2 rounded-t-[14px] border-b border-line bg-[color-mix(in_oklab,var(--ivory)_55%,var(--paper))] px-3.5 pb-[11px] pt-[13px]",
                "[[data-layout=swimlanes]_&]:static [[data-layout=swimlanes]_&]:w-[168px] [[data-layout=swimlanes]_&]:flex-none [[data-layout=swimlanes]_&]:flex-col [[data-layout=swimlanes]_&]:items-start [[data-layout=swimlanes]_&]:justify-center [[data-layout=swimlanes]_&]:rounded-[14px_0_0_14px] [[data-layout=swimlanes]_&]:border-b-0 [[data-layout=swimlanes]_&]:border-r",
              )}
            >
              <h3 className="m-0 inline-flex items-center gap-2.5 font-sans text-sm font-bold tracking-[-0.01em] text-ink">
                <span
                  className={clsx(
                    "h-2 w-2 flex-none rounded-full",
                    STAGE_DOT[col],
                  )}
                />
                {t(COLUMN_LABEL[col])}
                <span className="rounded-full border border-line bg-paper px-[7px] py-0.5 font-mono text-[10px] font-bold tracking-[0.04em] text-ink-2">
                  {column.total}
                </span>
              </h3>
              <span className="whitespace-nowrap font-mono text-[10px] font-bold tracking-[0.04em] text-amber">
                {tCommon("viewAll")} →
              </span>
            </header>

            <div
              className={clsx(
                "flex flex-col gap-2 p-2.5",
                "[[data-layout=swimlanes]_&]:flex-1 [[data-layout=swimlanes]_&]:flex-row [[data-layout=swimlanes]_&]:overflow-x-auto",
                "[[data-layout=list]_&]:grid [[data-layout=list]_&]:grid-cols-[repeat(auto-fill,minmax(320px,1fr))]",
              )}
            >
              {column.backlog.map((card) => (
                <div
                  key={card.taskId}
                  className="[[data-layout=swimlanes]_&]:w-[268px] [[data-layout=swimlanes]_&]:flex-none"
                >
                  <TaskCard
                    canAct={canAct}
                    card={card}
                    launchDisabledLabel={t("launchUnavailable")}
                    launchDisabledReason={launchDisabledReason}
                    launchLabel={tCommon("launch")}
                  />
                </div>
              ))}
              {column.flight.map((card) => (
                <div
                  key={card.runId}
                  className="[[data-layout=swimlanes]_&]:w-[268px] [[data-layout=swimlanes]_&]:flex-none"
                >
                  <FlightCard card={card} reworkingLabel={reworkingLabel} />
                </div>
              ))}
              {column.total === 0 ? (
                <div className="m-1.5 rounded-[10px] border-[1.5px] border-dashed border-line px-3.5 py-[22px] text-center font-mono text-[10.5px] leading-[1.5] tracking-[0.03em] text-mute-2">
                  —
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
