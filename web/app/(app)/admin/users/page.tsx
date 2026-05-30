import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import {
  AdminUsersTable,
  type AdminUserRow,
} from "@/components/admin/users-table";
import { requireGlobalRole } from "@/lib/authz";
import { listAdminUsers } from "@/lib/users";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("adminUsers");

  return { title: t("title") };
}

export default async function AdminUsersPage(): Promise<ReactElement> {
  await requireGlobalRole("admin");

  const t = await getTranslations("adminUsers");
  const users = await listAdminUsers();
  const rows: AdminUserRow[] = users.map((user) => ({
    ...user,
    createdAt: user.createdAt.toISOString(),
    statusUpdatedAt: user.statusUpdatedAt?.toISOString() ?? null,
  }));

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6">
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

      <AdminUsersTable initialUsers={rows} />
    </div>
  );
}
