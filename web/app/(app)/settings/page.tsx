import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { getSessionUser } from "@/lib/authz";
import { AcpRunnersPanel } from "@/components/settings/acp-runners-panel";
import { AgentsPanel } from "@/components/settings/agents-panel";
import { AdapterSupportPanel } from "@/components/settings/adapter-support-panel";
import { McpServersPanel } from "@/components/settings/mcp-servers-panel";
import { RouterSidecarsPanel } from "@/components/settings/router-sidecars-panel";
import { WebhooksPanel } from "@/components/settings/webhooks-panel";
import { reconcilePlatformRunners } from "@/lib/acp-runners/native-defaults";
import { platformRunnerPresetRows } from "@/lib/acp-runners/presets";
import { getAdapterSupport } from "@/lib/acp-runners/schema";
import { getDb } from "@/lib/db/client";
import {
  agents,
  platformAcpRunners,
  platformMcpServers,
  platformRouterSidecars,
  platformRuntimeSettings,
  projects,
} from "@/lib/db/schema";
import {
  hostToolStatus,
  reposRoot,
  worktreesRoot,
} from "@/lib/instance-config";
import { checkSupervisorDiagnostics } from "@/lib/supervisor-client";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");

  return { title: t("title") };
}

export default async function SettingsPage(): Promise<ReactElement> {
  const t = await getTranslations("settings");
  const user = await getSessionUser();
  const isAdmin = user?.role === "admin";

  const tools = isAdmin ? await hostToolStatus() : [];
  const diagnostics = isAdmin ? await checkSupervisorDiagnostics() : null;
  const runtime = isAdmin ? await loadPlatformRuntimeView(diagnostics) : null;

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

      {isAdmin ? (
        <>
          <div className="grid gap-5 md:grid-cols-2">
            <div className="rounded-[16px] border border-line bg-paper p-7 shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset,0_12px_32px_-16px_rgba(0,0,0,0.12)]">
              <dl className="flex flex-col gap-5">
                <div className="flex flex-col gap-1.5">
                  <dt className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                    {t("repoHome")}
                  </dt>
                  <dd className="m-0 break-all font-mono text-[13px] leading-[1.5] text-ink">
                    {reposRoot()}
                  </dd>
                </div>

                <div className="flex flex-col gap-1.5">
                  <dt className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                    {t("worktreesRoot")}
                  </dt>
                  <dd className="m-0 break-all font-mono text-[13px] leading-[1.5] text-ink">
                    {worktreesRoot()}
                  </dd>
                </div>

                <div className="flex flex-col gap-1.5">
                  <dt className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                    {t("hostTools")}
                  </dt>
                  <dd className="m-0 flex flex-col gap-1">
                    {tools.map((tool) => (
                      <div
                        key={tool.name}
                        className="flex items-baseline justify-between gap-3 font-mono text-[13px] leading-[1.5]"
                      >
                        <span className="text-ink">{tool.name}</span>
                        <span className="text-mute">
                          {tool.available
                            ? `${tool.version} (${t("available")})`
                            : t("unavailable")}
                        </span>
                      </div>
                    ))}
                  </dd>
                </div>

                <p className="text-[11.5px] leading-[1.5] text-mute">
                  {t("envNote")}
                </p>
              </dl>
            </div>

            <div className="rounded-[16px] border border-line bg-paper p-7 shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset,0_12px_32px_-16px_rgba(0,0,0,0.12)]">
              {runtime ? (
                <AdapterSupportPanel
                  adapters={runtime.adapters}
                  diagnostics={diagnostics}
                  runners={runtime.runners}
                />
              ) : null}
            </div>
          </div>

          {runtime ? (
            <div className="mt-5 rounded-[16px] border border-line bg-paper p-7 shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset,0_12px_32px_-16px_rgba(0,0,0,0.12)]">
              <AcpRunnersPanel
                defaultRunnerId={runtime.defaultRunnerId}
                presets={runtime.presets}
                runners={runtime.runners}
                sidecars={runtime.sidecars}
              />
              <AgentsPanel
                agents={runtime.agents}
                projects={runtime.projects}
              />
              <RouterSidecarsPanel sidecars={runtime.sidecars} />
              <McpServersPanel servers={runtime.mcpServers} />
              <WebhooksPanel />
            </div>
          ) : null}
        </>
      ) : (
        <div className="rounded-[16px] border border-line bg-paper p-7 shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset,0_12px_32px_-16px_rgba(0,0,0,0.12)]">
          <p className="text-[13.5px] leading-[1.55] text-mute">
            {t("forbidden")}
          </p>
        </div>
      )}
    </div>
  );
}

async function loadPlatformRuntimeView(
  diagnostics: Awaited<ReturnType<typeof checkSupervisorDiagnostics>> | null,
) {
  const db = getDb() as any;

  // ADR-093: reconcile materializes native defaults + honest readiness from
  // live supervisor diagnostics before the catalog is read. Single writer of
  // readiness_status; an unavailable/null diagnostics is a no-op.
  await reconcilePlatformRunners({
    db,
    diagnostics: diagnostics?.kind === "ready" ? diagnostics.diagnostics : null,
  });

  const [runners, sidecars, settingsRows, mcpServers, agentRows, projectRows] =
    await Promise.all([
      db.select().from(platformAcpRunners),
      db.select().from(platformRouterSidecars),
      db.select().from(platformRuntimeSettings),
      db.select().from(platformMcpServers),
      db.select().from(agents),
      db.select().from(projects),
    ]);

  return {
    adapters: getAdapterSupport(),
    defaultRunnerId: settingsRows[0]?.defaultRunnerId ?? null,
    presets: platformRunnerPresetRows(),
    runners,
    sidecars,
    mcpServers,
    // M34: explicit DTO projection — serialized dates, no raw rows.
    agents: agentRows.map((row: any) => ({
      id: row.id,
      flowRefId: row.flowRefId,
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
