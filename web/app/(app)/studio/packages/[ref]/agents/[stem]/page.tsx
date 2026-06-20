import type {
  AgentViewLabels,
  AgentViewModel,
} from "@/components/studio/agent-view";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import Link from "next/link";

import { AgentView } from "@/components/studio/agent-view";
import { requireSession } from "@/lib/authz";
import { parseAgentDefinition } from "@/lib/agents/definition";
import { readInstalledPackageFile } from "@/lib/flows/package-content";
import { getStudioPackageInstalledPath } from "@/lib/studio/package-path";
import { resolveStudioPackageByRef } from "@/lib/studio/load";

type PageProps = { params: Promise<{ ref: string; stem: string }> };

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { stem } = await params;

  return { title: decodeURIComponent(stem) };
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

export default async function StudioAgentDetailPage({
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

  // Confined read of the agent definition off the resolved installedPath.
  const read = await readInstalledPackageFile(
    { installedPath },
    `agents/${stem}.md`,
  );

  if (read.state !== "text" || !read.content) notFound();

  let agent: AgentViewModel;

  try {
    const def = parseAgentDefinition(stem, read.content);
    const cron = def.recommended?.cron;

    // CRITICAL: `def.runner` is intentionally dropped — the runner is resolved
    // per-project at launch, never shown as a package property.
    agent = {
      name: def.name,
      description: def.description,
      triggers: def.triggers.map((trigger) =>
        tViewer(`trigger${capitalize(trigger)}`),
      ),
      riskTier: tViewer(`risk${capitalize(def.riskTier)}`),
      workspace: tViewer(`workspace${capitalize(def.workspace)}`),
      workspaceRef: def.workspaceRef,
      mode: tViewer(`mode${capitalize(def.mode)}`),
      capabilityProfile: def.capabilityProfile,
      recommendedCron: cron ? `${cron.expr} (${cron.timezone})` : null,
      recommendedEvents: def.recommended?.events ?? null,
      prompt: def.prompt,
    };
  } catch {
    // A malformed/unparseable definition degrades to a notice, never a 500.
    return (
      <div className="mx-auto w-full max-w-[1120px]">
        <Link
          className="mb-4 inline-flex font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-ink"
          href={packageHref}
        >
          {tViewer("backToPackage")}
        </Link>
        <p
          className="rounded-lg border border-dashed border-amber-line bg-amber-soft px-4 py-6 text-center font-mono text-[12px] text-amber"
          data-testid="agent-unreadable"
        >
          {tViewer("agentUnreadable")}
        </p>
      </div>
    );
  }

  const labels: AgentViewLabels = {
    metadataTitle: tViewer("agentMetadataTitle"),
    promptTitle: tViewer("agentPromptTitle"),
    description: tViewer("agentDescription"),
    whenToCall: tViewer("agentWhenToCall"),
    riskTier: tViewer("agentRiskTier"),
    workspace: tViewer("agentWorkspace"),
    workspaceRef: tViewer("agentWorkspaceRef"),
    mode: tViewer("agentMode"),
    capabilityProfile: tViewer("agentCapabilityProfile"),
    recommendedCron: tViewer("agentRecommendedCron"),
    recommendedEvents: tViewer("agentRecommendedEvents"),
    none: tViewer("agentNone"),
  };

  return (
    <div className="mx-auto w-full max-w-[1120px]">
      <Link
        className="mb-4 inline-flex font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-ink"
        href={packageHref}
      >
        {tViewer("backToPackage")}
      </Link>

      <header className="mb-6">
        <div className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          {decodedRef} · {tViewer("agentDetailTitle")}
        </div>
        <h1 className="m-0 text-[26px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
          {agent.name}
        </h1>
      </header>

      <AgentView agent={agent} labels={labels} />
    </div>
  );
}
