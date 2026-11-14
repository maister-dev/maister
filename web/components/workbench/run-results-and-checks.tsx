"use client";

import type { ReactElement, ReactNode } from "react";
import type {
  ResultItem,
  RunResultsAndChecks,
} from "@/lib/queries/run-results-and-checks";
import type { EvidenceGraphLabels } from "@/components/board/evidence-graph";
import type { EvidenceGraph } from "@/lib/queries/evidence-graph";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { EvidenceGraphSection } from "@/components/board/evidence-graph-section";
import { ResultPayload } from "@/components/workbench/artifact-result-preview";
import { artifactKindLabel } from "@/lib/board/evidence-graph-layout";
import { buildRunHref, parseRunQueryState } from "@/lib/runs/run-query-state";

const resultStates = new Set([
  "current",
  "stale",
  "superseded",
  "failed",
  "skipped",
  "missing",
  "pending",
  "running",
  "passed",
  "overridden",
  "succeeded",
  "needsinput",
  "waitingonchildren",
  "reworked",
  "cancelled",
  "abandoned",
  "approve",
  "rework",
  "reject",
]);

export function RunResultsAndChecksView({
  runId,
  graph,
  graphLabels,
  results,
  outcome,
}: {
  runId: string;
  graph: EvidenceGraph;
  graphLabels: EvidenceGraphLabels;
  results: RunResultsAndChecks;
  outcome: string;
}): ReactElement {
  const t = useTranslations("evidence.results");
  const pathname = usePathname();
  const search = useSearchParams();
  const { node, evidenceView, evidenceItem } = parseRunQueryState(search);
  const current = results.current.filter((row) => !node || row.nodeId === node);
  const checks = results.checks.filter((row) => !node || row.nodeId === node);
  const previous = results.previous.filter(
    (row) => !node || row.nodeId === node,
  );
  const selected = evidenceItem
    ? [...results.current, ...results.checks, ...results.previous].find(
        (row) => row.id === evidenceItem,
      )
    : undefined;
  const selectedGraphItem = evidenceItem
    ? graph.nodes.find((row) => row.id === evidenceItem)
    : undefined;
  const detail = useRef<HTMLElement>(null);
  const selectedByClick = useRef(false);

  useEffect(() => {
    if (selectedByClick.current && selected) {
      detail.current?.focus({ preventScroll: true });
      selectedByClick.current = false;
    }
  }, [selected]);

  const href = (patch: Parameters<typeof buildRunHref>[2]): string =>
    buildRunHref(pathname, search, { wb: "evidence", ...patch });
  const label = (item: ResultItem): string =>
    item.artifactKind === item.label
      ? artifactKindLabel(item.label, graphLabels)
      : item.label;
  const state = (value: string): string =>
    resultStates.has(value.toLowerCase())
      ? t(`state.${value.toLowerCase()}`)
      : value;

  function rows(items: ResultItem[], empty: string): ReactNode {
    return items.length ? (
      <ul className="divide-y divide-line-soft">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              aria-current={item.id === evidenceItem ? "true" : undefined}
              className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 text-sm hover:underline"
              href={href({ evidenceItem: item.id })}
              scroll={false}
              onClick={() => {
                selectedByClick.current = true;
              }}
            >
              <span className="break-all font-medium">{label(item)}</span>
              <span className="text-xs text-mute">
                {state(item.state)}
                {item.partial ? ` · ${t("partial")}` : ""}
                {item.truncated ? ` · ${t("truncated")}` : ""}
                {item.blocking ? ` · ${t("blocks")}` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-sm text-mute">{empty}</p>
    );
  }

  return (
    <section
      aria-label={t("title")}
      className="grid min-w-0 gap-3 rounded-xl border border-line bg-paper p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">{t("title")}</h2>
        <Link
          className="text-sm underline"
          href={href({
            evidenceView: evidenceView === "graph" ? "list" : "graph",
            ...(selectedGraphItem || !selected ? {} : { evidenceItem: null }),
          })}
          scroll={false}
        >
          {t(evidenceView === "graph" ? "showList" : "graph")}
        </Link>
      </div>
      {evidenceView === "graph" ? (
        <>
          <p className="text-xs text-mute">{t("temporal")}</p>
          <EvidenceGraphSection
            graph={graph}
            labels={graphLabels}
            results={results}
            runId={runId}
          />
        </>
      ) : (
        <>
          <p className="text-sm text-mute">{outcome}</p>
          {selected ? (
            <section
              ref={detail}
              className="grid gap-2 rounded-md border border-line p-3"
              data-testid="selected-result"
              tabIndex={-1}
            >
              <h3 className="break-all text-sm font-semibold">
                {label(selected)}
              </h3>
              <p className="flex flex-wrap gap-x-2 text-xs text-mute">
                <span>{state(selected.state)}</span>
                {selected.nodeId ? (
                  <span>
                    {selected.nodeId}
                    {selected.attempt !== undefined
                      ? ` · ${t("attempt", { count: selected.attempt })}`
                      : ""}
                  </span>
                ) : null}
                {selected.source ? (
                  <span>{t(`source.${selected.source}`)}</span>
                ) : null}
                {selected.applicability ? (
                  <span>{t(`applicability.${selected.applicability}`)}</span>
                ) : null}
                {selected.exitCode !== undefined ? (
                  <span>{t("exitCode", { code: selected.exitCode })}</span>
                ) : null}
                {selected.provenance ? (
                  <span className="break-all">
                    {t(selected.provenance.kind, {
                      value: selected.provenance.value,
                    })}
                  </span>
                ) : null}
                {selected.revision ? (
                  <span className="break-all">
                    {t("revision", { value: selected.revision })}
                  </span>
                ) : null}
              </p>
              {selected.artifactId ? (
                <ResultPayload
                  key={selected.id}
                  item={{ ...selected, artifactId: selected.artifactId }}
                  runId={runId}
                />
              ) : null}
            </section>
          ) : selectedGraphItem ? (
            <p className="text-sm">{selectedGraphItem.label}</p>
          ) : evidenceItem ? (
            <p className="text-sm text-mute" role="status">
              {t("itemUnavailable")}
            </p>
          ) : null}
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold">{t("current")}</h3>
            {rows(current, t("noCurrent"))}
          </div>
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold">{t("checks")}</h3>
            {rows(checks, t("noChecks"))}
          </div>
          {previous.length ||
          (selected &&
            results.previous.some((item) => item.id === selected.id)) ? (
            <details
              open={
                selected &&
                results.previous.some((item) => item.id === selected.id)
                  ? true
                  : undefined
              }
            >
              <summary className="cursor-pointer text-sm font-semibold">
                {t("previous", { count: previous.length })}
              </summary>
              {rows(previous, t("noCurrent"))}
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}
