import type { RailBadges } from "@/components/chrome/left-rail-nav";
import type { ReactElement, ReactNode } from "react";

import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { AttentionLiveRefresh } from "@/components/attention/attention-live-refresh";
import { LeftRail } from "@/components/chrome/left-rail";
import { NavCrumb } from "@/components/chrome/nav-crumb";
import { buildLeftRailSections } from "@/components/chrome/left-rail-sections";
import { StatusBar } from "@/components/chrome/status-bar";
import { TopNav } from "@/components/chrome/top-nav";
import { summarizeAdapterReadiness } from "@/lib/acp-runners/readiness-summary";
import { loadRunnerReadinessRows } from "@/lib/acp-runners/runner-readiness-rows";
import { getSessionUser } from "@/lib/authz";
import { getDecisionsCount } from "@/lib/queries/decisions";
import { getUpdatesCount } from "@/lib/queries/updates";
import { getRailWorkspaceGroups } from "@/lib/queries/portfolio";
import {
  getPlatformDiagnostics,
  getPlatformStatus,
} from "@/lib/execution-host";

function initialsOf(name: string | null, email: string | null): string {
  const source = (name ?? email ?? "?").trim();
  const parts = source.split(/[\s@.]+/).filter(Boolean);

  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default async function AppLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactElement> {
  // ADR-171 D7: the render's cursor, taken before any read. Everything this
  // render shows was read at or after it, so the attention stream's scan from
  // here misses nothing the page could be stale about.
  const renderedAt = Date.now();
  const sessionUser = await getSessionUser();

  if (sessionUser && sessionUser.accountStatus !== "active") {
    redirect("/login");
  }

  // Force a password change before any app access (seeded admin / admin-reset).
  if (sessionUser?.mustChangePassword) {
    redirect("/change-password");
  }

  // ATN-05 / ADR-169 D7: BOTH counters are computed here, once, and passed
  // down. No surface recomputes its own number, and no badge derives one from
  // the other — they are separate populations.
  const [
    railWorkspaceGroups,
    platformStatus,
    diagnostics,
    runnerRows,
    decisions,
    updates,
  ] = await Promise.all([
    sessionUser ? getRailWorkspaceGroups(sessionUser.id, sessionUser.role) : [],
    getPlatformStatus(),
    getPlatformDiagnostics(),
    loadRunnerReadinessRows(),
    sessionUser ? getDecisionsCount(sessionUser.id, sessionUser.role) : 0,
    sessionUser ? getUpdatesCount(sessionUser.id, sessionUser.role) : 0,
  ]);

  const runnersReadiness = summarizeAdapterReadiness({
    runners: runnerRows,
    diagnostics,
  });

  const navUser = sessionUser
    ? {
        name: sessionUser.name ?? sessionUser.email ?? "you",
        email: sessionUser.email ?? "",
        role: sessionUser.role,
        initials: initialsOf(
          sessionUser.name ?? null,
          sessionUser.email ?? null,
        ),
      }
    : undefined;
  const [tNav, tRun] = await Promise.all([
    getTranslations("nav"),
    getTranslations("run"),
  ]);
  const railSections = buildLeftRailSections(
    (key) => tNav(key),
    sessionUser?.role,
  );
  const railBadges: RailBadges = {
    inbox: {
      value: decisions,
      tone: "attention",
      label: tNav("badgeDecisions").replace("$count", String(decisions)),
    },
    activity: {
      value: updates,
      tone: "neutral",
      label: tNav("badgeUpdates").replace("$count", String(updates)),
    },
  };

  return (
    <div className="flex min-h-screen flex-col bg-paper-warm pb-9">
      <TopNav
        badges={railBadges}
        crumb={
          <NavCrumb
            fallback={tNav("crumbDesk")}
            labels={Object.fromEntries(
              railSections.map((section) => [section.id, section.label]),
            )}
          />
        }
        sections={railSections}
        user={navUser}
      />

      <div
        data-shell
        className="grid flex-1 grid-cols-1 md:grid-cols-[auto_1fr]"
        data-density="comfy"
      >
        <LeftRail
          badges={railBadges}
          platformStatus={platformStatus}
          runnersReadiness={runnersReadiness}
          sections={railSections}
          userRole={sessionUser?.role}
          workspaceGroups={railWorkspaceGroups}
        />
        <main className="min-w-0 px-4 pb-12 pt-7 md:px-9">{children}</main>
      </div>

      <StatusBar
        liveStatus={
          sessionUser ? (
            <AttentionLiveRefresh
              labels={{
                disconnected: tRun("streamDisconnected"),
                live: tRun("streamLive"),
                reconnect: tRun("streamReconnect"),
                reconnecting: tRun("streamReconnecting"),
              }}
              since={{ cursor: String(renderedAt), decisions, updates }}
            />
          ) : null
        }
        platformHref={
          sessionUser?.role === "admin" ? "/admin/execution-host" : undefined
        }
        platformStatus={platformStatus}
      />
    </div>
  );
}
