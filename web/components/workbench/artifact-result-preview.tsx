"use client";

import type { ReactElement, ReactNode } from "react";
import type { ResultItem } from "@/lib/queries/run-results-and-checks";

import { useEffect, useState } from "react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { MarkdownRichView } from "@/components/workbench/markdown-rich-view";
import { useTheme } from "@/lib/theme";

import "@git-diff-view/react/styles/diff-view.css";

export type ArtifactPreviewItem = Pick<
  ResultItem,
  "label" | "artifactKind" | "format"
> & { artifactId: string };

const payloadLimit = 64 * 1024;

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

export function ResultPayload({
  item,
  runId,
}: {
  item: ArtifactPreviewItem;
  runId: string;
}): ReactElement {
  const t = useTranslations("evidence.results");
  const { resolvedTheme } = useTheme();
  const [payload, setPayload] = useState<Preview>({ state: "loading" });
  const url = `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(item.artifactId)}/payload`;

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
  } else if (
    item.format === "diff" &&
    !payload.clipped &&
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(payload.text)
  ) {
    const sections = payload.text.split(/\n(?=diff --git )/);
    const theme = resolvedTheme === "light" ? "light" : "dark";

    content = (
      <div className="max-h-96 overflow-auto" data-testid="result-diff">
        {sections.map((patch, index) => (
          <DiffView
            key={`${index}:${theme}`}
            diffViewWrap
            data={{ hunks: [patch] }}
            diffViewHighlight={false}
            diffViewMode={DiffModeEnum.Unified}
            diffViewTheme={theme}
          />
        ))}
      </div>
    );
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
