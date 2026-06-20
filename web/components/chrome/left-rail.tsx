import type { ActiveWorkspaceRowLabels } from "@/components/chrome/active-workspace-row";
import type { LeftRailNavSection } from "@/components/chrome/left-rail-nav";
import type { RailSectionId } from "@/components/chrome/left-rail-route";
import type {
  AdapterReadinessCause,
  AdapterReadinessSummary,
} from "@/lib/acp-runners/readiness-summary";
import type { GlobalRole } from "@/lib/db/schema";
import type { RailWorkspaceGroup } from "@/lib/queries/portfolio";
import type { PlatformStatus } from "@/types/platform-status";
import type { ComponentType, ReactElement, ReactNode, SVGProps } from "react";

import { CpuChipIcon, WindowIcon } from "@heroicons/react/24/outline";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import clsx from "clsx";

import { ActiveWorkspaceRow } from "@/components/chrome/active-workspace-row";
import { AutoCloseDetails } from "@/components/chrome/auto-close-details";
import { LaunchHotkeyHint } from "@/components/chrome/launch-hotkey-hint";
import { LeftRailNav } from "@/components/chrome/left-rail-nav";
import { RailCollapse } from "@/components/chrome/rail-collapse";
import { RunnersReadinessRailView } from "@/components/chrome/runners-readiness-rail";
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
  activeSection?: RailSectionId | null;
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

type FlyoutIcon = ComponentType<SVGProps<SVGSVGElement>>;

const flyoutIcons: Record<"runners" | "workspaces", FlyoutIcon> = {
  workspaces: WindowIcon,
  runners: CpuChipIcon,
};

function CollapsedRailBadge({ value }: { value: number }): ReactElement {
  return (
    <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-amber px-1 py-px text-center font-mono text-[9px] font-bold leading-none text-white">
      {value}
    </span>
  );
}

function CollapsedRailFlyout({
  badge,
  children,
  icon,
  iconTestId,
  label,
}: {
  badge?: number;
  children: ReactNode;
  icon: FlyoutIcon;
  iconTestId: string;
  label: string;
}): ReactElement {
  const Icon = icon;

  return (
    <AutoCloseDetails className="group relative">
      <summary
        aria-label={label}
        className="relative flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-[10px] border border-line bg-paper text-mute transition-colors hover:border-mute hover:bg-ivory hover:text-ink group-open:border-amber-line group-open:bg-amber-soft group-open:text-amber [&::-webkit-details-marker]:hidden"
        title={label}
      >
        <Icon
          aria-hidden="true"
          className="h-3.5 w-3.5"
          data-testid={iconTestId}
        />
        {badge && badge > 0 ? <CollapsedRailBadge value={badge} /> : null}
      </summary>
      <div className="absolute left-[calc(100%+8px)] top-0 z-[130] max-h-[min(520px,calc(100vh-96px))] w-[340px] overflow-y-auto rounded-[14px] border border-line bg-paper p-3 shadow-[var(--shadow-lg)]">
        <div className="mb-2 border-b border-line pb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
          {label}
        </div>
        {children}
      </div>
    </AutoCloseDetails>
  );
}

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
  const causeLabels = Object.fromEntries(
    (Object.keys(runnerCauseLabelKey) as AdapterReadinessCause[]).map(
      (cause) => [cause, tPortfolio(runnerCauseLabelKey[cause])],
    ),
  ) as Record<AdapterReadinessCause, string>;

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
    };
  }

  // `ready: false` sections are documented M9 deferrals (no route yet). They
  // render as non-navigating "coming soon" items so they never 404 — matching
  // the cursor/aider "coming soon" agent-chip precedent below.
  const sections: LeftRailNavSection[] = [
    { id: "projects", label: tNav("projects"), href: "/", ready: true },
    { id: "inbox", label: tNav("inbox"), href: "/inbox", ready: true },
    { id: "studio", label: tNav("studio"), href: "/studio", ready: true },
  ];

  // Platform agents, MCP, users, scheduler, and settings are admin-only and
  // access-controlled at the route too; the hidden nav item is convenience,
  // never the authorization boundary.
  if (userRole === "admin") {
    sections.push({
      id: "agents",
      label: tNav("agents"),
      href: "/agents",
      ready: true,
    });
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

  const collapsedContent = (
    <>
      <LeftRailNav
        activeSection={activeSection}
        comingSoon={tNav("comingSoon")}
        inboxCount={inboxCount}
        sections={sections}
        variant="collapsed"
      />

      <div className="flex shrink-0 flex-col items-center gap-1 border-b border-line pb-2">
        <CollapsedRailFlyout
          badge={activeCount}
          icon={flyoutIcons.workspaces}
          iconTestId="rail-flyout-icon-workspaces"
          label={tPortfolio("activeWorkspaces")}
        >
          <div className="flex flex-col gap-2">
            <Link
              className="inline-flex items-center justify-between rounded-lg border border-line bg-ivory px-2.5 py-1.5 font-mono text-[10px] font-semibold text-mute transition-colors hover:border-mute hover:text-ink"
              href="/runs"
            >
              <span>{tPortfolio("seeAll")}</span>
              <span className="rounded-full bg-paper px-1.5 py-px text-[9.5px] text-ink-2">
                {activeCount}
              </span>
            </Link>
            {workspaceGroups.length > 0 ? (
              <div className="flex flex-col gap-2">
                {workspaceGroups.map((group) => (
                  <section
                    key={group.projectId}
                    className="flex flex-col gap-0.5"
                  >
                    <div className="flex items-center gap-1.5 px-1 py-1">
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
                          <ActiveWorkspaceRow
                            labels={buildLabels(ws)}
                            row={ws}
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : workspaces.length > 0 ? (
              <ul className="flex list-none flex-col gap-0.5">
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
            ) : (
              <p className="m-0 px-1 py-2 font-mono text-[11px] text-mute-2">
                {tPortfolio("noneActive")}
              </p>
            )}
          </div>
        </CollapsedRailFlyout>

        <CollapsedRailFlyout
          badge={visibleAdapters.length}
          icon={flyoutIcons.runners}
          iconTestId="rail-flyout-icon-runners"
          label={tPortfolio("runnersReadiness")}
        >
          <div className="flex flex-col gap-1 font-mono text-[10.5px] tracking-[0.02em]">
            {visibleAdapters.length > 0 ? (
              visibleAdapters.map((adapter) => {
                const label = tPortfolio(runnerCauseLabelKey[adapter.cause]);

                return (
                  <span
                    key={adapter.adapter}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-ivory px-2 py-1.5 text-mute"
                    title={
                      adapter.detail ? `${label}: ${adapter.detail}` : label
                    }
                  >
                    <span
                      className={clsx(
                        "h-[5px] w-[5px] rounded-full",
                        adapter.state === "green" ? "bg-accent-4" : "bg-amber",
                      )}
                    />
                    <span className="font-semibold text-ink-2">
                      {adapter.adapter}
                    </span>
                    <span className="min-w-0 truncate">{label}</span>
                  </span>
                );
              })
            ) : (
              <span className="text-mute-2">{tPortfolio("runnersNone")}</span>
            )}
          </div>
        </CollapsedRailFlyout>
      </div>

      <div className="mt-auto flex shrink-0 flex-col items-center gap-2 pb-4">
        <ScratchLaunchPopover
          hint={tPortfolio("launchHint")}
          label="+"
          title={tPortfolio("launchRun")}
          variant="rail"
        />
      </div>
    </>
  );

  return (
    <RailCollapse
      collapseLabel={tNav("collapseRail")}
      collapsedChildren={collapsedContent}
      expandLabel={tNav("expandRail")}
    >
      <LeftRailNav
        activeSection={activeSection}
        comingSoon={tNav("comingSoon")}
        inboxCount={inboxCount}
        sections={sections}
        variant="expanded"
      />

      <section className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden">
        <div className="flex items-center justify-between px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
          <span>{tPortfolio("activeWorkspaces")}</span>
          <Link
            className="inline-flex cursor-pointer items-center gap-1 font-mono text-[9.5px] normal-case tracking-[0.06em] text-mute hover:text-amber"
            href="/runs"
          >
            {tPortfolio("seeAll")}{" "}
            <span className="rounded-full bg-ivory px-1.5 py-px text-[9.5px] tracking-normal text-ink-2">
              {activeCount}
            </span>{" "}
            →
          </Link>
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

      <RunnersReadinessRailView
        adapters={visibleAdapters}
        causeLabels={causeLabels}
        isAdmin={userRole === "admin"}
        labels={{
          heading: tPortfolio("runnersReadiness"),
          none: tPortfolio("runnersNone"),
          noneConfigured: tPortfolio("runnerNoneConfigured"),
          enabledLabel: tPortfolio("runnerEnabledShort"),
          disabledLabel: tPortfolio("runnerDisabledShort"),
          configureCta: tPortfolio("runnerConfigureCta"),
          readiness: {
            Ready: tPortfolio("runnerReady"),
            NotReady: tPortfolio("runnerStatusNotReady"),
            Unknown: tPortfolio("runnerStatusUnknown"),
          },
        }}
      />

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
    </RailCollapse>
  );
}
