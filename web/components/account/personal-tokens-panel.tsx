"use client";

import type { TokenScope } from "@/types/token-scopes";
import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

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

type ScopeOption = {
  value: Exclude<TokenScope, "hitl:respond:human">;
  labelKey: string;
};

const SCOPE_OPTIONS: ScopeOption[] = [
  { value: "*", labelKey: "scopeLabels.all" },
  { value: "hitl:inbox:read", labelKey: "scopeLabels.hitlInboxRead" },
  { value: "tasks:read", labelKey: "scopeLabels.tasksRead" },
  { value: "tasks:create", labelKey: "scopeLabels.tasksCreate" },
  { value: "tasks:update", labelKey: "scopeLabels.tasksUpdate" },
  { value: "runs:read", labelKey: "scopeLabels.runsRead" },
  { value: "runs:launch", labelKey: "scopeLabels.runsLaunch" },
  { value: "readiness:read", labelKey: "scopeLabels.readinessRead" },
  { value: "hitl:read", labelKey: "scopeLabels.hitlRead" },
  { value: "hitl:respond", labelKey: "scopeLabels.hitlRespond" },
  { value: "comments:read", labelKey: "scopeLabels.commentsRead" },
  { value: "comments:create", labelKey: "scopeLabels.commentsCreate" },
  { value: "tasks:triage", labelKey: "scopeLabels.tasksTriage" },
  { value: "relations:read", labelKey: "scopeLabels.relationsRead" },
  { value: "relations:create", labelKey: "scopeLabels.relationsCreate" },
  { value: "relations:delete", labelKey: "scopeLabels.relationsDelete" },
  { value: "agents:trigger", labelKey: "scopeLabels.agentsTrigger" },
  { value: "runs:delegate", labelKey: "scopeLabels.runsDelegate" },
  { value: "runs:collect", labelKey: "scopeLabels.runsCollect" },
  { value: "runs:cancel", labelKey: "scopeLabels.runsCancel" },
  { value: "runs:promote", labelKey: "scopeLabels.runsPromote" },
];

function formatDate(value: string | null, emptyLabel: string): string {
  if (value === null) return emptyLabel;

  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function tokenStatus(token: PersonalTokenDto): "active" | "revoked" | "expired" {
  if (token.revokedAt !== null) return "revoked";
  if (token.expiresAt !== null && new Date(token.expiresAt).getTime() < Date.now()) {
    return "expired";
  }

  return "active";
}

function toggleScope(
  selected: TokenScope[],
  scope: Exclude<TokenScope, "hitl:respond:human">,
): TokenScope[] {
  if (scope === "*") return ["*"];

  const withoutAll = selected.filter((item) => item !== "*");

  if (withoutAll.includes(scope)) {
    const next = withoutAll.filter((item) => item !== scope);

    return next.length > 0 ? next : ["*"];
  }

  return [...withoutAll, scope];
}

function scopeLabel(
  t: ReturnType<typeof useTranslations<"account.personalTokens">>,
  scope: string,
): string {
  switch (scope) {
    case "*":
      return t("scopeLabels.all");
    case "tasks:create":
      return t("scopeLabels.tasksCreate");
    case "tasks:read":
      return t("scopeLabels.tasksRead");
    case "tasks:update":
      return t("scopeLabels.tasksUpdate");
    case "tasks:triage":
      return t("scopeLabels.tasksTriage");
    case "runs:launch":
      return t("scopeLabels.runsLaunch");
    case "runs:read":
      return t("scopeLabels.runsRead");
    case "readiness:read":
      return t("scopeLabels.readinessRead");
    case "gates:report":
      return t("scopeLabels.gatesReport");
    case "hitl:read":
      return t("scopeLabels.hitlRead");
    case "hitl:respond":
      return t("scopeLabels.hitlRespond");
    case "hitl:inbox:read":
      return t("scopeLabels.hitlInboxRead");
    case "hitl:respond:human":
      return t("scopeLabels.hitlRespondHuman");
    case "comments:read":
      return t("scopeLabels.commentsRead");
    case "comments:create":
      return t("scopeLabels.commentsCreate");
    case "relations:read":
      return t("scopeLabels.relationsRead");
    case "relations:create":
      return t("scopeLabels.relationsCreate");
    case "relations:delete":
      return t("scopeLabels.relationsDelete");
    case "agents:trigger":
      return t("scopeLabels.agentsTrigger");
    case "runs:delegate":
      return t("scopeLabels.runsDelegate");
    case "runs:collect":
      return t("scopeLabels.runsCollect");
    case "runs:cancel":
      return t("scopeLabels.runsCancel");
    case "runs:promote":
      return t("scopeLabels.runsPromote");
    default:
      return scope;
  }
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
              <th className="px-3 py-2 font-semibold">
                {t("columns.scopes")}
              </th>
              <th className="px-3 py-2 font-semibold">
                {t("columns.human")}
              </th>
              <th className="px-3 py-2 font-semibold">
                {t("columns.prefix")}
              </th>
              <th className="px-3 py-2 font-semibold">
                {t("columns.status")}
              </th>
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
                        {item.humanHitl ? t("human.enabled") : t("human.disabled")}
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
                        <button
                          className="rounded-full border border-line px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute transition-colors hover:border-mute hover:text-ink disabled:opacity-50"
                          disabled={busy || revoked}
                          type="button"
                          onClick={() => void revokeToken(item.id)}
                        >
                          {t("actions.revoke")}
                        </button>
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
    </section>
  );
}
