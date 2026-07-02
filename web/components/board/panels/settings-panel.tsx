import type { ProjectPageData } from "@/lib/queries/project";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import clsx from "clsx";

import { DeliveryPolicySettingsControl } from "@/components/board/panels/delivery-policy-settings-control";
import { FlowRunnerReconfigurationControl } from "@/components/board/panels/flow-runner-reconfiguration-control";
import {
  ProjectGitSettingsControl,
  type RemoteItem,
} from "@/components/board/panels/project-git-settings-control";
import { ProjectBrainSettingsControl } from "@/components/board/panels/project-brain-settings-control";
import { ProjectRunnerSettingsControl } from "@/components/board/panels/project-runner-settings-control";
import { QueueSettingsControl } from "@/components/board/panels/queue-settings-control";
import { getBrainSettings, isBrainFullyConfigured } from "@/lib/brain/settings";
import { getDb } from "@/lib/db/client";
import { listProjectRemotes, reconcileOriginRepoUrl } from "@/lib/git-remotes";
import { resolveEdgeDrain } from "@/lib/tasks/queue-settings";

export interface SettingsPanelProps {
  data: ProjectPageData;
  isAdmin: boolean;
}

export async function SettingsPanel({
  data,
  isAdmin,
}: SettingsPanelProps): Promise<ReactElement> {
  const t = await getTranslations("nav");
  const tCommon = await getTranslations("common");
  const tBoard = await getTranslations("board");

  const {
    project,
    defaultAgent,
    defaultRunnerLabel,
    defaultRunnerSource,
    defaultRunnerId,
    effectiveDefaultRunnerId,
    flowRunnerRemaps,
    flows,
    runners,
  } = data;
  const defaultFlow = flows[0];

  // ADR-093 Workstream 6: the Git section is admin-only (the route's
  // editSettings is the real boundary). Remotes are read live from git for SSR;
  // origin's repo_url/provider cache is healed best-effort on this read
  // (invariant B). A non-git repo / git error degrades to an empty table.
  let gitRemotes: RemoteItem[] = [];
  // ADR-122: the project Brain toggle is enable-gated on the platform embedding
  // provider + distillation model being configured (else the PATCH returns
  // CONFIG). Read here so the control can hint when enabling would refuse.
  let brainPlatformConfigured = false;

  if (isAdmin) {
    try {
      const db = getDb();

      await reconcileOriginRepoUrl({
        db,
        project: {
          id: project.id,
          repoPath: project.repoPath,
          repoUrl: project.repoUrl ?? null,
        },
      });
      gitRemotes = await listProjectRemotes(project.repoPath);
    } catch {
      gitRemotes = [];
    }

    try {
      brainPlatformConfigured = isBrainFullyConfigured(
        await getBrainSettings(),
      );
    } catch {
      brainPlatformConfigured = false;
    }
  }

  const rows: { k: string; d: string; v: string }[] = [
    ...(isAdmin
      ? []
      : [
          {
            k: tBoard("defaultAgent"),
            d: tBoard("defaultAgentDesc"),
            v: defaultRunnerLabel
              ? `${defaultAgent ?? "—"} · ${defaultRunnerLabel} · ${
                  defaultRunnerSource ?? "inherited"
                }`
              : "inherited",
          },
        ]),
    {
      k: tBoard("defaultFlow"),
      d: tBoard("defaultFlowDesc"),
      v: defaultFlow?.ref ?? "—",
    },
    {
      k: tBoard("concurrency"),
      d: tBoard("concurrencyDesc"),
      v: process.env.MAISTER_MAX_CONCURRENT_RUNS ?? "6",
    },
    {
      k: tBoard("branchPrefix"),
      d: tBoard("branchPrefixDesc"),
      v: project.branchPrefix,
    },
  ];

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {t("settings")}
        </h2>
        <span className="font-mono text-[10.5px] tracking-[0.02em] text-mute">
          {project.slug}
        </span>
      </div>
      {isAdmin ? (
        <DeliveryPolicySettingsControl
          defaultPolicy={project.deliveryPolicyDefault ?? null}
          projectMainBranch={project.mainBranch}
          projectSlug={project.slug}
        />
      ) : null}
      {isAdmin ? (
        <ProjectRunnerSettingsControl
          defaultRunnerId={defaultRunnerId}
          defaultRunnerSource={defaultRunnerSource}
          effectiveDefaultRunnerId={effectiveDefaultRunnerId}
          projectSlug={project.slug}
          runners={runners}
        />
      ) : null}
      {isAdmin ? (
        <FlowRunnerReconfigurationControl
          projectSlug={project.slug}
          remaps={flowRunnerRemaps}
          runners={runners}
        />
      ) : null}
      {isAdmin ? (
        <QueueSettingsControl
          envEdgeDrainDefault={resolveEdgeDrain({ taskQueueSettings: null })}
          projectSlug={project.slug}
          taskQueueSettings={project.taskQueueSettings ?? null}
        />
      ) : null}
      {isAdmin ? (
        <ProjectGitSettingsControl
          mainBranch={project.mainBranch}
          needsPersist={project.maisterYamlPath === null}
          projectSlug={project.slug}
          remotes={gitRemotes}
        />
      ) : null}
      {isAdmin ? (
        <ProjectBrainSettingsControl
          brainEnabled={project.brainEnabled ?? false}
          platformConfigured={brainPlatformConfigured}
          projectSlug={project.slug}
        />
      ) : null}
      <div className="flex flex-col gap-px overflow-hidden rounded-xl border border-line bg-line">
        {rows.map((row) => (
          <div
            key={row.k}
            className="flex items-center justify-between gap-4 bg-paper px-[18px] py-[15px]"
          >
            <div>
              <div className="text-[13px] font-semibold tracking-[-0.005em] text-ink">
                {row.k}
              </div>
              <div className="mt-[3px] font-mono text-[10.5px] tracking-[0.02em] text-mute">
                {row.d}
              </div>
            </div>
            <div className="inline-flex items-center gap-2 font-mono text-[11.5px] font-semibold text-ink-2">
              {row.v}
              {isAdmin ? (
                <span
                  aria-disabled
                  className={clsx(
                    "cursor-not-allowed font-mono text-[10px] font-bold tracking-[0.04em] text-amber opacity-50",
                  )}
                  // FIXME: no settings-write API in POC — control is inert.
                  title="admin"
                >
                  {tCommon("change")}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
