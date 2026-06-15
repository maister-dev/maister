import type { ActiveWorkspaceRowLabels } from "@/components/chrome/active-workspace-row";
import type {
  AdapterReadinessCause,
  AdapterReadinessSummary,
} from "@/lib/acp-runners/readiness-summary";
import type { GlobalRole } from "@/lib/db/schema";
import type { RailWorkspaceGroup } from "@/lib/queries/portfolio";
import type { PlatformStatus } from "@/types/platform-status";
import type { ReactElement, ReactNode } from "react";

import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import clsx from "clsx";

import { ActiveWorkspaceRow } from "@/components/chrome/active-workspace-row";
import { LaunchHotkeyHint } from "@/components/chrome/launch-hotkey-hint";
import { ScratchLaunchPopover } from "@/components/chrome/scratch-launch-popover";

// Coarse relative-time copy for the GC removal countdown. Picks the largest unit
// (days → hours → minutes) and uses Intl.RelativeTimeFormat so EN/RU phrasing
// follows the active locale. Past deadlines render as "now".
function countdownText(
  locale: string,
  effectiveRemovalAt: Date,
  nowMs: number,
): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const deltaMs = effectiveRemovalAt.getTime() - nowMs;
  const minutes = Math.round(deltaMs / 60_000);

  if (deltaMs <= 0) return rtf.format(0, "minute");
  if (Math.abs(minutes) >= 1440) {
    return rtf.format(Math.round(minutes / 1440), "day");
  }
  if (Math.abs(minutes) >= 60) {
    return rtf.format(Math.round(minutes / 60), "hour");
  }

  return rtf.format(minutes, "minute");
}

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
  platformStatus: PlatformStatus;
  runnersReadiness?: readonly AdapterReadinessSummary[];
  userRole?: GlobalRole;
}

// Maps a readiness verdict cause to its `portfolio` i18n key for the rail
// chip tooltip. `binary_unavailable` adapters are hidden, never labelled.
const runnerCauseLabelKey: Record<AdapterReadinessCause, string> = {
  ready: "runnerReady",
  no_runner: "runnerNoRunner",
  all_disabled: "runnerAllDisabled",
  not_ready: "runnerNotReady",
  diagnostics_unavailable: "runnerDiagnosticsUnavailable",
  binary_unavailable: "runnerNotReady",
};

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
  scheduler: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6V8l2.4 1.5" />
    </>
  ),
};

const dotByStatus: Record<WorkspaceStatus, string> = {
  running: "bg-accent-4 animate-[pulse-dot_2.2s_ease-out_infinite]",
  needs: "bg-amber",
  queued: "bg-mute-2",
  done: "bg-accent-4 opacity-[0.55]",
};

// Run states that surface a status word inline next to the name (the rest keep
// the word in the dot's title/aria-label only). Mirrors the design tone table.
const ATTENTION_LABELS = new Set([
  "NeedsInput",
  "NeedsInputIdle",
  "Review",
  "Crashed",
]);

export async function LeftRail({
  activeSection = "projects",
  workspaces = [],
  workspaceGroups = [],
  inboxCount = 0,
  platformStatus,
  runnersReadiness = [],
  userRole,
}: LeftRailProps): Promise<ReactElement> {
  const tNav = await getTranslations("nav");
  const tPortfolio = await getTranslations("portfolio");
  const tGc = await getTranslations("gc");
  const locale = await getLocale();
  const nowMs = Date.now();
  const activeCount =
    workspaceGroups.length > 0
      ? workspaceGroups.reduce((sum, group) => sum + group.activeCount, 0)
      : workspaces.length;
  const visibleAdapters = runnersReadiness.filter(
    (item) => item.state !== "hidden",
  );

  function buildLabels(
    ws: RailWorkspaceGroup["workspaces"][number],
  ): ActiveWorkspaceRowLabels {
    const rd = ws.runnerDetail;
    const issueLabel =
      ws.taskKey && ws.taskNumber !== null
        ? `${ws.taskKey}-${ws.taskNumber}`
        : null;
    const runnerTooltip = rd
      ? [
          `${tPortfolio("runnerField.agent")}: ${rd.agent}`,
          `${tPortfolio("runnerField.model")}: ${rd.model}`,
          `${tPortfolio("runnerField.adapter")}: ${rd.adapter}`,
          `${tPortfolio("runnerField.provider")}: ${rd.provider}`,
          ...(rd.sidecar
            ? [`${tPortfolio("runnerField.sidecar")}: ${rd.sidecar}`]
            : []),
        ].join(" · ")
      : null;
    const ttlActive = ws.ttlState === "active";

    return {
      statusWord: tPortfolio(`railStatus.${ws.statusLabel}`),
      attention: ATTENTION_LABELS.has(ws.statusLabel),
      flowLabel: ws.flowRefLabel,
      flowTooltip: ws.flowRefLabel
        ? ws.flowVersion
          ? `${ws.flowRefLabel} · ${ws.flowVersion}`
          : ws.flowRefLabel
        : null,
      flowAria: ws.flowRefLabel
        ? tPortfolio("chip.flowAria", { flow: ws.flowRefLabel })
        : null,
      runnerLabel: rd ? rd.model : null,
      runnerTooltip,
      runnerAria: rd
        ? tPortfolio("chip.runnerAria", { runner: rd.model })
        : null,
      issueLabel,
      issueAria: issueLabel
        ? tPortfolio("chip.issueAria", { key: issueLabel })
        : null,
      ttlTone: ttlActive ? null : ws.ttlState === "due" ? "due" : "warning",
      ttlLabel: ttlActive
        ? null
        : ws.ttlState === "due"
          ? tGc("ttl.due")
          : tGc("ttl.warning"),
      ttlCountdown:
        !ttlActive && ws.effectiveRemovalAt
          ? countdownText(locale, ws.effectiveRemovalAt, nowMs)
          : null,
      archivedLabel: ws.archived ? tGc("archived") : null,
      rename: {
        action: tPortfolio("rename.action"),
        placeholder: tPortfolio("rename.placeholder"),
        confirm: tPortfolio("rename.confirm"),
        cancel: tPortfolio("rename.cancel"),
        busy: tPortfolio("rename.busy"),
        error: tPortfolio("rename.error"),
      },
    };
  }

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
    { id: "inbox", label: tNav("inbox"), href: "/inbox", ready: true },
    { id: "flows", label: tNav("flows"), href: "/flows", ready: true },
    { id: "agents", label: tNav("agents"), href: "/agents", ready: false },
  ];

  // User management is admin-only and access-controlled at the route too; the
  // hidden nav item is convenience, never the authorization boundary.
  if (userRole === "admin") {
    sections.push({
      id: "mcps",
      label: tNav("mcps"),
      href: "/mcps",
      ready: true,
    });
    sections.push({
      id: "users",
      label: tNav("users"),
      href: "/admin/users",
      ready: true,
    });
    sections.push({
      id: "scheduler",
      label: tNav("scheduler"),
      href: "/admin/scheduler",
      ready: true,
    });
    sections.push({
      id: "settings",
      label: tNav("settings"),
      href: "/settings",
      ready: true,
    });
  }

  return (
    <aside
      aria-label="Sections & active workspaces"
      className="sticky top-[60px] z-[100] hidden h-[calc(100vh-60px-56px)] flex-col gap-3.5 self-start overflow-x-hidden border-r border-line bg-paper px-3.5 pb-0 pt-3.5 md:flex"
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
                <span
                  className="ml-auto rounded-full bg-amber px-1.5 py-px font-mono text-[9.5px] font-bold tracking-[0.02em] text-white"
                  data-testid="inbox-nav-badge"
                >
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

      <section className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden">
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
                  <ScratchLaunchPopover
                    hint={group.projectName}
                    label="+"
                    projectId={group.projectId}
                    title={tPortfolio("startScratchInProject", {
                      project: group.projectName,
                    })}
                    variant="icon"
                  />
                </div>
                <ul className="flex list-none flex-col gap-0.5">
                  {group.workspaces.map((ws) => (
                    <li key={ws.runId}>
                      <ActiveWorkspaceRow labels={buildLabels(ws)} row={ws} />
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
          {tPortfolio("runnersReadiness")}
        </div>
        <div className="flex flex-wrap gap-1 font-mono text-[10.5px] tracking-[0.02em]">
          {visibleAdapters.length > 0 ? (
            visibleAdapters.map((adapter) => {
              const label = tPortfolio(runnerCauseLabelKey[adapter.cause]);

              return (
                <span
                  key={adapter.adapter}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-ivory py-[3px] pl-[7px] pr-2 font-mono text-[10.5px] tracking-[0.02em] text-mute"
                  title={adapter.detail ? `${label}: ${adapter.detail}` : label}
                >
                  <span
                    className={clsx(
                      "h-[5px] w-[5px] rounded-full",
                      adapter.state === "green" ? "bg-accent-4" : "bg-amber",
                    )}
                  />
                  {adapter.adapter}
                </span>
              );
            })
          ) : (
            <span className="text-mute-2">{tPortfolio("runnersNone")}</span>
          )}
        </div>
      </div>

      <div className="mt-auto flex shrink-0 flex-col gap-2 border-t border-line pb-4 pt-3">
        <ScratchLaunchPopover
          hint={tPortfolio("launchHint")}
          label={tPortfolio("launchRun")}
          shortcut={<LaunchHotkeyHint />}
          title={tPortfolio("launchRun")}
          variant="primary"
        />
        <div className="px-0.5 font-mono text-[10px] tracking-[0.04em] text-mute">
          {platformStatus.kind === "ready"
            ? tPortfolio("launchHint")
            : tPortfolio("launchUnavailableHint")}
        </div>
      </div>
    </aside>
  );
}
