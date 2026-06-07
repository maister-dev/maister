import type { ProjectTab } from "@/components/board/project-tabs";
import type { PortfolioWorkspace } from "@/lib/queries/portfolio";
import type { ReactElement } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { Board } from "@/components/board/board";
import { BoardTools } from "@/components/board/board-tools";
import { HitlInbox } from "@/components/board/hitl-inbox";
import { NewTaskModal } from "@/components/board/new-task-modal";
import { ProjectTabs } from "@/components/board/project-tabs";
import { ActivityPanel } from "@/components/board/panels/activity-panel";
import { DeferredPanel } from "@/components/board/panels/deferred-panel";
import { FlowPackagesPanel } from "@/components/board/panels/flow-packages-panel";
import { FlowsPanel } from "@/components/board/panels/flows-panel";
import { IntegrationsPanel } from "@/components/board/panels/integrations-panel";
import { RepoFilesPanel } from "@/components/board/panels/repo-files-panel";
import { SettingsPanel } from "@/components/board/panels/settings-panel";
import { ProjectMembersPanel } from "@/components/project/project-members-panel";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { getActivityFeed } from "@/lib/queries/activity";
import { getBoardData } from "@/lib/queries/board";
import { getFlowPackages } from "@/lib/queries/flow-packages";
import { getHitlInbox } from "@/lib/queries/hitl";
import { getProjectBySlug, getProjectPageData } from "@/lib/queries/project";
import { listProjectMembers } from "@/lib/project-members";
import { getPlatformStatus } from "@/lib/supervisor-client";
import { listTokens } from "@/lib/tokens/list";

const VALID_TABS: readonly ProjectTab[] = [
  "board",
  "activity",
  "prs",
  "flows",
  "repo",
  "packages",
  "integrations",
  "mcps",
  "members",
  "settings",
];

function parseTab(raw: string | string[] | undefined): ProjectTab {
  const value = Array.isArray(raw) ? raw[0] : raw;

  return (VALID_TABS as readonly string[]).includes(value ?? "")
    ? (value as ProjectTab)
    : "board";
}

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}

export default async function ProjectBoardPage({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { slug } = await params;
  const { tab: rawTab } = await searchParams;
  const tab = parseTab(rawTab);

  const user = await getSessionUser();

  if (!user) notFound();

  const project = await getProjectBySlug(slug);

  if (!project || project.archivedAt) notFound();

  const role =
    user.role === "admin" ? "owner" : await getProjectRole(user.id, project.id);

  if (role === null) notFound();

  const canAct = role === "owner" || role === "admin" || role === "member";
  const isAdmin = role === "owner" || role === "admin";
  const canReadRepoFiles =
    role === "owner" || role === "admin" || role === "member";

  const t = await getTranslations("board");
  const tNewTask = await getTranslations("newtask");
  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("nav");
  const tPortfolio = await getTranslations("portfolio");
  const tScratch = await getTranslations("scratch");
  const tWorkbench = await getTranslations("workbench");

  const filesLabels = {
    title: tWorkbench("files.title"),
    empty: tWorkbench("files.empty"),
    tooLarge: tWorkbench("files.tooLarge"),
    binary: tWorkbench("files.binary"),
    loadError: tWorkbench("files.loadError"),
    loading: tWorkbench("files.loading"),
    forbidden: tWorkbench("files.forbidden"),
    treeLabel: tWorkbench("files.treeLabel"),
  };

  const [pageData, board, hitl, platformStatus] = await Promise.all([
    getProjectPageData(project),
    getBoardData(project.id),
    getHitlInbox(project.id),
    getPlatformStatus(),
  ]);

  return (
    <>
      <header className="mb-6 grid grid-cols-1 items-start gap-6 border-b border-line pb-[22px] lg:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <div className="mb-3 inline-flex items-center gap-2.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
            <span>{tNav("crumbProjects")}</span>
            <span className="opacity-50">/</span>
            <b className="text-[12.5px] font-bold normal-case tracking-normal text-ink-2">
              {project.name}
            </b>
          </div>
          <div className="mb-1.5 flex flex-wrap items-baseline gap-3.5">
            <h1 className="m-0 text-[36px] font-semibold leading-[1.05] tracking-[-0.024em] text-ink">
              {project.name}
            </h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-line bg-amber-soft py-1 pl-[9px] pr-2.5 font-mono text-[11px] font-semibold tracking-[0.04em] text-amber">
              <span className="h-1.5 w-1.5 rounded-full bg-amber animate-[pulse-dot_2.2s_ease-out_infinite]" />
              {board.inProd > 0 ? "running" : "idle"}
            </span>
          </div>
          <p className="mt-2 max-w-[56ch] text-sm leading-[1.5] text-body">
            {project.repoPath}
          </p>
        </div>

        <div className="flex flex-col items-end gap-3.5">
          <div className="flex items-center overflow-hidden rounded-[10px] border border-line bg-paper">
            <Count label={t("needYou")} tone="needs" value={hitl.count} />
            <Count label={t("inProd")} tone="flight" value={board.inProd} />
            <Count label={t("backlogCount")} value={board.backlog} />
            <Count label={t("mergedDays")} value={board.merged7d} />
          </div>
          {canAct ? (
            <div className="flex gap-2">
              <Link
                className="inline-flex items-center rounded-md border border-line bg-ink px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-paper transition-colors hover:bg-ink-2"
                href={`/scratch-runs/new?projectId=${project.id}`}
              >
                {tScratch("launch")}
              </Link>
              <NewTaskModal
                flows={pageData.flows}
                labels={{
                  trigger: t("newTask"),
                  title: tNewTask("title"),
                  titleLabel: tNewTask("titleLabel"),
                  titlePlaceholder: tNewTask("titlePlaceholder"),
                  promptLabel: tNewTask("promptLabel"),
                  promptPlaceholder: tNewTask("promptPlaceholder"),
                  flowLabel: tNewTask("flowLabel"),
                  create: tNewTask("create"),
                  cancel: tCommon("cancel"),
                }}
                slug={slug}
              />
            </div>
          ) : null}
        </div>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-4">
        <MetaCell
          dot="bg-amber"
          label={t("defaultAgent")}
          sub={
            pageData.defaultRunnerLabel
              ? `${pageData.defaultRunnerLabel} · ${
                  pageData.defaultRunnerSource ?? "inherited"
                }`
              : undefined
          }
          value={pageData.defaultAgent ?? "—"}
        />
        <MetaCell
          dot="bg-accent-2"
          label={t("flowsConfigured")}
          sub={pageData.flows.map((f) => f.ref).join(" · ") || undefined}
          value={String(pageData.flows.length)}
        />
        <MetaCell dot="bg-accent-3" label={t("mcps")} value="—" />
        <MetaCell
          dot="bg-accent-4"
          label={t("team")}
          value={`${pageData.members.length}`}
        />
      </div>

      <ProjectActiveWorkspaces
        activeLabel={tPortfolio("activeCount", {
          count: pageData.activeWorkspaces.length,
        })}
        activeWorkspaces={pageData.activeWorkspaces}
        noneLabel={tPortfolio("noneActive")}
        title={tPortfolio("workspaces")}
        workspaceActionLabel={(action) =>
          tPortfolio(`workspaceAction.${action}`)
        }
      />

      <ProjectTabs active={tab} boardCount={board.totalTasks} slug={slug} />

      {tab === "board" ? (
        <section>
          <HitlInbox canAct={canAct} currentUserId={user.id} inbox={hitl} />
          <BoardTools
            labels={{
              filterFlow: t("filterFlow"),
              filterAgent: t("filterAgent"),
              filterPrio: t("filterPrio"),
              filterTouched: t("filterTouched"),
              filterAny: t("filterAny"),
              touchedValue: "7d",
              layout: t("layout"),
              layoutBoard: t("layoutBoard"),
              layoutSwimlanes: t("layoutSwimlanes"),
              layoutList: t("layoutList"),
              asOf: t("asOf"),
              justNow: t("justNow"),
            }}
          >
            <Board
              canAct={canAct}
              data={board}
              platformStatus={platformStatus}
              projectId={project.id}
            />
          </BoardTools>
        </section>
      ) : null}

      {tab === "activity" ? (
        <ActivityPanel events={await getActivityFeed(project.id)} />
      ) : null}

      {tab === "prs" ? <DeferredPanel kind="prs" /> : null}
      {tab === "mcps" ? <DeferredPanel kind="mcps" /> : null}
      {tab === "flows" ? <FlowsPanel flows={pageData.flows} /> : null}
      {tab === "repo" ? (
        <RepoFilesPanel
          canReadRepoFiles={canReadRepoFiles}
          labels={filesLabels}
          slug={slug}
        />
      ) : null}
      {tab === "packages" ? (
        <FlowPackagesPanel
          isAdmin={isAdmin}
          packages={await getFlowPackages(project.id)}
          slug={slug}
        />
      ) : null}
      {tab === "integrations" ? (
        <IntegrationsPanel
          isAdmin={isAdmin}
          slug={slug}
          tokens={isAdmin ? await listTokens(project.id) : []}
        />
      ) : null}
      {tab === "members" ? (
        <ProjectMembersPanel
          canManage={isAdmin}
          members={(await listProjectMembers(project.id)).map((m) => ({
            ...m,
            createdAt: m.createdAt.toISOString(),
          }))}
          selfUserId={user.id}
          slug={slug}
        />
      ) : null}
      {tab === "settings" ? (
        <SettingsPanel data={pageData} isAdmin={isAdmin} />
      ) : null}
    </>
  );
}

function ProjectActiveWorkspaces({
  activeWorkspaces,
  title,
  activeLabel,
  noneLabel,
  workspaceActionLabel,
}: {
  activeWorkspaces: PortfolioWorkspace[];
  title: string;
  activeLabel: string;
  noneLabel: string;
  workspaceActionLabel: (
    action: Exclude<PortfolioWorkspace["scratchAction"], undefined>,
  ) => string;
}): ReactElement {
  return (
    <section className="mb-6 border-y border-line py-3">
      <header className="mb-2 flex items-center justify-between font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-mute">
        <span>{title}</span>
        <span className="text-ink-2">
          {activeWorkspaces.length > 0 ? activeLabel : noneLabel}
        </span>
      </header>
      {activeWorkspaces.length > 0 ? (
        <ul className="m-0 grid list-none grid-cols-1 gap-px overflow-hidden rounded-lg border border-line-soft bg-line-soft p-0 md:grid-cols-2 xl:grid-cols-3">
          {activeWorkspaces.map((workspace) => (
            <li key={workspace.runId} className="bg-paper">
              <Link
                className="grid grid-cols-[10px_1fr_auto_auto] items-center gap-2 px-3 py-2.5 font-mono text-[11px] transition-colors hover:bg-ivory"
                href={workspace.href}
              >
                <span
                  className={`h-[7px] w-[7px] rounded-full ${workspaceDot(workspace.status)}`}
                />
                <span className="truncate font-semibold tracking-[-0.005em] text-ink">
                  {workspace.branch}
                </span>
                {workspace.runKind === "scratch" &&
                workspace.scratchAction &&
                workspace.scratchAction !== "none" ? (
                  <span className="rounded-[3px] border border-amber-line bg-amber-soft px-1.5 py-px text-[9.5px] tracking-[0.02em] text-amber">
                    {workspaceActionLabel(workspace.scratchAction)}
                  </span>
                ) : null}
                <span className="text-[10px] tracking-[0.04em] text-mute-2">
                  {workspace.time}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function workspaceDot(status: PortfolioWorkspace["status"]): string {
  if (status === "needs") return "bg-amber";
  if (status === "queued") return "bg-mute";
  if (status === "done") return "bg-accent-3";

  return "bg-accent-4";
}

function Count({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: "needs" | "flight";
}): ReactElement {
  const numTone =
    tone === "needs"
      ? "text-amber"
      : tone === "flight"
        ? "text-accent-4"
        : "text-ink";
  const lblTone =
    tone === "needs"
      ? "text-amber"
      : tone === "flight"
        ? "text-accent-4"
        : "text-mute";

  return (
    <div className="flex flex-col gap-0.5 border-r border-line px-4 py-2.5 text-center font-mono last:border-r-0">
      <span
        className={`text-[18px] font-bold leading-none tracking-[-0.01em] ${numTone}`}
      >
        {value}
      </span>
      <span
        className={`mt-[3px] text-[9px] font-semibold uppercase tracking-[0.12em] ${lblTone}`}
      >
        {label}
      </span>
    </div>
  );
}

function MetaCell({
  label,
  value,
  sub,
  dot,
}: {
  label: string;
  value: string;
  sub?: string;
  dot: string;
}): ReactElement {
  return (
    <div className="flex cursor-pointer flex-col gap-1 bg-paper px-4 py-3 transition-colors hover:bg-ivory">
      <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-mute">
        <span className={`h-[5px] w-[5px] rounded-full ${dot}`} />
        {label}
      </span>
      <span className="flex items-center gap-2 font-mono text-[12.5px] font-semibold tracking-[-0.005em] text-ink">
        {value}
        {sub ? (
          <span className="truncate text-[11px] font-normal text-mute">
            · {sub}
          </span>
        ) : null}
      </span>
    </div>
  );
}
