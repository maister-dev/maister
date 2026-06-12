import type { ReactElement } from "react";
import type { PackageInstallManifest } from "@/lib/packages/attach";

import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { packageInstalls, projectPackageAttachments, projects } =
  schemaModule as unknown as Record<string, any>;

// (ADR-087) Whole-package viewer: manifest metadata, member flows (linking
// to the per-flow viewer), inventory, MCP templates, restriction sets, trust
// state. Pure DB read — `installed_path` never reaches the client.
export default async function PackageInstallViewerPage(props: {
  params: Promise<{ slug: string; attachmentId: string }>;
}): Promise<ReactElement> {
  const { slug, attachmentId } = await props.params;
  const t = await getTranslations("packages");
  const db = getDb() as any;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug));

  if (!project || project.archivedAt) notFound();
  await requireProjectAction(project.id, "readRepoFiles");

  const [attachment] = await db
    .select()
    .from(projectPackageAttachments)
    .where(
      and(
        eq(projectPackageAttachments.id, attachmentId),
        eq(projectPackageAttachments.projectId, project.id),
      ),
    );

  if (!attachment) notFound();

  const [install] = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, attachment.packageInstallId));

  if (!install) notFound();

  const manifest = install.manifest as PackageInstallManifest;
  const meta = manifest.spec.metadata;

  return (
    <div className="w-full">
      <header className="mb-7">
        <div className="mb-2.5 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
          {t("viewerKicker")}
        </div>
        <h1 className="m-0 text-[28px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
          {meta?.title ?? install.name}
        </h1>
        <p className="mt-1.5 max-w-[64ch] text-[13.5px] leading-[1.5] text-mute">
          {meta?.summary ?? ""}
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 font-mono text-[12px] md:grid-cols-4">
          <div>
            <dt className="text-[10px] uppercase tracking-[0.1em] text-mute">
              {t("versionLabel")}
            </dt>
            <dd className="m-0 text-ink">{install.versionLabel}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.1em] text-mute">
              {t("revisionLabel")}
            </dt>
            <dd className="m-0 text-ink">
              {install.resolvedRevision.slice(0, 12)}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.1em] text-mute">
              {t("sourceLabel")}
            </dt>
            <dd className="m-0 break-all text-ink">{install.sourceUrl}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.1em] text-mute">
              {t("attColTrust")}
            </dt>
            <dd className="m-0 text-ink">{install.trustStatus}</dd>
          </div>
        </dl>
      </header>

      <div className="grid gap-5 md:grid-cols-2">
        <section className="rounded-[16px] border border-line bg-paper p-6">
          <h2 className="m-0 mb-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {t("attColFlows")}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {manifest.spec.flows.map((flow) => (
              <li key={flow.id}>
                <Link
                  className="font-mono text-[13px] text-ink underline-offset-2 hover:underline"
                  href={`/projects/${slug}/packages/${flow.id}`}
                >
                  {flow.id}
                </Link>
                <span className="ml-2 font-mono text-[11px] text-mute">
                  {flow.path}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-[16px] border border-line bg-paper p-6">
          <h2 className="m-0 mb-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {t("viewerInventory")}
          </h2>
          <div className="flex flex-col gap-3 text-[12.5px] text-ink">
            <div>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-mute">
                {t("viewerSkills")} ({manifest.inventory.skills.length})
              </span>
              <p className="m-0 mt-1 break-words font-mono text-[11.5px] leading-[1.6]">
                {manifest.inventory.skills.join(", ") || "—"}
              </p>
            </div>
            <div>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-mute">
                {t("viewerAgents")} ({manifest.inventory.agents.length})
              </span>
              <p className="m-0 mt-1 break-words font-mono text-[11.5px] leading-[1.6]">
                {manifest.inventory.agents.join(", ") || "—"}
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-[16px] border border-line bg-paper p-6">
          <h2 className="m-0 mb-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {t("viewerMcps")}
          </h2>
          {manifest.spec.mcps.length === 0 ? (
            <p className="m-0 text-[12px] text-mute">{t("viewerNone")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0 font-mono text-[12px] text-ink">
              {manifest.spec.mcps.map((mcp) => (
                <li key={mcp.id}>
                  {mcp.id} · {mcp.transport}
                  {mcp.url ? ` · ${mcp.url}` : ""}
                  {mcp.command ? ` · ${mcp.command}` : ""}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-[16px] border border-line bg-paper p-6">
          <h2 className="m-0 mb-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {t("viewerRestrictions")}
          </h2>
          {manifest.spec.restrictions.length === 0 ? (
            <p className="m-0 text-[12px] text-mute">{t("viewerNone")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0 font-mono text-[12px] text-ink">
              {manifest.spec.restrictions.map((restriction) => (
                <li key={restriction.id}>
                  {restriction.id}: {restriction.paths.join(", ")}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
