"use client";

import type { ReactNode } from "react";
import type { ResultStatus } from "@/lib/run-results/types";

import { Button } from "@heroui/react";
import {
  ChevronDoubleLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  RUN_STATUS_DOT_CLASS,
  runStatusTone,
} from "@/lib/runs/run-status-tone";
import { useRunChildren } from "@/components/runs/run-children-provider";
import { RunPeekLink, useRunPeek } from "@/components/runs/run-peek-controller";

export function RunChildPageList({
  parentId,
}: {
  parentId: string;
}): ReactNode {
  const peek = useRunPeek()!;
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const result = useRunChildren(parentId, cursor);
  const t = peek.t;
  // A new list identity owns its page position; callers key it by parent Run.
  const [knownCount, setKnownCount] = useState<number | null>(null);

  if (
    result?.page &&
    (knownCount === null || result.page.totalCount < knownCount)
  )
    setKnownCount(result.page.totalCount);
  if (!result || (result.loading && !result.page))
    return <p role="status">{t("loading")}</p>;
  if (result.error)
    return (
      <div role="status">
        {t(
          result.error === 403
            ? "forbidden"
            : result.error === 404
              ? "unavailable"
              : "error",
        )}{" "}
        <button type="button" onClick={result.reload}>
          {t("retry")}
        </button>
      </div>
    );
  const page = result.page;

  if (!page) return null;

  return (
    <div className="min-w-0 space-y-2">
      {knownCount !== null && page.totalCount > knownCount ? (
        <p role="status">
          {t("newChildren")}{" "}
          <button
            type="button"
            onClick={() => {
              setKnownCount(page.totalCount);
              setPrevious([]);
              setCursor(null);
            }}
          >
            {t("showNewChildren")}
          </button>
        </p>
      ) : null}
      <p className="text-xs text-mute">
        {t("count", { count: page.totalCount })}
      </p>
      {page.items.length === 0 ? (
        <p>{t("emptyChildren")}</p>
      ) : (
        <ul className="m-0 list-none space-y-2 p-0">
          {page.items.map((child) => (
            <li
              key={child.runId}
              className="min-w-0 rounded border border-line p-2"
              data-child-run-id={child.runId}
              data-run-status={child.status}
            >
              <RunPeekLink
                className="block break-words font-semibold text-ink hover:underline"
                runId={child.runId}
              >
                {child.label}
              </RunPeekLink>
              <p className="m-0 text-xs text-mute">
                {t(`kind_${child.runKind}`)} · {t("executionStatus")}:{" "}
                <RunExecutionStatus status={child.status} />
              </p>
              {child.delegationTarget ? (
                <p className="m-0 break-words text-xs">
                  <span>{t(`kind_${child.delegationTarget.kind}`)}</span>
                  {" · "}
                  <span
                    className="font-mono"
                    data-target-kind={child.delegationTarget.kind}
                    data-testid="orchestrator-child-target"
                  >
                    {child.delegationTarget.ref}
                  </span>
                </p>
              ) : null}
              {child.resultStatus ? (
                <p
                  className="m-0 text-xs"
                  data-result-status={child.resultStatus}
                >
                  {t("publicResult")}:{" "}
                  <RunResultStatus status={child.resultStatus} />
                </p>
              ) : null}
              {!child.launchedAt ? (
                <span className="text-xs text-mute">{t("unknownLaunch")}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {cursor !== null || page.hasMore ? (
        <nav
          aria-label={t("pages")}
          className="flex items-center justify-end gap-1"
        >
          <span title={t("firstPage")}>
            <Button
              isIconOnly
              aria-label={t("firstPage")}
              isDisabled={cursor === null || result.loading}
              size="sm"
              type="button"
              variant="tertiary"
              onClick={() => {
                setPrevious([]);
                setCursor(null);
              }}
            >
              <ChevronDoubleLeftIcon aria-hidden className="h-4 w-4" />
            </Button>
          </span>
          <span title={t("earlierPage")}>
            <Button
              isIconOnly
              aria-label={t("earlierPage")}
              isDisabled={previous.length === 0 || result.loading}
              size="sm"
              type="button"
              variant="tertiary"
              onClick={() => {
                const stack = [...previous];

                setCursor(stack.pop() ?? null);
                setPrevious(stack);
              }}
            >
              <ChevronLeftIcon aria-hidden className="h-4 w-4" />
            </Button>
          </span>
          <span title={t("next")}>
            <Button
              isIconOnly
              aria-label={t("next")}
              isDisabled={!page.hasMore || result.loading}
              size="sm"
              type="button"
              variant="tertiary"
              onClick={() => {
                setPrevious((items) => [...items, cursor].slice(-32));
                setCursor(page.nextCursor);
              }}
            >
              <ChevronRightIcon aria-hidden className="h-4 w-4" />
            </Button>
          </span>
        </nav>
      ) : null}
    </div>
  );
}

export function RunExecutionStatus({ status }: { status: string }): ReactNode {
  const t = useTranslations("run.runStatus");

  return (
    <span>
      <span
        aria-hidden
        className={`mr-1 inline-block h-2 w-2 rounded-full ${RUN_STATUS_DOT_CLASS[runStatusTone(status)]}`}
      />
      {t.has(status) ? t(status) : status}
    </span>
  );
}
export function RunResultStatus({
  status,
}: {
  status: ResultStatus;
}): ReactNode {
  const t = useTranslations("run");
  const keys: Record<ResultStatus, string> = {
    valid: "publicResultStatusValid",
    pending: "publicResultStatusPending",
    absent: "publicResultStatusAbsent",
    missing: "publicResultStatusMissing",
    stale: "publicResultStatusStale",
    invalid: "publicResultStatusInvalid",
    unavailable: "publicResultStatusUnavailable",
  };

  return <span>{t(keys[status])}</span>;
}
