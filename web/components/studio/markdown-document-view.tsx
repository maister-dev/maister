import type { ReactElement, ReactNode } from "react";

import Link from "next/link";

import { MarkdownRichView } from "@/components/workbench/markdown-rich-view";
import { splitFrontmatter } from "@/lib/flows/artifact-frontmatter";

export type MarkdownDocumentMode = "preview" | "code";

export type MarkdownDocumentViewLabels = {
  preview: string;
  code: string;
  frontmatter: string;
  malformedFrontmatter: string;
};

type FrontmatterEntry = {
  key: string;
  value: string;
  multiline: boolean;
};

function frontmatterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(frontmatterValue).join(", ");
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }

  return String(value);
}

function frontmatterEntries(
  frontmatter: Record<string, unknown> | undefined,
): FrontmatterEntry[] {
  return Object.entries(frontmatter ?? {})
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => {
      const text = frontmatterValue(value);

      return { key, value: text, multiline: text.includes("\n") };
    });
}

export function MarkdownDocumentView({
  source,
  path,
  mode,
  previewHref,
  codeHref,
  labels,
  editor,
}: {
  source: string;
  path: string;
  mode: MarkdownDocumentMode;
  previewHref: string;
  codeHref: string;
  labels: MarkdownDocumentViewLabels;
  editor?: ReactNode;
}): ReactElement {
  const split = splitFrontmatter(source);
  const entries = split.ok ? frontmatterEntries(split.frontmatter) : [];
  const previewSource = split.ok ? split.body : source;

  return (
    <div
      className="overflow-hidden rounded-[14px] border border-line bg-paper"
      data-testid="markdown-document-view"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-[11px] font-bold text-ink">
            {path}
          </div>
        </div>
        <div
          className="inline-flex rounded-[10px] border border-line bg-ivory p-0.5"
          data-testid="markdown-view-toggle"
        >
          <Link
            aria-current={mode === "preview" ? "page" : undefined}
            className={
              mode === "preview"
                ? "rounded-[8px] bg-paper px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ink shadow-sm"
                : "rounded-[8px] px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute hover:text-ink"
            }
            href={previewHref}
          >
            {labels.preview}
          </Link>
          <Link
            aria-current={mode === "code" ? "page" : undefined}
            className={
              mode === "code"
                ? "rounded-[8px] bg-paper px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ink shadow-sm"
                : "rounded-[8px] px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute hover:text-ink"
            }
            href={codeHref}
          >
            {labels.code}
          </Link>
        </div>
      </div>

      {mode === "code" ? (
        <div className="p-3" data-testid="markdown-document-code">
          {editor ?? (
            <pre className="overflow-auto rounded-lg border border-line bg-ivory p-3 font-mono text-[12px] leading-[1.55] text-ink">
              {source}
            </pre>
          )}
        </div>
      ) : (
        <div
          className="flex flex-col gap-3 p-3"
          data-testid="markdown-document-preview"
        >
          {!split.ok ? (
            <div className="rounded-[10px] border border-danger-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger">
              {labels.malformedFrontmatter}
            </div>
          ) : entries.length > 0 ? (
            <section className="rounded-[10px] border border-line bg-ivory px-3 py-2">
              <h3 className="m-0 mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-mute">
                {labels.frontmatter}
              </h3>
              <dl className="grid gap-px overflow-hidden rounded-[8px] border border-line bg-line">
                {entries.map((entry) => (
                  <div
                    key={entry.key}
                    className="grid gap-1 bg-paper px-3 py-2 sm:grid-cols-[170px_minmax(0,1fr)]"
                  >
                    <dt className="font-mono text-[10.5px] font-semibold text-mute">
                      {entry.key}
                    </dt>
                    <dd className="m-0 min-w-0 text-[12px] leading-[1.45] text-ink-2">
                      {entry.multiline ? (
                        <pre className="m-0 whitespace-pre-wrap font-mono text-[11px] leading-[1.45]">
                          {entry.value}
                        </pre>
                      ) : (
                        entry.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          <MarkdownRichView path={path} source={previewSource} />
        </div>
      )}
    </div>
  );
}
