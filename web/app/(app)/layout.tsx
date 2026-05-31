import type { ReactElement, ReactNode } from "react";

import { redirect } from "next/navigation";

import { LeftRail } from "@/components/chrome/left-rail";
import { StatusBar } from "@/components/chrome/status-bar";
import { TopNav } from "@/components/chrome/top-nav";
import { getSessionUser } from "@/lib/authz";
import { getRailWorkspaces } from "@/lib/queries/portfolio";
import { getPlatformStatus } from "@/lib/supervisor-client";

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

  const [railWorkspaces, platformStatus] = await Promise.all([
    sessionUser ? getRailWorkspaces(sessionUser.id, sessionUser.role) : [],
    getPlatformStatus(),
  ]);

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

  const inboxCount = railWorkspaces.filter(
    (ws) => ws.status === "needs",
  ).length;

  return (
    <div className="flex min-h-screen flex-col bg-paper-warm pb-14">
      <TopNav
        crumb={<NavCrumb />}
        platformStatus={platformStatus}
        user={navUser}
      />

      <div
        data-shell
        className="grid min-h-[calc(100vh-60px-56px)] grid-cols-1 md:grid-cols-[260px_1fr]"
        data-density="comfy"
      >
        <LeftRail
          activeSection="projects"
          inboxCount={inboxCount}
          launchHref="/scratch-runs/new"
          platformStatus={platformStatus}
          userRole={sessionUser?.role}
          workspaces={railWorkspaces.map((ws) => ({
            ...ws,
            current: false,
          }))}
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
