import type { GlobalRole } from "@/lib/db/schema";
import type { RailWorkspaceGroup } from "@/lib/queries/portfolio";
import type { PlatformStatus } from "@/types/platform-status";
import type { ReactElement, ReactNode } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";
import clsx from "clsx";

import { PlatformStatusPill } from "@/components/chrome/platform-status";

type WorkspaceStatus = "running" | "needs" | "queued" | "done";

export interface RailWorkspace {
  name: string;
  meta: string;
  status: WorkspaceStatus;
  time: string;
  current?: boolean;
  href?: string;
}

export interface LeftRailProps {
  activeSection?: string;
  workspaces?: RailWorkspace[];
  workspaceGroups?: RailWorkspaceGroup[];
  inboxCount?: number;
  launchHref?: string;
  platformStatus: PlatformStatus;
  userRole?: GlobalRole;
}

const navIcon = "h-3.5 w-3.5 shrink-0 text-mute";
const navIconActive = "h-3.5 w-3.5 shrink-0 text-ink";

const sectionIcons: Record<string, ReactNode> = {
  projects: (
    <>
      <rect height="5" rx="1" width="5" x="2" y="2" />
      <rect height="5" rx="1" width="5" x="9" y="2" />
      <rect height="5" rx="1" width="5" x="2" y="9" />
      <rect height="5" rx="1" width="5" x="9" y="9" />
    </>
  ),
  inbox: <path d="M2 4h12M2 8h12M2 12h7" />,
  flows: <path d="M3 3 L13 3 L9 8 L13 13 L3 13 L7 8 Z" />,
  agents: (
    <>
      <circle cx="8" cy="5" r="2.6" />
      <path d="M2.4 14c0-3 2.5-5.4 5.6-5.4S13.6 11 13.6 14" />
    </>
  ),
  mcps: (
    <>
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="12" cy="4" r="1.6" />
      <circle cx="4" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <path d="M4 5.6V10.4M12 5.6V10.4M5.6 4H10.4M5.6 12H10.4" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1v3M8 12v3M15 8h-3M4 8H1M12.95 3.05l-2.12 2.12M5.17 10.83l-2.12 2.12M12.95 12.95l-2.12-2.12M5.17 5.17L3.05 3.05" />
    </>
  ),
  users: (
    <>
      <circle cx="6" cy="6" r="2.4" />
      <path d="M1.5 13.4c0-2.4 2-4.2 4.5-4.2s4.5 1.8 4.5 4.2" />
      <path d="M10.8 5.3a2.2 2.2 0 0 1 0 4.1M14.5 13.4c0-1.8-1-3.2-2.6-3.8" />
    </>
  ),
};

const dotByStatus: Record<WorkspaceStatus, string> = {
  running: "bg-accent-4 animate-[pulse-dot_2.2s_ease-out_infinite]",
  needs: "bg-amber",
  queued: "bg-mute-2",
  done: "bg-accent-4 opacity-[0.55]",
};

const dotByTone: Record<
  RailWorkspaceGroup["workspaces"][number]["statusTone"],
  string
> = {
  running: "bg-accent-4 animate-[pulse-dot_2.2s_ease-out_infinite]",
  waiting: "bg-amber",
  needs: "bg-amber",
  human: "bg-ink-2",
  review: "bg-accent-2",
  crashed: "bg-danger",
};

export async function LeftRail({
  activeSection = "projects",
  workspaces = [],
  workspaceGroups = [],
  inboxCount = 0,
  launchHref,
  platformStatus,
  userRole,
}: LeftRailProps): Promise<ReactElement> {
  const tNav = await getTranslations("nav");
  const tPortfolio = await getTranslations("portfolio");
  const activeCount =
    workspaceGroups.length > 0
      ? workspaceGroups.reduce((sum, group) => sum + group.activeCount, 0)
      : workspaces.length;

  // `ready: false` sections are documented M9 deferrals (no route yet). They
  // render as non-navigating "coming soon" items so they never 404 — matching
  // the cursor/aider "coming soon" agent-chip precedent below.
  const sections: {
    id: string;
    label: string;
    href: string;
    ready: boolean;
  }[] = [
    { id: "projects", label: tNav("projects"), href: "/", ready: true },
    { id: "inbox", label: tNav("inbox"), href: "/inbox", ready: false },
    { id: "flows", label: tNav("flows"), href: "/flows", ready: false },
    { id: "agents", label: tNav("agents"), href: "/agents", ready: false },
    { id: "mcps", label: tNav("mcps"), href: "/mcps", ready: false },
    {
      id: "settings",
      label: tNav("settings"),
      href: "/settings",
      ready: false,
    },
  ];

  // User management is admin-only and access-controlled at the route too; the
  // hidden nav item is convenience, never the authorization boundary.
  if (userRole === "admin") {
    sections.push({
      id: "users",
      label: tNav("users"),
      href: "/admin/users",
      ready: true,
    });
  }

  return (
    <aside
      aria-label="Sections & active workspaces"
      className="sticky top-[60px] hidden h-[calc(100vh-60px-56px)] flex-col gap-3.5 self-start overflow-y-auto overflow-x-hidden border-r border-line bg-paper px-3.5 pb-0 pt-3.5 md:flex"
    >
      <nav
        aria-label="Sections"
        className="flex shrink-0 flex-col gap-px border-b border-line pb-3 pt-1.5"
      >
        {sections.map((section) => {
          const isActive = section.id === activeSection;
          const showBadge = section.id === "inbox" && inboxCount > 0;
          const body = (
            <>
              <svg
                aria-hidden="true"
                className={isActive ? navIconActive : navIcon}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                viewBox="0 0 16 16"
              >
                {sectionIcons[section.id]}
              </svg>
              <span>{section.label}</span>
              {showBadge ? (
                <span className="ml-auto rounded-full bg-amber px-1.5 py-px font-mono text-[9.5px] font-bold tracking-[0.02em] text-white">
                  {inboxCount}
                </span>
              ) : null}
            </>
          );

          if (!section.ready) {
            return (
              <span
                key={section.id}
                aria-disabled="true"
                className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px] text-mute opacity-60"
                title={tNav("comingSoon")}
              >
                {body}
              </span>
            );
          }

          return (
            <Link
              key={section.id}
              aria-current={isActive ? "page" : undefined}
              className={clsx(
                "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px]",
                "hover:bg-ivory hover:text-ink",
                isActive ? "bg-ivory font-semibold text-ink" : "text-ink-2",
              )}
              href={section.href}
            >
              {body}
            </Link>
          );
        })}
      </nav>

      <section className="flex min-h-[200px] flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
          <span>{tPortfolio("activeWorkspaces")}</span>
          <button
            className="inline-flex cursor-pointer items-center gap-1 font-mono text-[9.5px] normal-case tracking-[0.06em] text-mute hover:text-amber"
            type="button"
          >
            {tPortfolio("seeAll")}{" "}
            <span className="rounded-full bg-ivory px-1.5 py-px text-[9.5px] tracking-normal text-ink-2">
              {activeCount}
            </span>{" "}
            →
          </button>
        </div>
        {workspaceGroups.length > 0 ? (
          <div className="flex flex-col gap-2 py-1">
            {workspaceGroups.map((group) => (
              <section key={group.projectId} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5 px-2 py-1">
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-ink-2">
                    {group.projectName}
                  </span>
                  <span className="rounded-full bg-ivory px-1.5 py-px font-mono text-[9.5px] text-mute">
                    {group.activeCount}
                  </span>
                  <Link
                    aria-label={tPortfolio("startScratchInProject", {
                      project: group.projectName,
                    })}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-md text-[13px] font-semibold text-mute hover:bg-ivory hover:text-amber"
                    href={group.launchHref}
                    title={tPortfolio("startScratchInProject", {
                      project: group.projectName,
                    })}
                  >
                    +
                  </Link>
                </div>
                <ul className="flex list-none flex-col gap-0.5">
                  {group.workspaces.map((ws) => (
                    <li key={ws.runId}>
                      <Link
                        className="relative grid cursor-pointer grid-cols-[12px_1fr_auto] items-center gap-2 rounded-lg px-2.5 py-2 transition-colors hover:bg-ivory"
                        href={ws.href}
                        title={`Open ${ws.name} · ${ws.executorLabel}`}
                      >
                        <span
                          className={clsx(
                            "h-2 w-2 rounded-full",
                            dotByTone[ws.statusTone],
                          )}
                        />
                        <div className="flex min-w-0 flex-col gap-px">
                          <code className="truncate font-mono text-[11.5px] font-semibold tracking-[-0.005em] text-ink">
                            {ws.name}
                          </code>
                          <span className="truncate font-mono text-[10px] tracking-[0.02em] text-mute">
                            {ws.statusLabel} · {ws.runKind} · {ws.executorLabel}
                            {ws.launchedBy ? ` · ${ws.launchedBy}` : ""}
                          </span>
                        </div>
                        <span
                          className={clsx(
                            "font-mono text-[10px] tracking-[0.04em]",
                            ws.statusTone === "needs" ||
                              ws.statusTone === "waiting"
                              ? "font-semibold text-amber"
                              : "text-mute-2",
                          )}
                        >
                          {ws.time}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className="flex list-none flex-col gap-0.5 py-1">
            {workspaces.map((ws) => (
              <li key={`${ws.name}-${ws.meta}`}>
                <Link
                  className={clsx(
                    "relative grid cursor-pointer grid-cols-[12px_1fr_auto] items-center gap-2 rounded-lg px-2.5 py-2 transition-colors",
                    ws.current ? "bg-amber-soft" : "hover:bg-ivory",
                  )}
                  href={ws.href ?? "#"}
                  title={`Open ${ws.name} · ${ws.meta}`}
                >
                  {ws.current ? (
                    <span className="absolute inset-y-2 left-0 w-0.5 rounded-sm bg-amber" />
                  ) : null}
                  <span
                    className={clsx(
                      "h-2 w-2 rounded-full",
                      dotByStatus[ws.status],
                    )}
                  />
                  <div className="flex min-w-0 flex-col gap-px">
                    <code className="truncate font-mono text-[11.5px] font-semibold tracking-[-0.005em] text-ink">
                      {ws.name}
                    </code>
                    <span className="truncate font-mono text-[10px] tracking-[0.02em] text-mute">
                      {ws.meta}
                    </span>
                  </div>
                  <span
                    className={clsx(
                      "font-mono text-[10px] tracking-[0.04em]",
                      ws.status === "needs"
                        ? "font-semibold text-amber"
                        : "text-mute-2",
                    )}
                  >
                    {ws.time}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-col gap-1.5 px-0.5 pb-0.5">
        <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-mute">
          {tPortfolio("platformStatus")}
        </div>
        <div className="flex flex-wrap gap-1 font-mono text-[10.5px] tracking-[0.02em]">
          <PlatformStatusPill
            className="rounded-full border border-line bg-ivory py-[3px] pl-[7px] pr-2"
            labels={{
              ready: tPortfolio("supervisorReady"),
              unavailable: tPortfolio("supervisorUnavailable"),
            }}
            status={platformStatus}
          />
          {["cursor", "aider"].map((agent) => (
            <span
              key={agent}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-ivory py-[3px] pl-[7px] pr-2 font-mono text-[10.5px] tracking-[0.02em] text-mute"
              title="Coming soon"
            >
              <span className="h-[5px] w-[5px] rounded-full bg-mute-2" />
              {agent}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-auto flex shrink-0 flex-col gap-2 border-t border-line pb-4 pt-3">
        <Link
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] bg-amber px-3 py-[11px] pl-3.5 font-sans text-[13.5px] font-semibold tracking-[-0.005em] text-white shadow-[0_8px_24px_-10px_var(--amber),0_1px_0_rgba(255,255,255,0.18)_inset] transition-[transform,box-shadow,background] hover:-translate-y-px hover:bg-amber-2"
          href={launchHref ?? "#"}
        >
          <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[7px] bg-white/20 font-mono text-[14px] font-bold leading-none">
            +
          </span>
          <span className="flex-1 text-left">{tPortfolio("launchRun")}</span>
          <kbd className="rounded bg-white/[0.18] px-1.5 py-[3px] font-mono text-[10px] font-semibold tracking-[0.04em]">
            ⌘L
          </kbd>
        </Link>
        <div className="px-0.5 font-mono text-[10px] tracking-[0.04em] text-mute">
          {platformStatus.kind === "ready"
            ? tPortfolio("launchHint")
            : tPortfolio("launchUnavailableHint")}
        </div>
      </div>
    </aside>
  );
}
