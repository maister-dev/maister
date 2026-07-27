import type { ProjectTab } from "@/components/board/project-tabs";
import type { AgentConfigParam } from "@/lib/agents/definition";
import type { PortfolioWorkspace } from "@/lib/queries/portfolio";
import type { ReactElement } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { Board } from "@/components/board/board";
import { BoardTools } from "@/components/board/board-tools";
import { ProjectBrainPanel } from "@/components/brain/project-brain-panel";
import { HitlInboxGrid } from "@/components/inbox/hitl-inbox-list";
import { NewTaskModal } from "@/components/board/new-task-modal";
import { ProjectTabs } from "@/components/board/project-tabs";
import { ActivityPanel } from "@/components/board/panels/activity-panel";
import { ProjectPackageContents } from "@/components/board/panels/project-package-contents";
import { ProjectLocalPackages } from "@/components/board/panels/project-local-packages";
import { ProjectPackagesSection } from "@/components/board/panels/project-packages-section";
import { IntegrationsPanel } from "@/components/board/panels/integrations-panel";
import { McpPanel } from "@/components/board/panels/mcp-panel";
import { RepoFilesPanel } from "@/components/board/panels/repo-files-panel";
import { SettingsPanel } from "@/components/board/panels/settings-panel";
import { WebhooksPanel } from "@/components/board/panels/webhooks-panel";
import { ProjectMembersPanel } from "@/components/project/project-members-panel";
import { ConfigPersistBanner } from "@/components/projects/config-persist-banner";
import {
  AgentsAttachPanel,
  type AgentRecommendedView,
} from "@/components/board/panels/agents-attach-panel";
import { SchedulesPanel } from "@/components/schedules/schedules-panel";
import { AutomationsPanel } from "@/components/automations/automations-panel";
import { WorkbenchLifecycleActions } from "@/components/workbench/lifecycle-actions";
import {
  getProjectRole,
  getSessionUser,
  requireProjectAction,
} from "@/lib/authz";
import { isBrainSchemaApplied } from "@/lib/brain/guard";
import { isProjectBrainIndexingAvailable } from "@/lib/brain/availability";
import {
  loadProjectBrainPanelData,
  type BrainUiDb,
} from "@/lib/brain/ui-queries";
import { getDb } from "@/lib/db/client";
import { getActivityFeed } from "@/lib/queries/activity";
import { getBoardData } from "@/lib/queries/board";
import { getProjectPackageContents } from "@/lib/queries/project-package-contents";
import {
  getAvailablePackageInstalls,
  getProjectPackageAttachments,
} from "@/lib/queries/packages";
import { getProjectLocalPackages } from "@/lib/queries/project-local-packages";
import { getHitlInbox } from "@/lib/queries/hitl";
import { getUnreadInboxCount } from "@/lib/queries/inbox";
import {
  ACTIVITY_LOG_PAGE_SIZE,
  getProjectActivityLog,
} from "@/lib/queries/activity";
import { TaskActivityLog } from "@/components/board/panels/task-activity-log";
import { getProjectAgentsView } from "@/lib/agents/project-links";
import { DOMAIN_EVENT_KINDS } from "@/lib/domain-events/taxonomy";
import { reposRoot } from "@/lib/instance-config";
import { formatProjectRepoPath } from "@/lib/project-path-display";
import { getProjectBySlug, getProjectPageData } from "@/lib/queries/project";
import { getProjectMcpHub } from "@/lib/mcp/hub-service";
import {
  listBindings,
  listPlatformBindCandidates,
} from "@/lib/mcp/binding-service";
import { listProjectMcps } from "@/lib/mcp/project-mcp-service";
import { listProjectMembers } from "@/lib/project-members";
import { listProjectSchedules } from "@/lib/run-schedules/queries";
import { listProjectAutomations } from "@/lib/scheduled-launches/queries";
import { listTaskDTOs } from "@/lib/services/tasks";
import { getPlatformStatus } from "@/lib/supervisor-client";
import { listTokenAudit, TOKEN_AUDIT_PAGE_SIZE } from "@/lib/tokens/audit-list";
import { listTokens } from "@/lib/tokens/list";
import { listBranches } from "@/lib/worktree";

const VALID_TABS: readonly ProjectTab[] = [
  "board",
  "activity",
  "brain",
  "repo",
  "packages",
  "integrations",
  "mcps",
  "automations",
  "agents",
  "members",
  "webhooks",
  "settings",
];

function parseTab(raw: string | string[] | undefined): ProjectTab {
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (value === "schedules") return "automations";

  return (VALID_TABS as readonly string[]).includes(value ?? "")
    ? (value as ProjectTab)
    : "board";
}

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    tab?: string | string[];
    file?: string | string[];
    ref?: string | string[];
    actor_type?: string | string[];
    event_kind?: string | string[];
    task?: string | string[];
    page?: string | string[];
    audit_token?: string | string[];
    audit_result?: string | string[];
    audit_page?: string | string[];
    brain_query?: string | string[];
  }>;
}

function parseFile(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;

  return value && value.length > 0 ? value : null;
}

export default async function ProjectBoardPage({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { slug } = await params;
  const {
    tab: rawTab,
    file: rawFile,
    ref: rawRef,
    actor_type: rawActorType,
    event_kind: rawEventKind,
    task: rawTaskFilter,
    page: rawPage,
    audit_token: rawAuditToken,
    audit_result: rawAuditResult,
    audit_page: rawAuditPage,
    brain_query: rawBrainQuery,
  } = await searchParams;
  const requestedTab = parseTab(rawTab);
  const one = (v: string | string[] | undefined): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const logFilters = {
    actorType: one(rawActorType) as "user" | "agent" | "system" | undefined,
    eventKind: one(rawEventKind),
    task: one(rawTaskFilter),
    page: Number.parseInt(one(rawPage) ?? "1", 10) || 1,
  };
  const auditResult = one(rawAuditResult);
  const auditFilters = {
    tokenId: one(rawAuditToken),
    result: (auditResult === "ok" || auditResult === "error"
      ? auditResult
      : undefined) as "ok" | "error" | undefined,
    page: Number.parseInt(one(rawAuditPage) ?? "1", 10) || 1,
  };
  const brainQuery = one(rawBrainQuery) ?? "";
  const file = parseFile(rawFile);

  const user = await getSessionUser();

  if (!user) notFound();

  const project = await getProjectBySlug(slug);

  if (!project || project.archivedAt) notFound();

  const role =
    user.role === "admin" ? "owner" : await getProjectRole(user.id, project.id);

  if (role === null) notFound();

  const brainIndexingAvailable = await isProjectBrainIndexingAvailable(project);
  const tab =
    requestedTab === "brain" && !brainIndexingAvailable
      ? "board"
      : requestedTab;

  const canAct = role === "owner" || role === "admin" || role === "member";
  const isAdmin = role === "owner" || role === "admin";
  // ADR-129 (W-D): the project MCP hub — feeds the header metacell count and the
  // board tab's requirements ledger.
  const mcpHub = await getProjectMcpHub(project.id);
  // Package trust fans out to every attached project — global admin only.
  const canTrustPackages = user.role === "admin";
  const canReadRepoFiles =
    role === "owner" || role === "admin" || role === "member";

  const t = await getTranslations("board");
  const tNewTask = await getTranslations("newtask");
  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("nav");
  const tPortfolio = await getTranslations("portfolio");
  const tScratch = await getTranslations("scratch");
  const tWorkbench = await getTranslations("workbench");
  const tLog = await getTranslations("projectLog");
  const tBrain = await getTranslations("brain");
  const tAutomations = await getTranslations("automations");
  const displayRepoPath = formatProjectRepoPath(project.repoPath, reposRoot());

  const filesLabels = {
    title: tWorkbench("files.title"),
    empty: tWorkbench("files.empty"),
    tooLarge: tWorkbench("files.tooLarge"),
    binary: tWorkbench("files.binary"),
    notFound: tWorkbench("files.notFound"),
    loadError: tWorkbench("files.loadError"),
    forbidden: tWorkbench("files.forbidden"),
    treeLabel: tWorkbench("files.treeLabel"),
    selectPrompt: tWorkbench("files.selectPrompt"),
    branchLabel: tWorkbench("files.branchLabel"),
    fetchOrigin: tWorkbench("files.fetchOrigin"),
    fetching: tWorkbench("files.fetching"),
    fetchFailed: tWorkbench("files.fetchFailed"),
  };

  const [pageData, board, hitl, platformStatus, unreadInbox] =
    await Promise.all([
      getProjectPageData(project),
      getBoardData(project.id),
      getHitlInbox(project.id),
      getPlatformStatus(),
      getUnreadInboxCount(user.id, user.role, project.id),
    ]);
  const activityLog =
    tab === "activity"
      ? await getProjectActivityLog(project.id, logFilters)
      : null;
  const integrationsTokens =
    tab === "integrations" && isAdmin ? await listTokens(project.id) : [];
  const tokenAudit =
    tab === "integrations" && isAdmin
      ? await listTokenAudit(project.id, auditFilters)
      : null;
  // ADR-129 (W-D, T6.2): the board MCP tab's write surfaces (bindings, connect
  // candidates, project-local rows). Loaded only for an admin on the mcps tab;
  // the requirements ledger + effective count come from the always-loaded hub.
  const mcpPanelData =
    tab === "mcps" && isAdmin
      ? {
          bindings: await listBindings(project.id),
          platformCandidates: await listPlatformBindCandidates(),
          projectServers: await listProjectMcps(project.id),
        }
      : { bindings: [], platformCandidates: [], projectServers: [] };
  // Branch picker for the repo tab; a broken repo_path falls back to the
  // default branch rather than crashing the page. currentRef is constrained to
  // a real branch (or the default), and always present in branchOptions so the
  // <select> has a matching value.
  const repoBranches =
    tab === "repo"
      ? await listBranches(project.repoPath, { includeRemotes: true }).catch(
          () => [project.mainBranch],
        )
      : [];
  const requestedRef = one(rawRef);
  const currentRef =
    requestedRef && repoBranches.includes(requestedRef)
      ? requestedRef
      : project.mainBranch;
  const branchOptions = repoBranches.includes(currentRef)
    ? repoBranches
    : [currentRef, ...repoBranches];
  const brainPanelData =
    tab === "brain"
      ? await (async () => {
          const db = getDb() as unknown as BrainUiDb;

          if (!(await isBrainSchemaApplied(db))) {
            return {
              indexStatus: {
                activeJobs: [],
                completed: 0,
                failed: 0,
                failedSourceCount: 0,
                enabledSourceCount: 0,
                indexedChunkCount: 0,
                indexedFileCount: 0,
                latestSourceIndexedAt: null,
                queued: 0,
                running: 0,
                sourceCount: 0,
              },
              memory: [],
              proposals: [],
              sources: [],
            };
          }

          await requireProjectAction(project.id, "readBrain");

          return loadProjectBrainPanelData(db, project.id, brainQuery);
        })()
      : {
          indexStatus: {
            activeJobs: [],
            completed: 0,
            failed: 0,
            failedSourceCount: 0,
            enabledSourceCount: 0,
            indexedChunkCount: 0,
            indexedFileCount: 0,
            latestSourceIndexedAt: null,
            queued: 0,
            running: 0,
            sourceCount: 0,
          },
          memory: [],
          proposals: [],
          sources: [],
        };
  const automationsPage =
    tab === "automations"
      ? await listProjectAutomations({
          projectId: project.id,
          projectSlug: slug,
          limit: 50,
        })
      : null;

  return (
    <>
      <ConfigPersistBanner
        canEdit={isAdmin}
        mainBranch={project.mainBranch}
        needsPersist={project.maisterYamlPath === null}
        projectName={project.name}
        repoPath={displayRepoPath}
        settingsHref={`/projects/${slug}?tab=settings`}
        slug={slug}
      />
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
            {displayRepoPath}
          </p>
        </div>

        <div className="flex flex-col items-end gap-3.5">
          <div className="flex items-center overflow-hidden rounded-[10px] border border-line bg-paper">
            <Count
              label={t("needYou")}
              tone="needs"
              value={hitl.count + unreadInbox}
            />
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
                  flowNone: tNewTask("flowNone"),
                  noEnabledFlow: tNewTask("noEnabledFlow"),
                  managePackages: tNewTask("managePackages"),
                  create: tNewTask("create"),
                  cancel: tCommon("cancel"),
                }}
                packagesHref={`/projects/${slug}?tab=packages`}
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
        <MetaCell
          dot="bg-accent-3"
          label={t("mcps")}
          value={String(mcpHub.effectiveCount)}
        />
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

      <ProjectTabs
        active={tab}
        boardCount={board.totalTasks}
        showBrain={brainIndexingAvailable}
        slug={slug}
      />

      {tab === "board" ? (
        <section>
          {hitl.count > 0 ? (
            <section aria-label="Human-in-the-loop inbox" className="mb-7">
              <h2 className="mb-3.5 inline-flex items-center gap-2.5 font-sans text-sm font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-amber before:content-['']">
                {t("hitlInbox")}
                <span className="rounded-full border border-amber-line bg-paper px-2.5 py-[3px] font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-amber">
                  {t("paused", { count: hitl.count })}
                </span>
              </h2>
              <HitlInboxGrid
                canAct={canAct}
                currentUserId={user.id}
                items={hitl.items}
              />
            </section>
          ) : null}
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
              slug={slug}
            />
          </BoardTools>
        </section>
      ) : null}

      {tab === "activity" ? (
        <>
          <ActivityPanel events={await getActivityFeed(project.id)} />
          {activityLog ? (
            <TaskActivityLog
              filters={logFilters}
              labels={{
                title: tLog("title"),
                empty: tLog("empty"),
                colWhen: tLog("colWhen"),
                colTask: tLog("colTask"),
                colEvent: tLog("colEvent"),
                colActor: tLog("colActor"),
                colDetails: tLog("colDetails"),
                filterActor: tLog("filterActor"),
                filterEvent: tLog("filterEvent"),
                filterTask: tLog("filterTask"),
                filterAny: tLog("filterAny"),
                apply: tLog("apply"),
                pagePrev: tLog("pagePrev"),
                pageNext: tLog("pageNext"),
                pageLabel: tLog("pageLabel"),
                paginationLabel: tLog("paginationLabel"),
                formerUser: tLog("formerUser"),
                system: tLog("system"),
                eventKind: {
                  task_created: tLog("kind.taskCreated"),
                  comment_added: tLog("kind.commentAdded"),
                  task_mentioned: tLog("kind.taskMentioned"),
                  relation_added: tLog("kind.relationAdded"),
                  relation_removed: tLog("kind.relationRemoved"),
                  run_launched: tLog("kind.runLaunched"),
                  experiment_concluded: tLog("kind.experimentConcluded"),
                  agent_summon_suppressed: tLog("kind.agentSummonSuppressed"),
                },
              }}
              page={activityLog.page}
              pageSize={ACTIVITY_LOG_PAGE_SIZE}
              rows={activityLog.rows}
              slug={slug}
              total={activityLog.total}
            />
          ) : null}
        </>
      ) : null}

      {tab === "brain" ? (
        <ProjectBrainPanel
          canManageSources={isAdmin}
          indexStatus={brainPanelData.indexStatus}
          labels={{
            title: tBrain("title"),
            memoryTitle: tBrain("memoryTitle"),
            searchPlaceholder: tBrain("searchPlaceholder"),
            searchAction: tBrain("searchAction"),
            emptyMemory: tBrain("emptyMemory"),
            memorySearchRequired: tBrain("memorySearchRequired"),
            tierOwned: tBrain("tierOwned"),
            tierIndexed: tBrain("tierIndexed"),
            confidence: tBrain("confidence"),
            indexStatusTitle: tBrain("indexStatusTitle"),
            indexLatestSourceIndex: tBrain("indexLatestSourceIndex"),
            indexIndexedFiles: tBrain("indexIndexedFiles"),
            indexIndexedChunks: tBrain("indexIndexedChunks"),
            indexSources: tBrain("indexSources"),
            indexSourcesHint: tBrain("indexSourcesHint"),
            indexFailedSources: tBrain("indexFailedSources"),
            indexQueue: tBrain("indexQueue"),
            indexQueueHint: tBrain("indexQueueHint"),
            indexLastCompleted: tBrain("indexLastCompleted"),
            indexQueued: tBrain("indexQueued"),
            indexRunning: tBrain("indexRunning"),
            indexFailed: tBrain("indexFailed"),
            indexCompleted: tBrain("indexCompleted"),
            indexConfigureProfile: tBrain("indexConfigureProfile"),
            indexActiveJobs: tBrain("indexActiveJobs"),
            indexNoActiveJobs: tBrain("indexNoActiveJobs"),
            indexOwnedGeneration: tBrain("indexOwnedGeneration"),
            indexProgress: tBrain("indexProgress"),
            indexJobStatus: {
              queued: tBrain("indexJobStatus.queued"),
              running: tBrain("indexJobStatus.running"),
              completed: tBrain("indexJobStatus.completed"),
              failed: tBrain("indexJobStatus.failed"),
            },
            indexJobReason: {
              model_switch: tBrain("indexJobReason.model_switch"),
              manual: tBrain("indexJobReason.manual"),
              event: tBrain("indexJobReason.event"),
              chunker_upgrade: tBrain("indexJobReason.chunker_upgrade"),
            },
            sourcesTitle: tBrain("sourcesTitle"),
            sourcePath: tBrain("sourcePath"),
            sourceKind: tBrain("sourceKind"),
            sourceChunker: tBrain("sourceChunker"),
            sourceStatus: tBrain("sourceStatus"),
            sourceLastIndexed: tBrain("sourceLastIndexed"),
            sourceError: tBrain("sourceError"),
            sourceIndexedFiles: tBrain("sourceIndexedFiles"),
            sourceChunks: tBrain("sourceChunks"),
            sourceEnabled: tBrain("sourceEnabled"),
            sourceDisabled: tBrain("sourceDisabled"),
            sourceNeverIndexed: tBrain("sourceNeverIndexed"),
            reindex: tBrain("reindex"),
            reindexAll: tBrain("reindexAll"),
            proposalsTitle: tBrain("proposalsTitle"),
            pendingBadge: tBrain("pendingBadge"),
            proposalEvidence: tBrain("proposalEvidence"),
            proposalDraft: tBrain("proposalDraft"),
            accept: tBrain("accept"),
            reject: tBrain("reject"),
            rejectReason: tBrain("rejectReason"),
            emptyProposals: tBrain("emptyProposals"),
          }}
          memory={brainPanelData.memory}
          proposalCapabilities={{
            canAcceptCatalog: isAdmin,
            canAcceptProjection: canAct,
            canReject: canAct,
          }}
          proposals={brainPanelData.proposals}
          query={brainQuery}
          slug={slug}
          sources={brainPanelData.sources}
        />
      ) : null}
      {tab === "mcps" ? (
        <McpPanel
          bindings={mcpPanelData.bindings}
          isAdmin={isAdmin}
          platformCandidates={mcpPanelData.platformCandidates}
          projectServers={mcpPanelData.projectServers}
          requirements={mcpHub.requirements}
          servers={isAdmin ? mcpHub.servers : []}
          slug={slug}
        />
      ) : null}
      {tab === "repo" ? (
        <RepoFilesPanel
          branches={branchOptions}
          canFetch={isAdmin}
          canReadRepoFiles={canReadRepoFiles}
          currentRef={currentRef}
          file={file}
          labels={filesLabels}
          mainBranch={project.mainBranch}
          projectId={project.id}
          repoPath={project.repoPath}
          slug={slug}
        />
      ) : null}
      {tab === "packages" ? (
        <>
          <ProjectPackagesSection
            attachments={await getProjectPackageAttachments(project.id, {
              includeAffectedProjectCount: canTrustPackages,
            })}
            availableInstalls={await getAvailablePackageInstalls()}
            canTrust={canTrustPackages}
            isAdmin={isAdmin}
            slug={slug}
          />
          <ProjectLocalPackages
            localPackages={await getProjectLocalPackages(project.id)}
          />
          <ProjectPackageContents
            contents={await getProjectPackageContents(project.id)}
            slug={slug}
          />
        </>
      ) : null}
      {tab === "integrations" ? (
        <IntegrationsPanel
          audit={
            tokenAudit
              ? {
                  ...tokenAudit,
                  pageSize: TOKEN_AUDIT_PAGE_SIZE,
                  filters: {
                    tokenId: auditFilters.tokenId,
                    result: auditFilters.result,
                  },
                  tokenOptions: integrationsTokens.map((tok) => ({
                    id: tok.id,
                    name: tok.name,
                  })),
                }
              : null
          }
          isAdmin={isAdmin}
          slug={slug}
          tokens={integrationsTokens}
        />
      ) : null}
      {tab === "automations" ? (
        <AutomationsPanel
          canManage={canAct}
          initialNextCursor={automationsPage?.nextCursor ?? null}
          initialRows={automationsPage?.rows ?? []}
          labels={{
            all: tAutomations("all"),
            agent: tAutomations("agent"),
            attention: tAutomations("attention"),
            cancel: tAutomations("cancel"),
            cancelConfirm: tAutomations("cancelConfirm"),
            cancelEdit: tAutomations("cancelEdit"),
            disambiguation: tAutomations("disambiguation"),
            edit: tAutomations("edit"),
            earlier: tAutomations("earlier"),
            empty: tAutomations("empty"),
            error: tAutomations("error"),
            errorLabels: {
              PRECONDITION: tAutomations("errors.PRECONDITION"),
              CONFIG: tAutomations("errors.CONFIG"),
              CONFLICT: tAutomations("errors.CONFLICT"),
              EXECUTOR_UNAVAILABLE: tAutomations("errors.EXECUTOR_UNAVAILABLE"),
              SPAWN: tAutomations("errors.SPAWN"),
              CRASH: tAutomations("errors.CRASH"),
            },
            manageAgent: tAutomations("manageAgent"),
            later: tAutomations("later"),
            lateByOne: tAutomations("lateByOne"),
            lateByOther: tAutomations("lateByOther"),
            loadMore: tAutomations("loadMore"),
            loadingMore: tAutomations("loadingMore"),
            oneTime: tAutomations("oneTime"),
            outcomeLabels: {
              created: tAutomations("outcomes.created"),
              rearmed: tAutomations("outcomes.rearmed"),
              claimed: tAutomations("outcomes.claimed"),
              retry_scheduled: tAutomations("outcomes.retry_scheduled"),
              cancelled: tAutomations("outcomes.cancelled"),
              launched: tAutomations("outcomes.launched"),
              failed: tAutomations("outcomes.failed"),
              queued: tAutomations("outcomes.queued"),
              refused: tAutomations("outcomes.refused"),
              deduplicated: tAutomations("outcomes.deduplicated"),
              suppressed: tAutomations("outcomes.suppressed"),
              dispatching: tAutomations("outcomes.dispatching"),
              queued_pending: tAutomations("outcomes.queued_pending"),
              catchup_queued: tAutomations("outcomes.catchup_queued"),
              skipped_task_busy: tAutomations("outcomes.skipped_task_busy"),
              skipped_cap: tAutomations("outcomes.skipped_cap"),
              skipped_target_terminal: tAutomations(
                "outcomes.skipped_target_terminal",
              ),
              skipped_crashed: tAutomations("outcomes.skipped_crashed"),
              skipped_flagged: tAutomations("outcomes.skipped_flagged"),
              skipped_blocked: tAutomations("outcomes.skipped_blocked"),
              skipped_unconfigured: tAutomations(
                "outcomes.skipped_unconfigured",
              ),
              launch_failed: tAutomations("outcomes.launch_failed"),
              incompatible_disabled: tAutomations(
                "outcomes.incompatible_disabled",
              ),
            },
            recurring: tAutomations("recurring"),
            runNow: tAutomations("runNow"),
            save: tAutomations("save"),
            saving: tAutomations("saving"),
            scheduledLocalTime: tAutomations("scheduledLocalTime"),
            stateLabels: {
              Scheduled: tAutomations("states.Scheduled"),
              Dispatching: tAutomations("states.Dispatching"),
              RetryWaiting: tAutomations("states.RetryWaiting"),
              Launched: tAutomations("states.Launched"),
              Failed: tAutomations("states.Failed"),
              Cancelled: tAutomations("states.Cancelled"),
              Enabled: tAutomations("states.Enabled"),
              Disabled: tAutomations("states.Disabled"),
            },
            timezone: tAutomations("timezone"),
            title: tAutomations("title"),
            viewRun: tAutomations("viewRun"),
          }}
          slug={slug}
        >
          <SchedulesPanel
            canManage={canAct}
            schedules={await listProjectSchedules(project.id)}
            slug={slug}
            tasks={(await listTaskDTOs(project.id)).map((task) => ({
              id: task.id,
              title: task.title,
              status: task.status,
            }))}
          />
        </AutomationsPanel>
      ) : null}
      {tab === "agents" ? (
        <AgentsAttachPanelLoader
          canManage={isAdmin}
          mcpRequirements={mcpHub.requirements}
          projectId={project.id}
          runners={pageData.runners
            .filter((runner) => runner.enabled)
            .map((runner) => ({ id: runner.id, label: runner.label }))}
          slug={slug}
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
      {tab === "webhooks" ? (
        <WebhooksPanel canWrite={canAct} slug={slug} />
      ) : null}
      {tab === "settings" ? (
        <SettingsPanel data={pageData} isAdmin={isAdmin} />
      ) : null}
    </>
  );
}

// Project the stored `recommended` jsonb (faithful to the .md frontmatter, snake
// `branch_base`) to the panel's camelCase view shape — mirrors
// admin-shared.ts `projectRecommended` (the GET-route DTO path).
function toRecommendedView(rec: unknown): AgentRecommendedView | null {
  if (!rec || typeof rec !== "object") return null;
  const r = rec as {
    runner?: string;
    branch_base?: string;
    cron?: { expr: string; timezone: string };
    events?: string[];
    mention?: boolean;
    executionPolicy?: {
      autoApply?: "off" | "permissions" | "full";
      onBudgetBreach?: "escalate" | "terminate" | "terminate_restorable";
    };
  };

  return {
    ...(r.runner !== undefined ? { runner: r.runner } : {}),
    ...(r.branch_base !== undefined ? { branchBase: r.branch_base } : {}),
    ...(r.cron !== undefined ? { cron: r.cron } : {}),
    ...(r.events !== undefined ? { events: r.events } : {}),
    ...(r.mention !== undefined ? { mention: r.mention } : {}),
    ...(r.executionPolicy !== undefined
      ? { executionPolicy: r.executionPolicy }
      : {}),
  };
}

async function AgentsAttachPanelLoader({
  slug,
  projectId,
  canManage,
  runners,
  mcpRequirements,
}: {
  slug: string;
  projectId: string;
  canManage: boolean;
  runners: Array<{ id: string; label: string }>;
  mcpRequirements: Array<{
    refId: string;
    declaredBy: string[];
    classification: string;
  }>;
}): Promise<ReactElement> {
  const view = await getProjectAgentsView(projectId);
  // ADR-129 (W-G, T7.2): an agent's effective MCPs = the refs it declares,
  // resolved through the project's bindings. The hub already threads bindings
  // into `requirements` and stamps `declaredBy: ["agent:<id>", …]`, so filtering
  // by that label yields each agent's effective set (D5 — one resolution path).
  const effectiveMcpsFor = (
    agentId: string,
  ): Array<{ refId: string; classification: string }> =>
    mcpRequirements
      .filter((r) => r.declaredBy.includes(`agent:${agentId}`))
      .map((r) => ({ refId: r.refId, classification: r.classification }));

  return (
    <AgentsAttachPanel
      attached={view.attached.map((row) => ({
        linkId: row.linkId,
        enabled: row.enabled,
        runnerOverrideId: row.runnerOverrideId,
        branchBase: row.branchBase,
        executionPolicyOverride: row.executionPolicyOverride,
        config: row.config,
        canReadBrain: row.canReadBrain,
        canWriteBrain: row.canWriteBrain,
        memoryEnabled: row.memoryEnabled,
        schedulesRevision: row.schedulesRevision,
        schedules: row.schedules,
        agent: {
          id: row.agent.id as string,
          name: row.agent.name as string,
          packageName: row.agent.packageName as string,
          workspace: row.agent.workspace as string,
          mode: row.agent.mode as string,
          triggers: row.agent.triggers as string[],
          riskTier: row.agent.riskTier as string,
          enabled: row.agent.enabled as boolean,
          quarantinedAt: row.agent.quarantinedAt
            ? new Date(row.agent.quarantinedAt as Date).toISOString()
            : null,
          flowRef: (row.agent.flowRef as string | null) ?? null,
          recommended: toRecommendedView(row.agent.recommended),
          configSchema:
            (row.agent.configSchema as AgentConfigParam[] | null) ?? null,
          effectiveMcps: effectiveMcpsFor(row.agent.id as string),
        },
      }))}
      available={view.available.map((agent) => ({
        id: agent.id as string,
        name: agent.name as string,
        packageName: agent.packageName as string,
        recommended: toRecommendedView(agent.recommended),
        configSchema: (agent.configSchema as AgentConfigParam[] | null) ?? null,
      }))}
      canManage={canManage}
      eventKinds={[...DOMAIN_EVENT_KINDS]}
      runners={runners}
      slug={slug}
    />
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
                {workspace.runKind === "agent" ? (
                  <span className="rounded-[3px] border border-line bg-ivory px-1.5 py-px text-[9.5px] tracking-[0.02em] text-mute">
                    agent
                    {workspace.triggerSource
                      ? ` · ${workspace.triggerSource}`
                      : ""}
                  </span>
                ) : null}
                <span className="text-[10px] tracking-[0.04em] text-mute-2">
                  {workspace.time}
                </span>
              </Link>
              {workspace.lifecycleActions.length > 0 ? (
                <WorkbenchLifecycleActions
                  workspaceAvailable
                  actions={workspace.lifecycleActions}
                  className="px-3 pb-2.5"
                  runId={workspace.runId}
                  runKind={workspace.runKind}
                />
              ) : null}
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
