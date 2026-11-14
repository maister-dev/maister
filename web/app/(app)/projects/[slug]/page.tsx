import type { ProjectTab } from "@/components/board/project-tabs";
import type { ReactElement } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { IncomingRequests } from "@/components/agents/incoming-requests";
import { ProjectWorkspaces } from "@/components/projects/project-workspaces";
import { ProjectAgentsPanel as AgentsAttachPanelLoader } from "@/components/agents/project-agents-panel";
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
import { SchedulesPanel } from "@/components/schedules/schedules-panel";
import { AutomationsPanel } from "@/components/automations/automations-panel";
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
import { getDecisionsCount } from "@/lib/queries/decisions";
import { getHitlInbox } from "@/lib/queries/hitl";
import {
  ACTIVITY_LOG_PAGE_SIZE,
  getProjectActivityLog,
} from "@/lib/queries/activity";
import { TaskActivityLog } from "@/components/board/panels/task-activity-log";
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
import { getPlatformStatus } from "@/lib/execution-host";
import { listTokenAudit, TOKEN_AUDIT_PAGE_SIZE } from "@/lib/tokens/audit-list";
import { listTokens } from "@/lib/tokens/list";
import { listBranches } from "@/lib/worktree";

const VALID_TABS: readonly ProjectTab[] = [
  "board",
  "incoming",
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
    incoming_state?: string;
    audit_token?: string | string[];
    audit_result?: string | string[];
    audit_page?: string | string[];
    brain_query?: string | string[];
    workspaces?: string | string[];
    workspaceGroup?: string | string[];
    workspaceGroups?: string | string[];
    workspaceAttempts?: string | string[];
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
  const search = await searchParams;
  const {
    tab: rawTab,
    file: rawFile,
    ref: rawRef,
    actor_type: rawActorType,
    event_kind: rawEventKind,
    task: rawTaskFilter,
    page: rawPage,
    incoming_state: rawIncomingState,
    audit_token: rawAuditToken,
    audit_result: rawAuditResult,
    audit_page: rawAuditPage,
    brain_query: rawBrainQuery,
  } = search;
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

  const [pageData, board, hitl, platformStatus, projectDecisions] =
    await Promise.all([
      getProjectPageData(project),
      getBoardData(project.id),
      getHitlInbox(project.id),
      getPlatformStatus(),
      // ADR-169 D8: the project-scoped slice of the SAME canonical queue, not a
      // second local sum that is free to disagree with the rail badge.
      getDecisionsCount(user.id, user.role, { projectId: project.id }),
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
      <header
        className="mb-3 flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3"
        data-testid="project-board-header"
      >
        <div className="min-w-0">
          <h1 className="m-0 break-words text-2xl font-semibold text-ink">
            {project.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Count
              label={t("workspaces.executing")}
              tone="flight"
              value={pageData.executingCount}
            />
            <Count
              label={t("workspaces.decisions")}
              tone="needs"
              value={projectDecisions}
            />
            <Count
              label={t("workspaces.retained")}
              value={pageData.activeWorkspaces.length}
            />
          </div>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-mute">
              {t("workspaces.projectDetails")}
            </summary>
            <dl className="mt-1 grid gap-1 text-mute">
              {canReadRepoFiles ? (
                <div>
                  <dt className="sr-only">{t("workspaces.repository")}</dt>
                  <dd className="break-all">{displayRepoPath}</dd>
                </div>
              ) : null}
              <div>
                <dt className="inline">{t("defaultAgent")} · </dt>
                <dd className="inline">
                  {pageData.defaultRunnerLabel ?? pageData.defaultAgent ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="inline">{t("flowsConfigured")} · </dt>
                <dd className="inline">
                  {pageData.flows.map((flow) => flow.ref).join(" · ") || "—"}
                </dd>
              </div>
              <div>
                <dt className="inline">{t("mcps")} · </dt>
                <dd className="inline">{mcpHub.effectiveCount}</dd>
              </div>
              <div>
                <dt className="inline">{t("team")} · </dt>
                <dd className="inline">{pageData.members.length}</dd>
              </div>
            </dl>
          </details>
        </div>

        <div className="flex flex-col items-start gap-2 sm:items-end">
          {canAct ? (
            <div className="flex gap-2">
              <Link
                className="inline-flex items-center rounded-md border border-line bg-paper px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink transition-colors hover:bg-ivory"
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

      <div className="mb-3">
        {tab !== "settings" && isAdmin ? (
          <div className="mb-2">
            <ConfigPersistBanner
              key={slug}
              actorUserId={user.id}
              exportRevision={project.configExportRevision.toString()}
              slug={slug}
            />
          </div>
        ) : null}
        <ProjectWorkspaces
          active={pageData.activeExecutions}
          attemptLimit={workspacePageLimit(one(search.workspaceAttempts))}
          canAct={canAct}
          groupLimit={workspacePageLimit(one(search.workspaceGroups))}
          open={one(search.workspaces) === "open"}
          retained={pageData.activeWorkspaces}
          search={search}
          selectedGroup={one(search.workspaceGroup)}
          slug={slug}
        />
      </div>

      <ProjectTabs
        active={tab}
        boardCount={board.totalTasks}
        showBrain={brainIndexingAvailable}
        slug={slug}
      />

      {tab === "incoming" ? (
        <IncomingRequests
          page={Math.min(
            1000,
            Math.max(1, Number.parseInt(String(rawPage ?? "1"), 10) || 1),
          )}
          projectId={project.id}
          slug={slug}
          state={
            [
              "unassessed",
              "needs_information",
              "needs_review",
              "not_actionable",
            ].includes(rawIncomingState ?? "")
              ? (rawIncomingState as import("@/lib/queries/incoming").IncomingFilter)
              : undefined
          }
          taskKey={project.taskKey}
        />
      ) : null}
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
                canReadRepoFiles={canReadRepoFiles}
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
                // RAW: `NumberedPagination` interpolates `{page}` itself.
                pageLabel: tLog.raw("pageLabel"),
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
                  task_completed: tLog("kind.taskCompleted"),
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
          canReadRepoFiles={canReadRepoFiles}
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
        <SettingsPanel
          actorUserId={user.id}
          data={pageData}
          isAdmin={isAdmin}
        />
      ) : null}
    </>
  );
}

// Project the stored `recommended` jsonb (faithful to the .md frontmatter, snake
// `branch_base`) to the panel's camelCase view shape — mirrors
// admin-shared.ts `projectRecommended` (the GET-route DTO path).
function workspacePageLimit(value: string | undefined): number {
  const count = Number(value);

  return Number.isSafeInteger(count) && count > 0 ? Math.min(count, 100) : 1;
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
    <div className="flex items-baseline gap-1 rounded-md border border-line px-2 py-1 font-mono">
      <span
        className={`text-sm font-bold leading-none tracking-[-0.01em] ${numTone}`}
      >
        {value}
      </span>
      <span className={`text-[10px] font-semibold ${lblTone}`}>{label}</span>
    </div>
  );
}
