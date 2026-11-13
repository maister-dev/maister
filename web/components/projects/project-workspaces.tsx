import type { ReactElement } from "react";
import type { ProjectWorkspace } from "@/lib/queries/project";
import type { ActiveAgentExecution } from "@/lib/agents/activity-queries";

import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { ActiveAgentExecutions } from "@/components/agents/active-agent-executions";
import { WorkbenchLifecycleActions } from "@/components/workbench/lifecycle-actions";

const pageSize = 10;

type WorkspaceGroup = {
  id: string;
  title: string;
  workspaces: ProjectWorkspace[];
};

function groupWorkspaces(
  workspaces: readonly ProjectWorkspace[],
): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();

  for (const workspace of workspaces) {
    const task = workspace.task;
    const id = task
      ? `task:${task.id}`
      : workspace.agentId
        ? `agent:${workspace.agentId}`
        : `run:${workspace.runId}`;
    const existing = groups.get(id);

    if (existing) existing.workspaces.push(workspace);
    else
      groups.set(id, {
        id,
        title: task
          ? `${task.key}-${task.number} · ${task.title}`
          : workspace.displayName,
        workspaces: [workspace],
      });
  }

  return [...groups.values()];
}

export async function ProjectWorkspaces({
  slug,
  search,
  open,
  selectedGroup,
  groupLimit,
  attemptLimit,
  active,
  retained,
  canAct,
}: {
  slug: string;
  search: Record<string, string | string[] | undefined>;
  open: boolean;
  selectedGroup?: string;
  groupLimit: number;
  attemptLimit: number;
  active: readonly ActiveAgentExecution[];
  retained: readonly ProjectWorkspace[];
  canAct: boolean;
}): Promise<ReactElement> {
  const t = await getTranslations("board.workspaces");
  const status = await getTranslations("run.runStatus");
  const groups = open ? groupWorkspaces(retained) : [];
  const visibleGroups = groups.slice(0, groupLimit * pageSize);
  const selected = selectedGroup
    ? groups.find((group) => group.id === selectedGroup)
    : undefined;

  function href(patch: Record<string, string | null>): string {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(search)) {
      if (Array.isArray(value))
        value.forEach((entry) => params.append(key, entry));
      else if (value !== undefined) params.set(key, value);
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }

    return `/projects/${encodeURIComponent(slug)}${params.size ? `?${params}` : ""}`;
  }

  return (
    <div className="min-w-0">
      <Link
        aria-controls={open ? "project-workspaces" : undefined}
        aria-expanded={open}
        className="inline-flex rounded-md border border-line px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-ivory"
        href={href({
          workspaces: open ? null : "open",
          workspaceGroup: null,
          workspaceGroups: null,
          workspaceAttempts: null,
        })}
        scroll={false}
      >
        {t("title")}
      </Link>
      {open ? (
        <section
          aria-label={t("title")}
          className="mt-2 grid max-h-[min(52vh,420px)] gap-4 overflow-auto overscroll-contain rounded-xl border border-line bg-paper p-3"
          data-testid="project-workspaces"
          id="project-workspaces"
          // Allow keyboard users to scroll the capped workspaces region directly.
          // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex
          tabIndex={0}
        >
          <ActiveAgentExecutions
            items={active.slice(0, groupLimit * pageSize)}
          />
          {groups.length > 0 ? (
            <ul className="divide-y divide-line-soft">
              {(selected && !visibleGroups.includes(selected)
                ? [...visibleGroups, selected]
                : visibleGroups
              ).map((group) => (
                <li key={group.id} className="grid gap-2 py-2">
                  <Link
                    aria-expanded={group.id === selected?.id}
                    className="flex flex-wrap justify-between gap-2 text-sm font-semibold hover:underline"
                    href={href({
                      workspaceGroup:
                        group.id === selected?.id ? null : group.id,
                      workspaceAttempts: null,
                    })}
                    scroll={false}
                  >
                    <span className="min-w-0 break-words">{group.title}</span>
                    <span className="text-xs text-mute">
                      {t("copies", { count: group.workspaces.length })}
                    </span>
                  </Link>
                  {group.id === selected?.id ? (
                    <ul className="grid gap-2 border-l border-line pl-3">
                      {group.workspaces
                        .slice(0, attemptLimit * pageSize)
                        .map((workspace) => (
                          <li
                            key={workspace.runId}
                            className="flex flex-wrap items-center justify-between gap-2"
                          >
                            <div className="grid min-w-0 gap-1 text-xs">
                              <Link
                                className="break-words text-ink underline"
                                href={workspace.href}
                              >
                                {workspace.attemptNumber === null
                                  ? `${workspace.branch} · ${workspace.time}`
                                  : t("attempt", {
                                      count: workspace.attemptNumber,
                                    })}
                              </Link>
                              <span className="text-mute">
                                {status.has(workspace.runStatus)
                                  ? status(workspace.runStatus)
                                  : workspace.runStatus}
                                {" · "}
                                {t(
                                  workspace.archived
                                    ? "archived"
                                    : workspace.onDisk
                                      ? "onDisk"
                                      : "notOnDisk",
                                )}
                              </span>
                            </div>
                            {canAct && workspace.lifecycleActions.length ? (
                              <WorkbenchLifecycleActions
                                actions={workspace.lifecycleActions}
                                runId={workspace.runId}
                                runKind={workspace.runKind}
                                workspaceAvailable={workspace.onDisk}
                              />
                            ) : null}
                          </li>
                        ))}
                    </ul>
                  ) : null}
                  {group.id === selected?.id &&
                  group.workspaces.length > attemptLimit * pageSize ? (
                    <Link
                      className="text-xs underline"
                      href={href({
                        workspaceAttempts: String(attemptLimit + 1),
                      })}
                      scroll={false}
                    >
                      {t("moreAttempts")}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-mute">{t("empty")}</p>
          )}
          {Math.max(groups.length, active.length) > groupLimit * pageSize ? (
            <Link
              className="text-xs underline"
              href={href({ workspaceGroups: String(groupLimit + 1) })}
              scroll={false}
            >
              {t("moreGroups")}
            </Link>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
