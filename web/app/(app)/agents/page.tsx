import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { AgentsPanel } from "@/components/settings/agents-panel";
import { getSessionUser } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { agents, projects } from "@/lib/db/schema";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("agents");

  return { title: t("title") };
}

export default async function AgentsPage(): Promise<ReactElement> {
  const t = await getTranslations("agents");
  const user = await getSessionUser();
  const isAdmin = user?.role === "admin";
  const view = isAdmin ? await loadAgentsView() : null;

  return (
    <div className="w-full">
      <header className="mb-7">
        <div className="mb-2.5 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
          {t("title")}
        </div>
        <h1 className="m-0 text-[28px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
          {t("title")}
        </h1>
        <p className="mt-1.5 max-w-[56ch] text-[13.5px] leading-[1.5] text-mute">
          {t("sub")}
        </p>
      </header>

      <div className="rounded-[16px] border border-line bg-paper p-7 shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset,0_12px_32px_-16px_rgba(0,0,0,0.12)]">
        {isAdmin && view ? (
          <AgentsPanel agents={view.agents} projects={view.projects} />
        ) : (
          <p className="text-[13.5px] leading-[1.55] text-mute">
            {t("forbidden")}
          </p>
        )}
      </div>
    </div>
  );
}

async function loadAgentsView() {
  const db = getDb() as any;
  const [agentRows, projectRows] = await Promise.all([
    db.select().from(agents),
    db.select().from(projects),
  ]);

  return {
    // M34: explicit DTO projection — serialized dates, no raw rows.
    agents: agentRows.map((row: any) => ({
      id: row.id,
      packageName: row.packageName,
      versionLabel: row.versionLabel,
      origin: row.origin,
      name: row.name,
      description: row.description,
      runnerId: row.runnerId ?? null,
      workspace: row.workspace,
      mode: row.mode,
      triggers: row.triggers,
      riskTier: row.riskTier,
      sourcePath: row.sourcePath,
      enabled: row.enabled,
      quarantinedAt: row.quarantinedAt
        ? new Date(row.quarantinedAt).toISOString()
        : null,
      quarantineReason: row.quarantineReason ?? null,
    })),
    projects: projectRows
      .filter((row: any) => !row.archivedAt)
      .map((row: any) => ({ id: row.id, slug: row.slug, name: row.name })),
  };
}
