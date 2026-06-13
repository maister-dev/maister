import type { ReactElement, ReactNode } from "react";

import { redirect } from "next/navigation";

import { LeftRail } from "@/components/chrome/left-rail";
import { StatusBar } from "@/components/chrome/status-bar";
import { TopNav } from "@/components/chrome/top-nav";
import { summarizeAdapterReadiness } from "@/lib/acp-runners/readiness-summary";
import { loadRunnerReadinessRows } from "@/lib/acp-runners/runner-readiness-rows";
import { getSessionUser } from "@/lib/authz";
import { getNeedsYouCount } from "@/lib/queries/needs-you";
import { getRailWorkspaceGroups } from "@/lib/queries/portfolio";
import {
  checkSupervisorDiagnostics,
  getPlatformStatus,
} from "@/lib/supervisor-client";

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
  const sessionUser = await getSessionUser();

  if (sessionUser && sessionUser.accountStatus !== "active") {
    redirect("/login");
  }

  // Force a password change before any app access (seeded admin / admin-reset).
  if (sessionUser?.mustChangePassword) {
    redirect("/change-password");
  }

  const [
    railWorkspaceGroups,
    platformStatus,
    diagnostics,
    runnerRows,
    needsYou,
  ] = await Promise.all([
    sessionUser ? getRailWorkspaceGroups(sessionUser.id, sessionUser.role) : [],
    getPlatformStatus(),
    checkSupervisorDiagnostics(),
    loadRunnerReadinessRows(),
    sessionUser ? getNeedsYouCount(sessionUser.id, sessionUser.role) : 0,
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

  return (
    <div className="flex min-h-screen flex-col bg-paper-warm pb-14">
      <TopNav crumb={<NavCrumb />} user={navUser} />

      <div
        data-shell
        className="grid min-h-[calc(100vh-60px-56px)] grid-cols-1 md:grid-cols-[260px_1fr]"
        data-density="comfy"
      >
        <LeftRail
          activeSection="projects"
          inboxCount={needsYou}
          platformStatus={platformStatus}
          runnersReadiness={runnersReadiness}
          userRole={sessionUser?.role}
          workspaceGroups={railWorkspaceGroups}
        />
        <main className="min-w-0 px-4 pb-12 pt-7 md:px-9">{children}</main>
      </div>

      <StatusBar platformStatus={platformStatus} />
    </div>
  );
}

function NavCrumb(): ReactElement {
  return (
    <>
      <span className="text-line">/</span>
      <b className="font-semibold text-ink">portfolio</b>
    </>
  );
}
