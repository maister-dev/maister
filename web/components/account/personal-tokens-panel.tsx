"use client";

import type { TokenScope } from "@/types/token-scopes";
import type { ReactElement } from "react";

import { CheckIcon, PencilSquareIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";

import { EXACT_ONLY_TOKEN_SCOPES, TOKEN_SCOPE_ALL } from "@/types/token-scopes";
import {
  toggleScopeForEdit,
  USER_TOKEN_SCOPE_VALUES,
} from "@/components/board/token-actions";
import { isManagedTokenRow } from "@/lib/tokens/managed-row";
import { useModalA11y } from "@/components/use-modal-a11y";

type PersonalTokenDto = {
  id: string;
  name: string;
  kind: "user";
  ownerUserId: string;
  scopes: string[];
  humanHitl: boolean;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type PersonalTokensPanelProps = {
  tokens: PersonalTokenDto[];
};

type ScopeOption = { value: TokenScope; labelKey: string };

// `tasks:read` -> `scopeLabels.tasksRead`, `agent_memory:write` ->
// `scopeLabels.agentMemoryWrite`. Derived rather than mapped by hand so a new
// scope cannot be added to the vocabulary and silently skipped by the picker.
function scopeLabelKey(scope: TokenScope): string {
  if (scope === TOKEN_SCOPE_ALL) return "scopeLabels.all";

  const camel = scope
    .split(":")
    .flatMap((part) => part.split("_"))
    .map((part, i) => (i === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join("");

  return `scopeLabels.${camel}`;
}

// The picker is the human-manageable vocabulary: every scope a person may grant
// MINUS the machine-only evaluator set (already excluded by
// USER_TOKEN_SCOPE_VALUES) and minus the exact-only human scope, which this
// surface grants through its own checkbox. Previously a hand-maintained list of
// 22, it had drifted 8 scopes behind — including `flows:read` and
// `runners:read`, the very grants ADR-168 exists to let an operator add after
// issuance.
const SCOPE_OPTIONS: ScopeOption[] = USER_TOKEN_SCOPE_VALUES.filter(
  (scope) => !EXACT_ONLY_TOKEN_SCOPES.has(scope),
).map((value) => ({ value, labelKey: scopeLabelKey(value) }));

function formatDate(value: string | null, emptyLabel: string): string {
  if (value === null) return emptyLabel;

  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function tokenStatus(
  token: PersonalTokenDto,
): "active" | "revoked" | "expired" {
  if (token.revokedAt !== null) return "revoked";
  if (
    token.expiresAt !== null &&
    new Date(token.expiresAt).getTime() < Date.now()
  ) {
    return "expired";
  }

  return "active";
}

function toggleScope(
  selected: TokenScope[],
  // The picker never offers the exact-only human scope — it has its own
  // checkbox — so this stays the broad vocabulary.
  scope: TokenScope,
): TokenScope[] {
  if (scope === "*") return ["*"];

  const withoutAll = selected.filter((item) => item !== "*");

  if (withoutAll.includes(scope)) {
    const next = withoutAll.filter((item) => item !== scope);

    return next.length > 0 ? next : ["*"];
  }

  return [...withoutAll, scope];
}

function toLocalInputValue(value: string | null): string {
  if (value === null) return "";

  const d = new Date(value);
  const pad = (n: number): string => String(n).padStart(2, "0");

  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function scopeLabel(
  t: ReturnType<typeof useTranslations<"account.personalTokens">>,
  scope: string,
): string {
  return t(scopeLabelKey(scope as TokenScope));
}

function scopesText(
  t: ReturnType<typeof useTranslations<"account.personalTokens">>,
  scopes: readonly string[],
): string {
  return scopes.map((scope) => scopeLabel(t, scope)).join(", ");
}

export function PersonalTokensPanel({
  tokens,
}: PersonalTokensPanelProps): ReactElement {
  const t = useTranslations("account.personalTokens");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [items, setItems] = useState(tokens);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [scopes, setScopes] = useState<TokenScope[]>(["hitl:inbox:read"]);
  const [humanHitl, setHumanHitl] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PersonalTokenDto | null>(null);
  const [editName, setEditName] = useState("");
  const [editScopes, setEditScopes] = useState<TokenScope[]>([]);
  const [editHumanHitl, setEditHumanHitl] = useState(false);
  const [editExpiresAt, setEditExpiresAt] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const createDialogRef = useRef<HTMLDivElement>(null);
  const editDialogRef = useRef<HTMLDivElement>(null);

  // Both dialogs carried aria-modal="true" and nothing else, so the row's
  // destructive Revoke button stayed in the tab order behind them.
  useModalA11y(createDialogRef, closeCreate, createOpen);
  useModalA11y(editDialogRef, closeEdit, editing !== null);

  async function createToken(): Promise<void> {
    setBusy(true);
    setError(null);
    setSecret(null);

    try {
      const res = await fetch("/api/account/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          scopes,
          humanHitl,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });

      if (!res.ok) {
        setError(t("errors.generic"));

        return;
      }

      const created = (await res.json()) as PersonalTokenDto & {
        token: string;
      };

      setItems((current) => [created, ...current]);
      setSecret(created.token);
      setName("");
      setExpiresAt("");
      setScopes(["hitl:inbox:read"]);
      setHumanHitl(false);
      startTransition(() => router.refresh());
    } catch {
      setError(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  function closeCreate(): void {
    setCreateOpen(false);
    setSecret(null);
    setCopied(false);
    setError(null);
  }

  function openEdit(token: PersonalTokenDto): void {
    setEditing(token);
    setEditName(token.name);
    // The stored exact human scope rides its own checkbox on this surface, so
    // it is never a member of the picker's selection.
    setEditScopes(
      token.scopes.filter(
        (scope) => scope !== "hitl:respond:human",
      ) as TokenScope[],
    );
    setEditHumanHitl(token.humanHitl);
    setEditExpiresAt(toLocalInputValue(token.expiresAt));
    setError(null);
  }

  function closeEdit(): void {
    setEditing(null);
    setError(null);
  }

  async function saveEdit(): Promise<void> {
    if (editing === null) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/account/tokens/${editing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          scopes: editScopes,
          humanHitl: editHumanHitl,
          expiresAt: editExpiresAt
            ? new Date(editExpiresAt).toISOString()
            : null,
        }),
      });

      if (!res.ok) {
        setError(t("errors.generic"));

        return;
      }

      const updated = (await res.json()) as PersonalTokenDto;

      setItems((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setEditing(null);
      setSavedId(updated.id);
      setTimeout(() => setSavedId(null), 2000);
      startTransition(() => router.refresh());
    } catch {
      setError(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(tokenId: string): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/account/tokens/${tokenId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        setError(t("errors.generic"));

        return;
      }

      const revokedAt = new Date().toISOString();

      setItems((current) =>
        current.map((item) =>
          item.id === tokenId ? { ...item, revokedAt } : item,
        ),
      );
      startTransition(() => router.refresh());
    } catch {
      setError(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  async function copySecret(): Promise<void> {
    if (secret === null) return;

    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t("errors.copy"));
    }
  }

  return (
    <section className="rounded-[14px] border border-line bg-paper p-6 shadow-[var(--shadow-sm)]">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em] text-ink">
            {t("title")}
          </h2>
          <p className="m-0 text-[12.5px] leading-[1.5] text-mute">
            {t("sub")}
          </p>
        </div>
        <button
          className="w-max rounded-full bg-amber px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-8px_var(--amber)] transition-all hover:-translate-y-px hover:bg-amber-2"
          type="button"
          onClick={() => setCreateOpen(true)}
        >
          {t("actions.new")}
        </button>
      </div>

      <div className="overflow-x-auto rounded-[10px] border border-line">
        <table className="min-w-[920px] w-full border-collapse text-left text-[12px]">
          <thead className="bg-ivory text-[10px] uppercase tracking-[0.08em] text-mute">
            <tr>
              <th className="px-3 py-2 font-semibold">{t("columns.name")}</th>
              <th className="px-3 py-2 font-semibold">{t("columns.scopes")}</th>
              <th className="px-3 py-2 font-semibold">{t("columns.human")}</th>
              <th className="px-3 py-2 font-semibold">{t("columns.prefix")}</th>
              <th className="px-3 py-2 font-semibold">{t("columns.status")}</th>
              <th className="px-3 py-2 font-semibold">
                {t("columns.created")}
              </th>
              <th className="px-3 py-2 font-semibold">
                {t("columns.lastUsed")}
              </th>
              <th className="px-3 py-2 font-semibold">
                {t("columns.expires")}
              </th>
              <th className="px-3 py-2 font-semibold">
                {t("columns.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-mute" colSpan={9}>
                  {t("empty")}
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const emptyDate = t("emptyDate");
                const status = tokenStatus(item);
                const revoked = status === "revoked";

                return (
                  <tr key={item.id} className="border-t border-line">
                    <td className="px-3 py-3 font-medium text-ink">
                      {item.name}
                    </td>
                    <td className="max-w-[220px] px-3 py-3 text-mute">
                      {scopesText(t, item.scopes)}
                    </td>
                    <td className="px-3 py-3 text-mute">
                      {item.humanHitl
                        ? t("human.enabled")
                        : t("human.disabled")}
                    </td>
                    <td className="px-3 py-3 font-mono text-mute">
                      {item.prefix}
                    </td>
                    <td className="px-3 py-3 text-mute">
                      {t(`status.${status}`)}
                    </td>
                    <td className="px-3 py-3 text-mute">
                      {formatDate(item.createdAt, emptyDate)}
                    </td>
                    <td className="px-3 py-3 text-mute">
                      {formatDate(item.lastUsedAt, emptyDate)}
                    </td>
                    <td className="px-3 py-3 text-mute">
                      {formatDate(item.expiresAt, emptyDate)}
                    </td>
                    <td className="px-3 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        {savedId === item.id ? (
                          <span
                            aria-label={t("actions.saved")}
                            className="grid h-8 w-8 place-items-center text-emerald-600"
                            role="status"
                            title={t("actions.saved")}
                          >
                            <CheckIcon aria-hidden="true" className="h-4 w-4" />
                          </span>
                        ) : !revoked && isManagedTokenRow(item) ? (
                          <button
                            aria-label={t("actions.edit")}
                            className="grid h-8 w-8 place-items-center rounded-full border border-line text-ink transition-colors hover:border-mute disabled:opacity-50"
                            disabled={busy}
                            title={t("actions.edit")}
                            type="button"
                            onClick={() => openEdit(item)}
                          >
                            <PencilSquareIcon
                              aria-hidden="true"
                              className="h-4 w-4"
                            />
                          </button>
                        ) : null}
                        <button
                          className="rounded-full border border-line px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute transition-colors hover:border-mute hover:text-ink disabled:opacity-50"
                          disabled={busy || revoked}
                          type="button"
                          onClick={() => void revokeToken(item.id)}
                        >
                          {t("actions.revoke")}
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {createOpen ? (
        <div
          ref={createDialogRef}
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          role="dialog"
        >
          <form
            className="flex max-h-[90vh] w-full max-w-[520px] flex-col gap-3 overflow-y-auto rounded-[14px] border border-line bg-ivory p-5 shadow-[0_24px_80px_-30px_rgba(25,20,14,0.55)]"
            onSubmit={(event) => {
              event.preventDefault();
              void createToken();
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <h3 className="m-0 text-[16px] font-semibold text-ink">
                {t("create.title")}
              </h3>
              <button
                className="rounded-full border border-line px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink"
                type="button"
                onClick={closeCreate}
              >
                {t("actions.close")}
              </button>
            </div>
            {secret ? (
              <div className="flex flex-col gap-2 rounded-lg border border-amber-line bg-paper p-3">
                <p className="m-0 text-[12px] font-semibold text-amber">
                  {t("secret.warning")}
                </p>
                <code className="break-all rounded-md bg-ivory px-2 py-1.5 font-mono text-[12px] text-ink">
                  {secret}
                </code>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="w-max rounded-full border border-line px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink"
                    type="button"
                    onClick={() => void copySecret()}
                  >
                    {copied ? t("actions.copied") : t("actions.copy")}
                  </button>
                  <button
                    className="w-max rounded-full bg-amber px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-white hover:bg-amber-2"
                    type="button"
                    onClick={closeCreate}
                  >
                    {t("actions.done")}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute">
                    {t("create.name")}
                  </span>
                  <input
                    className="rounded-[10px] border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-amber"
                    maxLength={120}
                    placeholder={t("create.namePlaceholder")}
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute">
                    {t("create.expires")}
                  </span>
                  <input
                    className="rounded-[10px] border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-amber"
                    type="datetime-local"
                    value={expiresAt}
                    onChange={(event) => setExpiresAt(event.target.value)}
                  />
                </label>
                <fieldset className="flex flex-col gap-2">
                  <legend className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute">
                    {t("create.scopes")}
                  </legend>
                  <div className="grid max-h-[260px] gap-2 overflow-y-auto pr-1">
                    {SCOPE_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] text-ink-2"
                      >
                        <input
                          checked={scopes.includes(option.value)}
                          type="checkbox"
                          onChange={() =>
                            setScopes((current) =>
                              toggleScope(current, option.value),
                            )
                          }
                        />
                        <span>{t(option.labelKey)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="flex items-center gap-2 rounded-lg border border-amber-line bg-amber-soft px-3 py-2 text-[12px] text-ink-2">
                  <input
                    checked={humanHitl}
                    type="checkbox"
                    onChange={(event) => setHumanHitl(event.target.checked)}
                  />
                  <span>{t("create.humanHitl")}</span>
                </label>
                <button
                  className="rounded-full bg-amber px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-8px_var(--amber)] transition-all hover:-translate-y-px hover:bg-amber-2 disabled:opacity-60"
                  disabled={busy}
                  type="submit"
                >
                  {busy ? t("actions.saving") : t("actions.create")}
                </button>
                {error ? (
                  <p className="m-0 text-[12px] text-[#d9534f]">{error}</p>
                ) : null}
              </>
            )}
          </form>
        </div>
      ) : null}

      {editing !== null ? (
        <div
          ref={editDialogRef}
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          role="dialog"
        >
          <form
            className="flex max-h-[90vh] w-full max-w-[520px] flex-col gap-3 overflow-y-auto rounded-[14px] border border-line bg-ivory p-5 shadow-[0_24px_80px_-30px_rgba(25,20,14,0.55)]"
            onSubmit={(event) => {
              event.preventDefault();
              void saveEdit();
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <h3 className="m-0 text-[16px] font-semibold text-ink">
                {t("edit.title")}
              </h3>
              <button
                className="rounded-full border border-line px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink"
                type="button"
                onClick={closeEdit}
              >
                {t("actions.close")}
              </button>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute">
                {t("create.name")}
              </span>
              <input
                className="rounded-[10px] border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-amber"
                maxLength={120}
                placeholder={t("create.namePlaceholder")}
                type="text"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute">
                {t("create.expires")}
              </span>
              <input
                className="rounded-[10px] border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-amber"
                type="datetime-local"
                value={editExpiresAt}
                onChange={(event) => setEditExpiresAt(event.target.value)}
              />
            </label>
            <fieldset className="flex flex-col gap-2">
              <legend className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute">
                {t("create.scopes")}
              </legend>
              <div className="grid max-h-[260px] gap-2 overflow-y-auto pr-1">
                {SCOPE_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] text-ink-2"
                  >
                    <input
                      checked={editScopes.includes(option.value)}
                      type="checkbox"
                      onChange={() =>
                        setEditScopes((current) =>
                          toggleScopeForEdit(current, option.value),
                        )
                      }
                    />
                    <span>{t(option.labelKey)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {editScopes.length === 0 ? (
              <p aria-live="polite" className="m-0 text-[12px] text-amber">
                {t("edit.scopesRequired")}
              </p>
            ) : null}
            <label className="flex items-center gap-2 rounded-lg border border-amber-line bg-amber-soft px-3 py-2 text-[12px] text-ink-2">
              <input
                checked={editHumanHitl}
                type="checkbox"
                onChange={(event) => setEditHumanHitl(event.target.checked)}
              />
              <span>{t("create.humanHitl")}</span>
            </label>
            <button
              className="rounded-full bg-amber px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-8px_var(--amber)] transition-all hover:-translate-y-px hover:bg-amber-2 disabled:opacity-60"
              disabled={
                busy || editName.trim() === "" || editScopes.length === 0
              }
              type="submit"
            >
              {busy ? t("actions.saving") : t("actions.save")}
            </button>
            {error ? (
              <p className="m-0 text-[12px] text-[#d9534f]">{error}</p>
            ) : null}
          </form>
        </div>
      ) : null}
    </section>
  );
}
