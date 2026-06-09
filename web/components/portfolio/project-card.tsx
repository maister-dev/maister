import type { PortfolioProject } from "@/lib/queries/portfolio";
import type { CSSProperties, ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";
import clsx from "clsx";

import { READINESS_BADGE } from "@/components/readiness-badge";
import { WorkbenchLifecycleActions } from "@/components/workbench/lifecycle-actions";

export interface ProjectCardProps {
  project: PortfolioProject;
}

const ACCENT_VARS: Record<1 | 2 | 3 | 4, CSSProperties> = {
  1: {
    "--p-accent": "var(--amber)",
    "--p-soft": "var(--amber-soft)",
    "--p-line": "var(--amber-line)",
  } as CSSProperties,
  2: {
    "--p-accent": "var(--accent-2)",
    "--p-soft": "var(--accent-2-soft)",
    "--p-line": "color-mix(in oklab, var(--accent-2) 35%, var(--line))",
  } as CSSProperties,
  3: {
    "--p-accent": "var(--accent-3)",
    "--p-soft": "var(--accent-3-soft)",
    "--p-line": "color-mix(in oklab, var(--accent-3) 35%, var(--line))",
  } as CSSProperties,
  4: {
    "--p-accent": "var(--accent-4)",
    "--p-soft": "var(--accent-4-soft)",
    "--p-line": "color-mix(in oklab, var(--accent-4) 35%, var(--line))",
  } as CSSProperties,
};

const agentIcoColor: Record<string, string> = {
  claude: "bg-amber",
  codex: "bg-accent-3",
  dev: "bg-accent-4",
};

const wsDotByStatus: Record<string, string> = {
  running: "bg-accent-4 animate-[pulse-dot_2.2s_ease-out_infinite]",
  needs: "bg-amber",
  queued: "bg-mute-2",
  done: "bg-accent-4 opacity-[0.55]",
};

const wsAgentChip: Record<string, string> = {
  claude: "text-amber bg-amber-soft border-amber-line",
  codex:
    "text-accent-3 bg-accent-3-soft border-[color-mix(in_oklab,var(--accent-3)_30%,var(--line))]",
  dev: "text-accent-4 bg-accent-4-soft border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))]",
};

export async function ProjectCard({
  project,
}: ProjectCardProps): Promise<ReactElement> {
  const t = await getTranslations("portfolio");
  const tReadiness = await getTranslations("readiness");

  const accentStyle = ACCENT_VARS[project.accent];
  const visibleMembers = project.members.slice(0, 5);

  return (
    <article
      className="group relative flex flex-col overflow-hidden rounded-[14px] border border-line bg-paper px-5 pb-4 pt-5 transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 hover:border-[color-mix(in_oklab,var(--p-accent)_40%,var(--line))] hover:shadow-[0_24px_48px_-28px_rgba(22,20,15,0.18),0_8px_20px_-16px_rgba(22,20,15,0.10)]"
      data-accent={project.accent}
      style={accentStyle}
    >
      <span className="absolute inset-y-4 left-0 w-[3px] rounded-r-[3px] bg-[var(--p-accent)] opacity-[0.85]" />

      <header className="mb-3.5 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="mb-1 inline-flex items-center gap-2 text-[18px] font-bold leading-[1.15] tracking-[-0.018em] text-ink">
            <Link
              className="hover:underline"
              href={`/projects/${project.slug}`}
            >
              {project.name}
            </Link>
          </h2>
        </div>
        <div className="flex flex-none flex-col items-end gap-1">
          <span
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-1 font-mono text-[10.5px] font-semibold tracking-[0.04em]",
              project.status === "running"
                ? "border border-[color-mix(in_oklab,var(--p-accent)_25%,var(--line))] bg-[var(--p-soft)] text-[var(--p-accent)]"
                : "border border-line bg-ivory text-mute",
            )}
          >
            <span
              className={clsx(
                "h-1.5 w-1.5 rounded-full",
                project.status === "running"
                  ? "bg-[var(--p-accent)] animate-[pulse-dot_2.2s_ease-out_infinite]"
                  : "bg-mute-2",
              )}
            />
            {project.status === "running" ? "running" : "idle"}
          </span>
        </div>
      </header>

      <div className="mb-3.5 flex items-center gap-2.5">
        <div className="inline-flex">
          {visibleMembers.map((member, idx) => (
            <span
              key={`${member.name}-${idx}`}
              className={clsx(
                "relative inline-flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-paper bg-[var(--p-soft)] font-mono text-[9.5px] font-bold tracking-[0.02em] text-[var(--p-accent)]",
                idx === 0 ? "ml-0" : "-ml-1.5",
              )}
              title={member.isAdmin ? `${member.name} (admin)` : member.name}
            >
              {member.initials}
              {member.isAdmin ? (
                <span
                  aria-label="admin"
                  className="absolute -right-0.5 -top-0.5 inline-flex h-2 w-2 items-center justify-center rounded-full border border-paper bg-amber text-[6px] font-bold leading-none text-white"
                  title="admin"
                >
                  ★
                </span>
              ) : null}
            </span>
          ))}
          {project.agents.map((agent, idx) => (
            <span
              key={`${agent}-${idx}`}
              className={clsx(
                "-ml-1.5 inline-flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-paper font-mono text-[8.5px] font-bold tracking-[0.02em] text-white",
                agent === "claude"
                  ? "bg-amber"
                  : agent === "codex"
                    ? "bg-accent-3"
                    : "bg-accent-4",
              )}
              title={agent}
            >
              {agent === "claude" ? "cl" : agent === "codex" ? "cx" : "dv"}
            </span>
          ))}
        </div>
        <span className="font-mono text-[10.5px] tracking-[0.02em] text-mute">
          <b className="font-semibold text-ink-2">
            {t("teamHumans", { count: project.humansCount })}
          </b>{" "}
          · {t("teamAgents", { count: project.agentsCount })}
        </span>
      </div>

      <div className="mb-3.5 flex items-stretch overflow-hidden rounded-[10px] border border-line-soft bg-[color-mix(in_oklab,var(--ivory)_50%,var(--paper))] p-0.5">
        <span className="relative flex min-w-0 flex-1 cursor-pointer flex-col gap-px rounded-lg px-2.5 py-2 font-mono text-[10.5px] tracking-[0.02em] transition-colors hover:bg-paper">
          <span className="inline-flex items-center gap-[5px] text-[9px] font-semibold uppercase tracking-[0.12em] text-mute">
            <span
              className={clsx(
                "inline-block h-[5px] w-[5px] rounded-full",
                project.defaultAgent
                  ? agentIcoColor[project.defaultAgent]
                  : "bg-mute-2",
              )}
            />
            agent
          </span>
          <b className="truncate text-[11.5px] font-semibold text-ink">
            {project.defaultAgent ?? "—"}
          </b>
        </span>
        <span className="relative flex min-w-0 flex-1 cursor-pointer flex-col gap-px rounded-lg px-2.5 py-2 font-mono text-[10.5px] tracking-[0.02em] transition-colors before:absolute before:inset-y-2 before:-left-px before:w-px before:bg-line before:content-[''] hover:bg-paper">
          <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-mute">
            flows
          </span>
          <b className="truncate text-[11.5px] font-semibold text-ink">
            {project.flowsCount} configured
          </b>
        </span>
        <span className="relative flex min-w-0 flex-1 cursor-pointer flex-col gap-px rounded-lg px-2.5 py-2 font-mono text-[10.5px] tracking-[0.02em] transition-colors before:absolute before:inset-y-2 before:-left-px before:w-px before:bg-line before:content-[''] hover:bg-paper">
          <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-mute">
            mcps
          </span>
          <b className="truncate text-[11.5px] font-semibold text-ink">—</b>
        </span>
      </div>

      {project.need ? (
        <Link
          className="mb-3.5 flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-[var(--p-line)] bg-[color-mix(in_oklab,var(--p-soft)_70%,var(--paper))] px-3 py-2.5 transition-[background,transform] hover:translate-x-0.5 hover:bg-[var(--p-soft)]"
          href={`/projects/${project.slug}`}
        >
          <span className="inline-flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-[var(--p-accent)] font-mono text-[11px] font-extrabold text-white">
            !
          </span>
          <span className="flex-1 text-[12.5px] font-medium leading-[1.35] text-ink">
            <b>{project.need.agent}</b> in{" "}
            <code className="rounded-[3px] border border-line bg-paper px-[5px] py-px font-mono text-[10.5px] text-ink-2">
              {project.need.branch}
            </code>{" "}
            — {project.need.prompt}
          </span>
          <span className="font-mono text-[12px] font-bold text-[var(--p-accent)]">
            →
          </span>
        </Link>
      ) : null}

      <div className="mt-1">
        <header className="mb-1.5 flex items-center justify-between font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-mute">
          <span>{t("workspaces")}</span>
          <span className="text-ink-2">
            {project.activeWorkspaces.length > 0
              ? t("activeCount", { count: project.activeWorkspaces.length })
              : t("noneActive")}
          </span>
        </header>
        {project.activeWorkspaces.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-px overflow-hidden rounded-lg border border-line-soft bg-[color-mix(in_oklab,var(--ivory)_35%,var(--paper))] p-0">
            {project.activeWorkspaces.map((ws, idx) => (
              <li
                key={`${ws.runId}-${idx}`}
                className="[&+li]:border-t [&+li]:border-line-soft"
              >
                <Link
                  className="grid cursor-pointer grid-cols-[10px_1fr_auto_auto_auto_auto] items-center gap-2 px-2.5 py-2 font-mono text-[11px] transition-colors hover:bg-paper"
                  href={ws.href}
                >
                  <span
                    className={clsx(
                      "h-[7px] w-[7px] rounded-full",
                      wsDotByStatus[ws.status],
                    )}
                  />
                  <span className="truncate font-semibold tracking-[-0.005em] text-ink">
                    {ws.branch}
                  </span>
                  {ws.runKind === "scratch" &&
                  ws.scratchAction &&
                  ws.scratchAction !== "none" ? (
                    <span className="rounded-[3px] border border-amber-line bg-amber-soft px-1.5 py-px text-[9.5px] tracking-[0.02em] text-amber">
                      {t(`workspaceAction.${ws.scratchAction}`)}
                    </span>
                  ) : null}
                  <span
                    className={clsx(
                      "rounded-[3px] border px-1.5 py-px text-[10px] tracking-[0.02em]",
                      wsAgentChip[ws.agent] ?? "border-line bg-ivory text-mute",
                    )}
                  >
                    {ws.runKind === "scratch" ? "scratch" : ws.agent}
                  </span>
                  {ws.readiness !== "ready" ? (
                    <span
                      aria-label={tReadiness(ws.readiness)}
                      className={clsx(
                        "rounded-full border px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.04em]",
                        READINESS_BADGE[ws.readiness],
                      )}
                      data-readiness={ws.readiness}
                      title={tReadiness(ws.readiness)}
                    >
                      {tReadiness(ws.readiness)}
                    </span>
                  ) : null}
                  <span
                    className={clsx(
                      "text-[10px] tracking-[0.04em]",
                      ws.status === "needs"
                        ? "font-bold text-amber"
                        : "text-mute-2",
                    )}
                  >
                    {ws.time}
                  </span>
                </Link>
                {ws.lifecycleActions.length > 0 ? (
                  <WorkbenchLifecycleActions
                    actions={ws.lifecycleActions}
                    className="px-2.5 pb-2"
                    runId={ws.runId}
                    runKind={ws.runKind}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {project.recentMerges.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1 rounded-lg border border-dashed border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))] bg-[color-mix(in_oklab,var(--accent-4-soft)_35%,var(--paper))] px-2.5 py-2">
          <div className="flex items-center justify-between font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-mute">
            <span className="before:mr-1.5 before:font-bold before:text-accent-4 before:content-['✔']">
              {t("recentlyMerged")}
            </span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {project.recentMerges.map((merge, idx) => (
              <li
                key={`${merge.branch}-${idx}`}
                className="grid cursor-pointer grid-cols-[1fr_auto_auto] items-center gap-2 py-0.5 font-mono text-[10.5px] text-ink-2 hover:text-ink"
              >
                <span className="truncate font-semibold text-ink-2 before:mr-1.5 before:inline-block before:h-[5px] before:w-[5px] before:rounded-full before:bg-accent-4 before:align-[1px] before:opacity-[0.65] before:content-['']">
                  {merge.branch}
                </span>
                <span className="text-[9.5px] tracking-[0.04em] text-mute">
                  {merge.agent} · main
                </span>
                <span className="text-[9.5px] tracking-[0.04em] text-mute-2">
                  {merge.time}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <footer className="mt-3.5 flex items-center justify-between gap-2.5 border-t border-line-soft pt-3">
        <div className="inline-flex flex-wrap gap-1.5">
          {project.pendingHitlCount > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-line bg-amber-soft px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.04em] text-amber">
              {t("pendingChip", { count: project.pendingHitlCount })}
            </span>
          ) : null}
        </div>
        <Link
          className="inline-flex items-center gap-[5px] font-mono text-[10.5px] tracking-[0.04em] text-mute hover:text-ink"
          href={`/projects/${project.slug}`}
        >
          {t("backlog")} ·{" "}
          <b className="font-semibold text-ink-2">{project.backlogCount}</b>{" "}
          <span className="font-bold text-[var(--p-accent)]">→</span>
        </Link>
      </footer>
    </article>
  );
}
