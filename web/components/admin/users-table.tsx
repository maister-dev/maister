"use client";

import type { GlobalRole } from "@/lib/db/schema";
import type { ReactElement } from "react";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

type AccountStatus = "pending" | "active" | "disabled";

export interface AdminUserRow {
  createdAt: string;
  email: string;
  id: string;
  mustChangePassword: boolean;
  name: string | null;
  role: GlobalRole;
  status: AccountStatus;
  statusUpdatedAt: string | null;
  statusUpdatedBy: string | null;
}

export interface AdminUsersTableProps {
  initialUsers: AdminUserRow[];
}

const buttonClass =
  "rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[10.5px] font-semibold tracking-[0.03em] text-ink-2 transition-colors hover:border-mute hover:text-ink disabled:cursor-wait disabled:opacity-60";

const inputClass =
  "min-h-[34px] rounded-md border border-line bg-paper px-2.5 font-mono text-[11px] text-ink outline-none focus:border-amber";

async function requestJson(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export function AdminUsersTable({
  initialUsers,
}: AdminUsersTableProps): ReactElement {
  const t = useTranslations("adminUsers");
  const [users, setUsers] = useState(initialUsers);
  const [filter, setFilter] = useState<AccountStatus | "all">("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visibleUsers = useMemo(
    () => users.filter((u) => filter === "all" || u.status === filter),
    [filter, users],
  );

  const reload = async (): Promise<void> => {
    const params = filter === "all" ? "" : `?status=${filter}`;
    const res = await fetch(`/api/admin/users${params}`);

    if (!res.ok) {
      throw new Error(`GET /api/admin/users failed: ${res.status}`);
    }

    const body = (await res.json()) as { users: AdminUserRow[] };

    setUsers(body.users);
  };

  const mutate = async (
    userId: string,
    action: () => Promise<Response>,
  ): Promise<boolean> => {
    setBusyId(userId);
    setError(null);

    try {
      const res = await action();

      if (!res.ok) {
        const body = (await res.json()) as { message?: string };

        throw new Error(body.message ?? `Request failed: ${res.status}`);
      }

      await reload();

      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));

      return false;
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="rounded-[14px] border border-line bg-paper shadow-[var(--shadow-sm)]">
      <div className="flex flex-col gap-3 border-b border-line px-5 py-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em] text-ink">
            {t("tableTitle")}
          </h2>
          <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
            {t("tableSub")}
          </p>
        </div>
        <select
          className={inputClass}
          value={filter}
          onChange={(event) =>
            setFilter(event.target.value as AccountStatus | "all")
          }
        >
          <option value="all">{t("filterAll")}</option>
          <option value="pending">{t("status.pending")}</option>
          <option value="active">{t("status.active")}</option>
          <option value="disabled">{t("status.disabled")}</option>
        </select>
      </div>

      {error ? (
        <div className="border-b border-line bg-[#fff3f0] px-5 py-3 text-[12.5px] text-[#b5332b]">
          {error}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead className="border-b border-line bg-ivory">
            <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
              <th className="px-5 py-3">{t("user")}</th>
              <th className="px-4 py-3">{t("statusLabel")}</th>
              <th className="px-4 py-3">{t("roleLabel")}</th>
              <th className="px-4 py-3">{t("password")}</th>
              <th className="px-4 py-3">{t("created")}</th>
              <th className="px-5 py-3">{t("actions")}</th>
            </tr>
          </thead>
          <tbody>
            {visibleUsers.map((user) => (
              <UserRow
                key={user.id}
                busy={busyId === user.id}
                mutate={mutate}
                t={t}
                user={user}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UserRow({
  busy,
  mutate,
  t,
  user,
}: {
  busy: boolean;
  mutate: (userId: string, action: () => Promise<Response>) => Promise<boolean>;
  t: ReturnType<typeof useTranslations>;
  user: AdminUserRow;
}): ReactElement {
  const [password, setPassword] = useState("");
  const [mustChangePassword, setMustChangePassword] = useState(true);

  const setStatus = (status: "active" | "disabled") =>
    mutate(user.id, () =>
      requestJson(`/api/admin/users/${user.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    );

  const setRole = (role: GlobalRole) =>
    mutate(user.id, () =>
      requestJson(`/api/admin/users/${user.id}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    );

  const resetPassword = () =>
    mutate(user.id, () =>
      requestJson(`/api/admin/users/${user.id}/password-reset`, {
        method: "POST",
        body: JSON.stringify({ password, mustChangePassword }),
      }),
    ).then((ok) => {
      if (ok) {
        setPassword("");
      }
    });

  return (
    <tr className="border-b border-line align-top last:border-b-0">
      <td className="px-5 py-4">
        <div className="font-semibold text-ink">{user.name ?? user.email}</div>
        <div className="mt-1 font-mono text-[10.5px] tracking-[0.03em] text-mute">
          {user.email}
        </div>
      </td>
      <td className="px-4 py-4">
        <span
          className={clsx(
            "rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em]",
            user.status === "active" &&
              "border-[color-mix(in_oklab,var(--good)_35%,var(--line))] bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good",
            user.status === "pending" &&
              "border-amber-line bg-amber-soft text-amber",
            user.status === "disabled" && "border-line bg-ivory text-mute",
          )}
        >
          {t(`status.${user.status}`)}
        </span>
      </td>
      <td className="px-4 py-4">
        <select
          className={inputClass}
          disabled={busy}
          value={user.role}
          onChange={(event) => setRole(event.target.value as GlobalRole)}
        >
          <option value="viewer">{t("role.viewer")}</option>
          <option value="member">{t("role.member")}</option>
          <option value="admin">{t("role.admin")}</option>
        </select>
      </td>
      <td className="px-4 py-4">
        <div className="flex min-w-[230px] flex-col gap-2">
          <input
            className={inputClass}
            minLength={12}
            placeholder={t("passwordPlaceholder")}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <label className="flex items-center gap-2 text-[12px] text-mute">
            <input
              checked={mustChangePassword}
              type="checkbox"
              onChange={(event) => setMustChangePassword(event.target.checked)}
            />
            {t("forceChange")}
          </label>
          <button
            className={buttonClass}
            disabled={busy || password.length < 12}
            type="button"
            onClick={resetPassword}
          >
            {t("resetPassword")}
          </button>
        </div>
      </td>
      <td className="px-4 py-4 font-mono text-[10.5px] text-mute">
        {new Date(user.createdAt).toLocaleDateString()}
      </td>
      <td className="px-5 py-4">
        <div className="flex min-w-[170px] flex-wrap gap-2">
          {user.status !== "active" ? (
            <button
              className={buttonClass}
              disabled={busy}
              type="button"
              onClick={() => setStatus("active")}
            >
              {t("activate")}
            </button>
          ) : null}
          {user.status !== "disabled" ? (
            <button
              className={buttonClass}
              disabled={busy}
              type="button"
              onClick={() => setStatus("disabled")}
            >
              {t("disable")}
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
