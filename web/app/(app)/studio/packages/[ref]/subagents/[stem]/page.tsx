import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import Link from "next/link";

import { requireSession } from "@/lib/authz";
import { splitFrontmatter } from "@/lib/flows/artifact-frontmatter";
import {
  listInstalledPackageFiles,
  readInstalledPackageFile,
  resolveBundledAgentPath,
} from "@/lib/flows/package-content";
import { getStudioPackageInstalledPath } from "@/lib/studio/package-path";
import { resolveStudioPackageByRef } from "@/lib/studio/load";

type PageProps = { params: Promise<{ ref: string; stem: string }> };

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

// Capability subagent detail: a flow-internal Claude-subagent `.md` from
// `capability/**/agents/`, materialized into the run's `.claude/agents/` — NOT a
// MAIster platform agent. Rendered as its raw `.md` (the same definition you'd
// edit), never strict-parsed.
export default async function StudioSubagentDetailPage({
  params,
}: PageProps): Promise<ReactElement> {
  const { ref, stem: rawStem } = await params;
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
  const packageHref = `/studio/packages/${encodeURIComponent(decodedRef)}`;

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
        <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-ivory p-4 font-mono text-[12px] leading-[1.6] text-ink">
          {content}
        </pre>
      </section>
    </div>
  );
}
