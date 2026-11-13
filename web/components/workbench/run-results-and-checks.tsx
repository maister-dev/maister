"use client";

import type { ReactElement, ReactNode } from "react";
import type {
  ResultItem,
  RunResultsAndChecks,
} from "@/lib/queries/run-results-and-checks";
import type { EvidenceGraphLabels } from "@/components/board/evidence-graph";
import type { EvidenceGraph } from "@/lib/queries/evidence-graph";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { EvidenceGraphSection } from "@/components/board/evidence-graph-section";
import { MarkdownRichView } from "@/components/workbench/markdown-rich-view";
import { artifactKindLabel } from "@/lib/board/evidence-graph-layout";
import { buildRunHref, parseRunQueryState } from "@/lib/runs/run-query-state";

const payloadLimit = 64 * 1024;
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

const mutationReport = z.object({
  basis: z.enum(["node", "cumulative-fallback"]),
  evaluated: z.boolean(),
  touched: z.array(z.string()),
  violations: z.array(z.string()),
  truncated: z.boolean(),
  nodeRange: z.object({ base: z.string(), head: z.string() }),
  mustTouch: z.object({
    globs: z.array(z.string()),
    matched: z.array(z.string()),
  }),
  restrictions: z.object({
    checked: z.array(
      z.object({ id: z.string(), violations: z.array(z.string()) }),
    ),
  }),
});

type Preview =
  | {
      state:
        | "loading"
        | "restricted"
        | "missing"
        | "gone"
        | "integrity"
        | "unavailable";
    }
  | { state: "ready"; text: string; clipped: boolean };

async function readPreview(url: string, signal: AbortSignal): Promise<Preview> {
  const response = await fetch(url, { signal, cache: "no-store" });

  if (response.status === 401 || response.status === 403)
    return { state: "restricted" };
  if (response.status === 404) return { state: "missing" };
  if (response.status === 410) return { state: "gone" };
  if (response.status === 422) return { state: "integrity" };
  if (!response.ok || !response.body) return { state: "unavailable" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let remaining = payloadLimit;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done)
        return {
          state: "ready",
          text: text + decoder.decode(),
          clipped: false,
        };
      text += decoder.decode(next.value.subarray(0, remaining), {
        stream: true,
      });
      remaining -= next.value.byteLength;
      if (remaining < 0) {
        await reader.cancel();

        return { state: "ready", text: text + decoder.decode(), clipped: true };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function ResultPayload({
  item,
  runId,
}: {
  item: ResultItem;
  runId: string;
}): ReactElement {
  const t = useTranslations("evidence.results");
  const [payload, setPayload] = useState<Preview>({ state: "loading" });
  const url = `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(item.artifactId ?? "")}/payload`;

  useEffect(() => {
    const controller = new AbortController();

    void readPreview(url, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPayload(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPayload({ state: "unavailable" });
      });

    return () => controller.abort();
  }, [url]);

  if (payload.state !== "ready")
    return (
      <p className="text-sm text-mute" role="status">
        {t(`payload.${payload.state}`)}
      </p>
    );
  let content: ReactNode;

  if (item.format === "markdown" && !payload.clipped) {
    content = <MarkdownRichView path={item.label} source={payload.text} />;
  } else {
    let report: z.infer<typeof mutationReport> | null = null;

    if (item.artifactKind === "mutation_report" && !payload.clipped) {
      try {
        const parsed = mutationReport.safeParse(
          JSON.parse(payload.text) as unknown,
        );

        if (parsed.success) report = parsed.data;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    content = report ? (
      <div className="space-y-2 text-sm">
        <p>
          {t("report", {
            count: report.touched.length,
            violations: report.violations.length,
          })}
        </p>
        <p>{t(report.evaluated ? "reportEvaluated" : "reportUnevaluated")}</p>
        {report.truncated ? <p>{t("payload.clipped")}</p> : null}
        {report.violations.length ? (
          <ul className="list-disc ps-5">
            {report.violations.map((value, index) => (
              <li key={`${index}:${value}`}>{value}</li>
            ))}
          </ul>
        ) : null}
      </div>
    ) : (
      <>
        <p className="text-xs text-mute">
          {t(item.format === "diff" ? "diff" : "generic")}
        </p>
        <pre className="max-h-96 overflow-auto rounded-md bg-ivory p-3 text-xs">
          {payload.text}
        </pre>
      </>
    );
  }

  return (
    <div className="space-y-2" data-testid="result-payload">
      {payload.clipped ? (
        <p className="text-sm text-mute">{t("payload.clipped")}</p>
      ) : null}
      {content}
      <a download className="text-sm underline" href={url}>
        {t("download")}
      </a>
    </div>
  );
}

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
                  item={selected}
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
