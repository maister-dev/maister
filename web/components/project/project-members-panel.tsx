"use client";

import type { ProjectRole } from "@/lib/db/schema";
import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import clsx from "clsx";

export interface ProjectMemberSerialised {
  addedBy: string | null;
  createdAt: string;
  email: string;
  memberId: string;
  name: string | null;
  role: ProjectRole;
  userId: string;
}

export interface ProjectMembersPanelProps {
  canManage: boolean;
  members: ProjectMemberSerialised[];
  selfUserId: string;
  slug: string;
}

const inputClass =
  "min-h-[34px] rounded-md border border-line bg-paper px-2.5 font-mono text-[11px] text-ink outline-none focus:border-amber";

const badgeBase =
  "rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em]";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

function roleLabel(
  t: ReturnType<typeof useTranslations>,
  role: ProjectRole,
): string {
  if (role === "owner") return t("roleOwner");
  if (role === "admin") return t("roleAdmin");
  if (role === "member") return t("roleMember");

  return t("roleViewer");
}

// ─── Shared dialog hook ──────────────────────────────────────────────────────

function useDialog(onClose: () => void): {
  dialogRef: React.RefObject<HTMLDivElement | null>;
} {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];

    focusable()[0]?.focus();

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();

        return;
      }

      if (event.key !== "Tab") return;

      const items = focusable();

      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, []);

  return { dialogRef };
}

// ─── Remove confirm dialog ────────────────────────────────────────────────────

interface RemoveDialogProps {
  member: ProjectMemberSerialised;
  slug: string;
  onClose: () => void;
  onSaved: () => void;
}

function RemoveDialog({
  member,
  slug,
  onClose,
  onSaved,
}: RemoveDialogProps): ReactElement {
  const t = useTranslations("projectMembers");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { dialogRef } = useDialog(onClose);

  async function handleRemove(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/projects/${slug}/members/${member.memberId}`,
        { method: "DELETE" },
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
          message?: string;
        } | null;
        const code = body?.code;

        if (code === "CONFLICT") {
          setError(t("alreadyMember"));
        } else {
          setError(body?.message ?? t("lastError"));
        }

        return;
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("lastError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={t("cancel")}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="remove-member-title"
        aria-modal="true"
        className="relative flex w-full max-w-[440px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2
            className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
            id="remove-member-title"
          >
            {t("remove")}
          </h2>
          <button
            aria-label={t("cancel")}
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-5">
          <p className="text-[13px] leading-[1.5] text-mute">
            {t("removeConfirm")}
          </p>
          <p className="mt-1 font-mono text-[11.5px] font-semibold text-ink">
            {member.name ?? member.email}
          </p>
          {error ? (
            <div
              aria-live="assertive"
              className="mt-3 rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
              role="alert"
            >
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          <button
            className="touch-manipulation rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            className={clsx(
              "touch-manipulation rounded-lg border border-[#b5332b]/40 bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-[#b5332b] hover:border-[#b5332b] hover:bg-[#b5332b]/5",
              busy && "opacity-60",
            )}
            disabled={busy}
            type="button"
            onClick={() => void handleRemove()}
          >
            {busy ? t("saving") : t("remove")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Role change dialog ───────────────────────────────────────────────────────

interface RoleDialogProps {
  member: ProjectMemberSerialised;
  slug: string;
  onClose: () => void;
  onSaved: () => void;
}

const ROLES: ProjectRole[] = ["owner", "admin", "member", "viewer"];

function RoleDialog({
  member,
  slug,
  onClose,
  onSaved,
}: RoleDialogProps): ReactElement {
  const t = useTranslations("projectMembers");
  const [role, setRole] = useState<ProjectRole>(member.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { dialogRef } = useDialog(onClose);

  async function handleSave(): Promise<void> {
    if (role === member.role) {
      onClose();

      return;
    }

    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/projects/${slug}/members/${member.memberId}`,
        {
          body: JSON.stringify({ role }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
          message?: string;
        } | null;
        const code = body?.code;

        if (code === "CONFLICT") {
          setError(t("alreadyMember"));
        } else if (code === "PRECONDITION") {
          setError(body?.message ?? t("lastError"));
        } else {
          setError(body?.message ?? t("lastError"));
        }

        return;
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("lastError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={t("cancel")}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="role-dialog-title"
        aria-modal="true"
        className="relative flex w-full max-w-[440px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2
              className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
              id="role-dialog-title"
            >
              {t("changeRole")}
            </h2>
            <div className="mt-0.5 truncate font-mono text-[10.5px] tracking-[0.03em] text-mute">
              {member.name ?? member.email}
            </div>
          </div>
          <button
            aria-label={t("cancel")}
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-5">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("roleLabel")}</span>
            <select
              className={inputClass}
              disabled={busy}
              value={role}
              onChange={(e) => setRole(e.target.value as ProjectRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(t, r)}
                </option>
              ))}
            </select>
          </label>
          {error ? (
            <div
              aria-live="assertive"
              className="mt-3 rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
              role="alert"
            >
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          <button
            className="touch-manipulation rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            className={clsx(
              "touch-manipulation rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2",
              (busy || role === member.role) && "opacity-60",
            )}
            disabled={busy || role === member.role}
            type="button"
            onClick={() => void handleSave()}
          >
            {busy ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add member dialog ────────────────────────────────────────────────────────

interface Candidate {
  email: string;
  id: string;
  name: string | null;
}

interface AddDialogProps {
  slug: string;
  onClose: () => void;
  onSaved: () => void;
}

function AddDialog({ slug, onClose, onSaved }: AddDialogProps): ReactElement {
  const t = useTranslations("projectMembers");
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [role, setRole] = useState<ProjectRole>("member");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { dialogRef } = useDialog(onClose);

  useEffect(() => {
    if (q.trim().length < 2) {
      setCandidates([]);

      return;
    }

    const handle = setTimeout(() => {
      setSearching(true);
      fetch(
        `/api/projects/${slug}/members/candidates?q=${encodeURIComponent(q.trim())}`,
      )
        .then((r) => r.json() as Promise<{ candidates: Candidate[] }>)
        .then((data) => {
          setCandidates(data.candidates ?? []);
        })
        .catch(() => {
          setCandidates([]);
        })
        .finally(() => {
          setSearching(false);
        });
    }, 300);

    return () => clearTimeout(handle);
  }, [q, slug]);

  async function handleAdd(): Promise<void> {
    if (!selected) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${slug}/members`, {
        body: JSON.stringify({ role, userId: selected.id }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
          message?: string;
        } | null;
        const code = body?.code;

        if (code === "CONFLICT") {
          setError(t("alreadyMember"));
        } else if (code === "PRECONDITION") {
          setError(body?.message ?? t("lastError"));
        } else {
          setError(body?.message ?? t("lastError"));
        }

        return;
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("lastError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={t("cancel")}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="add-member-title"
        aria-modal="true"
        className="relative flex w-full max-w-[480px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2
            className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
            id="add-member-title"
          >
            {t("addMember")}
          </h2>
          <button
            aria-label={t("cancel")}
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5">
          {selected ? (
            <div className="flex items-center justify-between rounded-lg border border-line bg-ivory px-3 py-2">
              <div>
                <div className="font-semibold text-[13px] text-ink">
                  {selected.name ?? selected.email}
                </div>
                <div className="font-mono text-[10.5px] tracking-[0.03em] text-mute">
                  {selected.email}
                </div>
              </div>
              <button
                className="font-mono text-[12px] text-mute hover:text-ink"
                type="button"
                onClick={() => {
                  setSelected(null);
                  setQ("");
                }}
              >
                ✕
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>
                  {t("searchPlaceholder").replace("…", "")}
                </span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  placeholder={t("searchPlaceholder")}
                  spellCheck={false}
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </label>
              {searching ? (
                <div className="font-mono text-[10.5px] text-mute">…</div>
              ) : q.trim().length >= 2 && candidates.length === 0 ? (
                <div className="font-mono text-[10.5px] text-mute">
                  {t("noCandidates")}
                </div>
              ) : (
                <ul className="flex list-none flex-col gap-px p-0">
                  {candidates.map((c) => (
                    <li key={c.id}>
                      <button
                        className="w-full rounded-lg border border-transparent px-3 py-2 text-left hover:border-line hover:bg-ivory"
                        type="button"
                        onClick={() => {
                          setSelected(c);
                          setQ("");
                          setCandidates([]);
                        }}
                      >
                        <div className="font-semibold text-[12.5px] text-ink">
                          {c.name ?? c.email}
                        </div>
                        <div className="font-mono text-[10.5px] tracking-[0.03em] text-mute">
                          {c.email}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("roleLabel")}</span>
            <select
              className={inputClass}
              disabled={busy}
              value={role}
              onChange={(e) => setRole(e.target.value as ProjectRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(t, r)}
                </option>
              ))}
            </select>
          </label>

          {error ? (
            <div
              aria-live="assertive"
              className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
              role="alert"
            >
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          <button
            className="touch-manipulation rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            className={clsx(
              "touch-manipulation rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2",
              (!selected || busy) && "opacity-60",
            )}
            disabled={!selected || busy}
            type="button"
            onClick={() => void handleAdd()}
          >
            {busy ? t("saving") : t("addMember")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function ProjectMembersPanel({
  canManage,
  members,
  selfUserId,
  slug,
}: ProjectMembersPanelProps): ReactElement {
  const t = useTranslations("projectMembers");
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editingRole, setEditingRole] =
    useState<ProjectMemberSerialised | null>(null);
  const [removing, setRemoving] = useState<ProjectMemberSerialised | null>(
    null,
  );

  function onSaved(): void {
    router.refresh();
  }

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
            {t("title")}
          </h2>
          <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
            {t("sub")}
          </p>
        </div>
        {canManage ? (
          <button
            className="shrink-0 touch-manipulation rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2"
            type="button"
            onClick={() => setAdding(true)}
          >
            {t("addMember")}
          </button>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left">
          <thead className="border-b border-line bg-ivory">
            <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
              <th className="px-5 py-3">{t("title").split(" ")[0]}</th>
              <th className="px-4 py-3">{t("roleLabel")}</th>
              <th className="px-4 py-3">{t("joined")}</th>
              {canManage ? <th className="px-5 py-3 text-right" /> : null}
            </tr>
          </thead>
          <tbody>
            {members.length === 0 ? (
              <tr>
                <td
                  className="px-5 py-8 text-center font-mono text-[11.5px] text-mute"
                  colSpan={canManage ? 4 : 3}
                >
                  {t("noMembers")}
                </td>
              </tr>
            ) : (
              members.map((m) => (
                <tr
                  key={m.memberId}
                  className="border-b border-line align-middle last:border-b-0"
                >
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <div className="max-w-[240px] truncate font-semibold text-ink">
                        {m.name ?? m.email}
                      </div>
                      {m.userId === selfUserId ? (
                        <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-mute">
                          {t("you")}
                        </span>
                      ) : null}
                    </div>
                    <div className="max-w-[240px] truncate font-mono text-[10.5px] tracking-[0.03em] text-mute">
                      {m.email}
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    <span
                      className={clsx(
                        badgeBase,
                        "border-line bg-ivory text-ink-2",
                      )}
                    >
                      {roleLabel(t, m.role)}
                    </span>
                  </td>
                  <td
                    suppressHydrationWarning
                    className="px-4 py-3.5 font-mono text-[10.5px] tabular-nums text-mute"
                  >
                    {new Date(m.createdAt).toLocaleDateString(undefined, {
                      dateStyle: "medium",
                    })}
                  </td>
                  {canManage ? (
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          aria-label={`${t("changeRole")} · ${m.name ?? m.email}`}
                          className="touch-manipulation rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10.5px] font-semibold tracking-[0.03em] text-ink-2 transition-colors hover:border-mute hover:text-ink"
                          type="button"
                          onClick={() => setEditingRole(m)}
                        >
                          {t("changeRole")}
                        </button>
                        <button
                          aria-label={`${t("remove")} · ${m.name ?? m.email}`}
                          className="touch-manipulation rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10.5px] font-semibold tracking-[0.03em] text-[#b5332b] transition-colors hover:border-[#b5332b]/40"
                          type="button"
                          onClick={() => setRemoving(m)}
                        >
                          {t("remove")}
                        </button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {adding ? (
        <AddDialog
          slug={slug}
          onClose={() => setAdding(false)}
          onSaved={onSaved}
        />
      ) : null}

      {editingRole ? (
        <RoleDialog
          member={editingRole}
          slug={slug}
          onClose={() => setEditingRole(null)}
          onSaved={onSaved}
        />
      ) : null}

      {removing ? (
        <RemoveDialog
          member={removing}
          slug={slug}
          onClose={() => setRemoving(null)}
          onSaved={onSaved}
        />
      ) : null}
    </section>
  );
}
