import type { AccountStatus, GlobalRole } from "@/lib/db/schema";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import {
  AdminUsersTable,
  type AdminUserRow,
} from "@/components/admin/users-table";
import { requireGlobalRole } from "@/lib/authz";
import { listProjectOptions } from "@/lib/queries/project";
import { listAdminUsers } from "@/lib/users";

const ROLES = ["viewer", "member", "admin"] as const;
const STATUSES = ["pending", "active", "disabled"] as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("adminUsers");

  return { title: t("title") };
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactElement> {
  await requireGlobalRole("admin");

  const t = await getTranslations("adminUsers");
  const sp = await searchParams;

  const q = first(sp.q)?.trim() || undefined;
  const roleParam = first(sp.role);
  const statusParam = first(sp.status);
  const projectId = first(sp.projectId) || undefined;

  const role =
    roleParam && (ROLES as readonly string[]).includes(roleParam)
      ? (roleParam as GlobalRole)
      : undefined;
  const status =
    statusParam && (STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as AccountStatus)
      : undefined;

  const [users, projectOptions] = await Promise.all([
    listAdminUsers({ q, role, status, projectId }),
    listProjectOptions(),
  ]);

  const rows: AdminUserRow[] = users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    projects: user.projects,
  }));

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">
          {t("eyebrow")}
        </div>
        <div>
          <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em] text-ink">
            {t("title")}
          </h1>
          <p className="mt-2 max-w-[680px] text-[13.5px] leading-[1.55] text-mute">
            {t("sub")}
          </p>
        </div>
      </header>

      <AdminUsersTable
        filters={{
          q: q ?? "",
          role: role ?? "all",
          status: status ?? "all",
          projectId: projectId ?? "all",
        }}
        projectOptions={projectOptions.map((p) => ({ id: p.id, name: p.name }))}
        users={rows}
      />
    </div>
  );
}
