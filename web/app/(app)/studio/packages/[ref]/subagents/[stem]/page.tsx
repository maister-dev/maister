import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import Link from "next/link";

import { CodeEditor } from "@/components/flows/code-editor";
import { MarkdownDocumentView } from "@/components/studio/markdown-document-view";
import { requireSession } from "@/lib/authz";
import { splitFrontmatter } from "@/lib/flows/artifact-frontmatter";
import {
  listInstalledPackageFiles,
  readInstalledPackageFile,
  resolveBundledAgentPath,
} from "@/lib/flows/package-content";
import { getStudioPackageInstalledPath } from "@/lib/studio/package-path";
import { resolveStudioPackageByRef } from "@/lib/studio/load";

type PageProps = {
  params: Promise<{ ref: string; stem: string }>;
  searchParams: Promise<{ view?: string | string[] }>;
};

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { stem } = await params;

  return { title: decodeURIComponent(stem) };
}

function lenientNameDescription(
  fm: Record<string, unknown> | undefined,
): { name?: string; description?: string } | null {
  if (!fm) return null;

  const name = typeof fm.name === "string" ? fm.name : undefined;
  const description =
    typeof fm.description === "string" ? fm.description : undefined;

  return name || description ? { name, description } : null;
}

function firstParam(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;

  return value && value.length > 0 ? value : null;
}

function markdownMode(raw: string | string[] | undefined): "preview" | "code" {
  return firstParam(raw) === "code" ? "code" : "preview";
}

// Capability subagent detail: a flow-internal Claude-subagent `.md` from
// `capability/**/agents/`, materialized into the run's `.claude/agents/` — NOT a
// MAIster platform agent. Rendered as a markdown preview/source view of the
// same definition you'd edit, never strict-parsed.
export default async function StudioSubagentDetailPage({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { ref, stem: rawStem } = await params;
  const { view: rawView } = await searchParams;
  const decodedRef = decodeURIComponent(ref);
  const stem = decodeURIComponent(rawStem);

  const user = await requireSession();
  const resolution = await resolveStudioPackageByRef(
    user.id,
    user.role,
    decodedRef,
  );

  if (resolution.status !== "ok") notFound();

  const installedPath = await getStudioPackageInstalledPath(
    resolution.installId,
  );

  if (!installedPath) notFound();

  const tViewer = await getTranslations("studio.viewer");
  const packageBaseHref = `/studio/packages/${encodeURIComponent(decodedRef)}`;
  const packageHref = `${packageBaseHref}?tab=subagents`;
  const detailHref = `${packageBaseHref}/subagents/${encodeURIComponent(stem)}`;

  // Subagents nest under `capability/**/agents/<stem>.md`; resolve the real path
  // from the listing, then confined-read the raw `.md`.
  const listing = await listInstalledPackageFiles({ installedPath });
  const agentPath = listing.bundleMissing
    ? null
    : resolveBundledAgentPath(listing.files, stem);
  const read = agentPath
    ? await readInstalledPackageFile({ installedPath }, agentPath)
    : null;

  if (!read || read.state !== "text" || !read.content) notFound();

  const content = read.content;
  const split = splitFrontmatter(content);
  const fm = split.ok ? lenientNameDescription(split.frontmatter) : null;
  const mode = markdownMode(rawView);

  return (
    <div className="mx-auto w-full max-w-[1120px]">
      <Link
        className="mb-4 inline-flex font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-ink"
        href={packageHref}
      >
        {tViewer("backToPackage")}
      </Link>

      <header className="mb-4">
        <div className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          {decodedRef} · {tViewer("subagentDetailTitle")}
        </div>
        <h1 className="m-0 text-[26px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
          {fm?.name ?? stem}
        </h1>
        {fm?.description ? (
          <p className="mt-1.5 max-w-[72ch] text-[13.5px] leading-[1.5] text-mute">
            {fm.description}
          </p>
        ) : null}
      </header>

      <p className="mb-6 inline-flex rounded-full border border-line bg-ivory px-2.5 py-1 font-mono text-[10.5px] text-mute">
        {tViewer("subagentMeta")}
      </p>

      <section data-testid="subagent-raw-definition">
        <h2 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-mute">
          {tViewer("agentDefinitionTitle")}
        </h2>
        <MarkdownDocumentView
          codeHref={`${detailHref}?view=code`}
          editor={
            <CodeEditor
              key={stem}
              readOnly
              ariaLabel={`${stem}.md`}
              kind="agent_definition"
              value={content}
            />
          }
          labels={{
            preview: tViewer("markdownPreview"),
            code: tViewer("markdownCode"),
            frontmatter: tViewer("markdownFrontmatter"),
            malformedFrontmatter: tViewer("markdownMalformedFrontmatter"),
          }}
          mode={mode}
          path={`${stem}.md`}
          previewHref={detailHref}
          source={content}
        />
      </section>
    </div>
  );
}
