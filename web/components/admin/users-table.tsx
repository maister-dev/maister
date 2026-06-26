"use client";

import type { AccountStatus, GlobalRole, ProjectRole } from "@/lib/db/schema";
import type { ReactElement } from "react";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { UserCreateModal } from "@/components/admin/user-create-modal";
import { UserEditModal } from "@/components/admin/user-edit-modal";
import { NumberedPagination } from "@/components/navigation/numbered-pagination";

export interface AdminUserProjectRow {
  id: string;
  name: string;
  role: ProjectRole;
  slug: string;
}

export interface AdminUserRow {
  createdAt: string;
  email: string;
  id: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  name: string | null;
  projects: AdminUserProjectRow[];
  role: GlobalRole;
  status: AccountStatus;
  statusUpdatedAt: string | null;
  statusUpdatedBy: string | null;
}

export interface ProjectOption {
  id: string;
  name: string;
}

export interface AdminUsersFilters {
  projectId: string;
  q: string;
  role: GlobalRole | "all";
  status: AccountStatus | "all";
}

export interface AdminUsersTableProps {
  filters: AdminUsersFilters;
  page: number;
  perPage: number;
  projectOptions: ProjectOption[];
  total: number;
  users: AdminUserRow[];
}

const inputClass =
  "min-h-[34px] rounded-md border border-line bg-paper px-2.5 font-mono text-[11px] text-ink outline-none focus:border-amber";

const badgeBase =
  "rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em]";

function formatDate(iso: string | null, fallback: string): string {
  if (!iso) return fallback;

  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatDateShort(iso: string | null, fallback: string): string {
  if (!iso) return fallback;

  return new Date(iso).toLocaleDateString(undefined, {
    dateStyle: "medium",
  });
}

export function AdminUsersTable({
  filters,
  page,
  perPage,
  projectOptions,
  total,
  users,
}: AdminUsersTableProps): ReactElement {
  const t = useTranslations("adminUsers");
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  // URL is the source of truth; these mirror it for snappy controls and are
  // reconciled from props whenever the URL changes (filter apply, back/forward).
  const [q, setQ] = useState(filters.q);
  const [role, setRole] = useState(filters.role);
  const [status, setStatus] = useState(filters.status);
  const [projectId, setProjectId] = useState(filters.projectId);
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  const [creating, setCreating] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  useEffect(() => {
    setQ(filters.q);
    setRole(filters.role);
    setStatus(filters.status);
    setProjectId(filters.projectId);
  }, [filters.q, filters.role, filters.status, filters.projectId]);

  // Write the COMPLETE filter set (these 4 are the only params) so a rapid
  // dropdown-then-type can never drop a just-changed filter via a stale URL.
  // Filter changes reset to page 1.
  function syncUrl(next: AdminUsersFilters): void {
    const params = new URLSearchParams();

    if (next.q.trim()) params.set("q", next.q.trim());
    if (next.role !== "all") params.set("role", next.role);
    if (next.status !== "all") params.set("status", next.status);
    if (next.projectId !== "all") params.set("projectId", next.projectId);

    const query = params.toString();

    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    });
  }

  function pageHref(p: number): string {
    const params = new URLSearchParams();

    if (filters.q.trim()) params.set("q", filters.q.trim());
    if (filters.role !== "all") params.set("role", filters.role);
    if (filters.status !== "all") params.set("status", filters.status);
    if (filters.projectId !== "all") params.set("projectId", filters.projectId);
    if (perPage !== 25) params.set("perPage", String(perPage));
    if (p > 1) params.set("page", String(p));

    const query = params.toString();

    return query ? `${pathname}?${query}` : pathname;
  }

  // Debounce typing → URL. Deps include every filter so the pending timer
  // always captures the latest dropdown values; skip when q already matches
  // the applied filter so reconciliation and our own writes don't ping-pong.
  useEffect(() => {
    if (q.trim() === filters.q) return;

    const handle = setTimeout(
      () => syncUrl({ projectId, q, role, status }),
      300,
    );

    return () => clearTimeout(handle);
  }, [q, role, status, projectId, filters.q]);

  return (
    <section className="rounded-[14px] border border-line bg-paper shadow-[var(--shadow-sm)]">
      <div className="flex flex-col gap-3 border-b border-line px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em] text-ink">
              {t("tableTitle")}
            </h2>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
              {t("tableSub")}
            </p>
          </div>
          <button
            className="shrink-0 touch-manipulation rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2"
            type="button"
            onClick={() => setCreating(true)}
          >
            {t("newUser")}
          </button>
        </div>

        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <input
            aria-label={t("searchPlaceholder")}
            autoComplete="off"
            className={clsx(inputClass, "touch-manipulation md:w-[240px]")}
            name="user-search"
            placeholder={t("searchPlaceholder")}
            spellCheck={false}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            aria-label={t("filterRoleAll")}
            className={inputClass}
            value={role}
            onChange={(e) => {
              const next = e.target.value as GlobalRole | "all";

              setRole(next);
              syncUrl({ projectId, q, role: next, status });
            }}
          >
            <option value="all">{t("filterRoleAll")}</option>
            <option value="viewer">{t("role.viewer")}</option>
            <option value="member">{t("role.member")}</option>
            <option value="admin">{t("role.admin")}</option>
          </select>
          <select
            aria-label={t("filterAll")}
            className={inputClass}
            value={status}
            onChange={(e) => {
              const next = e.target.value as AccountStatus | "all";

              setStatus(next);
              syncUrl({ projectId, q, role, status: next });
            }}
          >
            <option value="all">{t("filterAll")}</option>
            <option value="pending">{t("status.pending")}</option>
            <option value="active">{t("status.active")}</option>
            <option value="disabled">{t("status.disabled")}</option>
          </select>
          <select
            aria-label={t("filterProjectAll")}
            className={inputClass}
            value={projectId}
            onChange={(e) => {
              const next = e.target.value;

              setProjectId(next);
              syncUrl({ projectId: next, q, role, status });
            }}
          >
            <option value="all">{t("filterProjectAll")}</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table
          aria-busy={pending}
          className={clsx(
            "w-full min-w-[860px] border-collapse text-left transition-opacity",
            pending && "opacity-60",
          )}
        >
          <thead className="border-b border-line bg-ivory">
            <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
              <th className="px-5 py-3">{t("user")}</th>
              <th className="px-4 py-3">{t("statusLabel")}</th>
              <th className="px-4 py-3">{t("roleLabel")}</th>
              <th className="px-4 py-3">{t("projectAccess")}</th>
              <th className="px-4 py-3">{t("lastLogin")}</th>
              <th className="px-4 py-3">{t("created")}</th>
              <th className="px-5 py-3 text-right">{t("actions")}</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td
                  className="px-5 py-8 text-center font-mono text-[11.5px] text-mute"
                  colSpan={7}
                >
                  {t("noResults")}
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <UserRow
                  key={user.id}
                  editLabel={t("edit")}
                  neverLabel={t("neverLoggedIn")}
                  roleLabel={t(`role.${user.role}`)}
                  statusLabel={t(`status.${user.status}`)}
                  user={user}
                  onEdit={() => setEditing(user)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <NumberedPagination
          currentPage={page}
          hrefForPage={pageHref}
          labels={{
            ariaLabel: t("paginationLabel"),
            next: t("pageNext"),
            page: t("pageLabel"),
            previous: t("pagePrev"),
          }}
          pageCount={totalPages}
        />
      ) : null}

      {editing ? (
        <UserEditModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => startTransition(() => router.refresh())}
        />
      ) : null}

      {creating ? (
        <UserCreateModal
          onClose={() => setCreating(false)}
          onSaved={() => startTransition(() => router.refresh())}
        />
      ) : null}
    </section>
  );
}

function UserRow({
  user,
  roleLabel,
  statusLabel,
  neverLabel,
  editLabel,
  onEdit,
}: {
  editLabel: string;
  neverLabel: string;
  onEdit: () => void;
  roleLabel: string;
  statusLabel: string;
  user: AdminUserRow;
}): ReactElement {
  const shownProjects = user.projects.slice(0, 3);
  const overflow = user.projects.length - shownProjects.length;

  return (
    <tr className="border-b border-line align-middle last:border-b-0">
      <td className="px-5 py-3.5">
        <div className="max-w-[280px] truncate font-semibold text-ink">
          {user.name ?? user.email}
        </div>
        <div className="max-w-[280px] truncate font-mono text-[10.5px] tracking-[0.03em] text-mute">
          {user.email}
        </div>
      </td>
      <td className="px-4 py-3.5">
        <span
          className={clsx(
            badgeBase,
            user.status === "active" &&
              "border-[color-mix(in_oklab,var(--good)_35%,var(--line))] bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good",
            user.status === "pending" &&
              "border-amber-line bg-amber-soft text-amber",
            user.status === "disabled" && "border-line bg-ivory text-mute",
          )}
        >
          {statusLabel}
        </span>
      </td>
      <td className="px-4 py-3.5">
        <span className={clsx(badgeBase, "border-line bg-ivory text-ink-2")}>
          {roleLabel}
        </span>
      </td>
      <td className="px-4 py-3.5">
        {user.projects.length === 0 ? (
          <span className="font-mono text-[11px] text-mute-2">—</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {shownProjects.map((p) => (
              <span
                key={p.id}
                className="rounded-md border border-line bg-ivory px-2 py-0.5 font-mono text-[10px] tracking-[0.02em] text-ink-2"
                title={`${p.name} · ${p.role}`}
              >
                {p.slug}
              </span>
            ))}
            {overflow > 0 ? (
              <span
                className="font-mono text-[10px] text-mute"
                title={user.projects
                  .slice(3)
                  .map((p) => `${p.name} · ${p.role}`)
                  .join("\n")}
              >
                +{overflow}
              </span>
            ) : null}
          </div>
        )}
      </td>
      <td
        suppressHydrationWarning
        className="px-4 py-3.5 font-mono text-[10.5px] tabular-nums text-mute"
      >
        {formatDate(user.lastLoginAt, neverLabel)}
      </td>
      <td
        suppressHydrationWarning
        className="px-4 py-3.5 font-mono text-[10.5px] tabular-nums text-mute"
      >
        {formatDateShort(user.createdAt, "—")}
      </td>
      <td className="px-5 py-3.5 text-right">
        <button
          aria-label={`${editLabel} · ${user.name ?? user.email}`}
          className="touch-manipulation rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10.5px] font-semibold tracking-[0.03em] text-ink-2 transition-colors hover:border-mute hover:text-ink"
          type="button"
          onClick={onEdit}
        >
          {editLabel}
        </button>
      </td>
    </tr>
  );
}
