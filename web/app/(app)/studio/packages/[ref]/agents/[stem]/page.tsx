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
import { splitFrontmatter } from "@/lib/flows/artifact-frontmatter";
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

// Lenient name/description from any .md frontmatter — for the non-platform-agent
// fallback view (Claude-subagent and other definitions the strict platform-agent
// schema rejects). Mirrors the skill detail's best-effort frontmatter header.
function lenientNameDescription(
  fm: Record<string, unknown> | undefined,
): { name?: string; description?: string } | null {
  if (!fm) return null;

  const name = typeof fm.name === "string" ? fm.name : undefined;
  const description =
    typeof fm.description === "string" ? fm.description : undefined;

  return name || description ? { name, description } : null;
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

  // Platform-agents live at the package root `maister-agents/<stem>.md`.
  const read = await readInstalledPackageFile(
    { installedPath },
    `maister-agents/${stem}.md`,
  );

  if (read.state !== "text" || !read.content) notFound();

  const content = read.content;

  let agent: AgentViewModel;

  try {
    const def = parseAgentDefinition(stem, content);
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
    // Not a MAIster platform agent (e.g. a Claude-subagent shipped by a flow
    // package): the strict schema rejects it. Render the raw .md — the same
    // definition you'd edit — instead of hard-failing, so viewing stays
    // consistent with editing.
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

        <header className="mb-6">
          <div className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
            {decodedRef} · {tViewer("agentDetailTitle")}
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

        <section data-testid="agent-raw-definition">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-mute">
              {tViewer("agentDefinitionTitle")}
            </h2>
            <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[9.5px] text-mute">
              {tViewer("agentNonPlatformNote")}
            </span>
          </div>
          <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-ivory p-4 font-mono text-[12px] leading-[1.6] text-ink">
            {content}
          </pre>
        </section>
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
