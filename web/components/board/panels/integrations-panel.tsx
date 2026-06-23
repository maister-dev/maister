import type { TokenAuditEntry } from "@/lib/tokens/audit-list";
import type { TokenListItem } from "@/lib/tokens/list";
import type { ReactElement, ReactNode } from "react";

import { getTranslations } from "next-intl/server";

import {
  TokenAuditTable,
  type TokenAuditLabels,
} from "@/components/board/panels/token-audit-table";
import {
  CreateTokenModal,
  RevokeTokenButton,
} from "@/components/board/token-actions";

export {
  TokenSecretReveal,
  type TokenSecretRevealProps,
} from "@/components/board/token-actions";

export type TokenStatus = "active" | "revoked" | "expired";

export function tokenDisplayStatus(item: TokenListItem): TokenStatus {
  if (item.revokedAt != null) return "revoked";

  if (item.expiresAt != null && item.expiresAt.getTime() < Date.now()) {
    return "expired";
  }

  return "active";
}

export interface TokenLabels {
  title: string;
  empty: string;
  adminOnly: string;
  create: string;
  createTitle: string;
  nameLabel: string;
  namePlaceholder: string;
  expiresLabel: string;
  kindLabel: string;
  kindProject: string;
  kindUser: string;
  scopesLabel: string;
  cancel: string;
  confirm: string;
  secretTitle: string;
  secretWarning: string;
  copy: string;
  copied: string;
  revoke: string;
  revokeConfirm: string;
  colName: string;
  colKind: string;
  colScopes: string;
  colPrefix: string;
  colStatus: string;
  colCreated: string;
  colLastUsed: string;
  colExpires: string;
  statusActive: string;
  statusRevoked: string;
  statusExpired: string;
  scopeAll: string;
  scopeTasksCreate: string;
  scopeTasksRead: string;
  scopeTasksUpdate: string;
  scopeRunsLaunch: string;
  scopeRunsRead: string;
  scopeReadinessRead: string;
  scopeGatesReport: string;
  scopeHitlRead: string;
  scopeHitlRespond: string;
  scopeHitlInboxRead: string;
  scopeHitlRespondHuman: string;
  scopeCommentsRead: string;
  scopeCommentsCreate: string;
  scopeTasksTriage: string;
  scopeRelationsRead: string;
  scopeRelationsCreate: string;
  scopeRelationsDelete: string;
  scopeAgentsTrigger: string;
  scopeRunsDelegate: string;
  scopeRunsCollect: string;
  scopeRunsCancel: string;
  scopeRunsPromote: string;
  errorGeneric: string;
}

function statusLabel(labels: TokenLabels, status: TokenStatus): string {
  if (status === "revoked") return labels.statusRevoked;
  if (status === "expired") return labels.statusExpired;

  return labels.statusActive;
}

function statusTone(status: TokenStatus): string {
  if (status === "active") return "border-amber-line bg-amber-soft text-amber";

  return "border-line bg-paper text-mute";
}

function formatDate(value: Date | null): string {
  if (!value) return "—";

  return value.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function tokenKindLabel(labels: TokenLabels, token: TokenListItem): string {
  return token.kind === "user" ? labels.kindUser : labels.kindProject;
}

function scopeLabel(labels: TokenLabels, scope: string): string {
  switch (scope) {
    case "*":
      return labels.scopeAll;
    case "tasks:create":
      return labels.scopeTasksCreate;
    case "tasks:read":
      return labels.scopeTasksRead;
    case "tasks:update":
      return labels.scopeTasksUpdate;
    case "runs:launch":
      return labels.scopeRunsLaunch;
    case "runs:read":
      return labels.scopeRunsRead;
    case "readiness:read":
      return labels.scopeReadinessRead;
    case "gates:report":
      return labels.scopeGatesReport;
    case "hitl:read":
      return labels.scopeHitlRead;
    case "hitl:respond":
      return labels.scopeHitlRespond;
    case "hitl:inbox:read":
      return labels.scopeHitlInboxRead;
    case "hitl:respond:human":
      return labels.scopeHitlRespondHuman;
    case "comments:read":
      return labels.scopeCommentsRead;
    case "comments:create":
      return labels.scopeCommentsCreate;
    case "tasks:triage":
      return labels.scopeTasksTriage;
    case "relations:read":
      return labels.scopeRelationsRead;
    case "relations:create":
      return labels.scopeRelationsCreate;
    case "relations:delete":
      return labels.scopeRelationsDelete;
    case "agents:trigger":
      return labels.scopeAgentsTrigger;
    case "runs:delegate":
      return labels.scopeRunsDelegate;
    case "runs:collect":
      return labels.scopeRunsCollect;
    case "runs:cancel":
      return labels.scopeRunsCancel;
    case "runs:promote":
      return labels.scopeRunsPromote;
    default:
      return scope;
  }
}

function scopesLabel(labels: TokenLabels, scopes: string[]): string {
  if (scopes.includes("*")) return labels.scopeAll;

  return scopes.map((scope) => scopeLabel(labels, scope)).join(", ");
}

export interface TokensTableProps {
  labels: TokenLabels;
  tokens: TokenListItem[];
  isAdmin: boolean;
  createSlot?: ReactNode;
  renderRevoke?: (token: TokenListItem) => ReactNode;
}

export function TokensTable({
  labels,
  tokens,
  isAdmin,
  createSlot,
  renderRevoke,
}: TokensTableProps): ReactElement {
  const create =
    createSlot ??
    (isAdmin ? (
      <button
        className="rounded-lg border border-amber bg-amber px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2"
        type="button"
      >
        {labels.create}
      </button>
    ) : null);

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {labels.title}
        </h2>
        {isAdmin ? create : null}
      </div>

      {!isAdmin ? (
        <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute">
          {labels.adminOnly}
        </p>
      ) : tokens.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute">
          {labels.empty}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-paper">
          <table className="w-full min-w-[920px] border-collapse">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-mute">
                <th className="px-4 py-3">{labels.colName}</th>
                <th className="px-4 py-3">{labels.colKind}</th>
                <th className="px-4 py-3">{labels.colScopes}</th>
                <th className="px-4 py-3">{labels.colPrefix}</th>
                <th className="px-4 py-3">{labels.colStatus}</th>
                <th className="px-4 py-3">{labels.colCreated}</th>
                <th className="px-4 py-3">{labels.colLastUsed}</th>
                <th className="px-4 py-3">{labels.colExpires}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => {
                const status = tokenDisplayStatus(token);

                return (
                  <tr
                    key={token.id}
                    className="border-b border-line-soft last:border-b-0 font-mono text-[11px] text-ink-2"
                  >
                    <td className="px-4 py-3 font-semibold text-ink">
                      {token.name}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-semibold text-ink-2">
                        {tokenKindLabel(labels, token)}
                      </span>
                      {token.kind === "user" && token.ownerLabel ? (
                        <span className="mt-1 block max-w-[180px] truncate text-[10px] text-mute">
                          {token.ownerLabel}
                        </span>
                      ) : null}
                    </td>
                    <td className="max-w-[260px] px-4 py-3 text-mute">
                      {scopesLabel(labels, token.scopes)}
                    </td>
                    <td className="px-4 py-3 text-mute">{token.prefix}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full border px-[7px] py-[3px] text-[9px] font-bold uppercase tracking-[0.08em] ${statusTone(status)}`}
                      >
                        {statusLabel(labels, status)}
                      </span>
                    </td>
                    <td
                      suppressHydrationWarning
                      className="px-4 py-3 tabular-nums text-mute"
                    >
                      {formatDate(token.createdAt)}
                    </td>
                    <td
                      suppressHydrationWarning
                      className="px-4 py-3 tabular-nums text-mute"
                    >
                      {formatDate(token.lastUsedAt)}
                    </td>
                    <td
                      suppressHydrationWarning
                      className="px-4 py-3 tabular-nums text-mute"
                    >
                      {formatDate(token.expiresAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isAdmin && status === "active"
                        ? (renderRevoke?.(token) ?? (
                            <button
                              aria-label={labels.revoke}
                              className="rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2"
                              type="button"
                            >
                              {labels.revoke}
                            </button>
                          ))
                        : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export interface IntegrationsPanelProps {
  tokens: TokenListItem[];
  slug: string;
  isAdmin: boolean;
  audit?: {
    rows: TokenAuditEntry[];
    total: number;
    page: number;
    pageSize: number;
    filters: { tokenId?: string; result?: "ok" | "error" };
    tokenOptions: Array<{ id: string; name: string }>;
  } | null;
}

export async function IntegrationsPanel({
  tokens,
  slug,
  isAdmin,
  audit,
}: IntegrationsPanelProps): Promise<ReactElement> {
  const t = await getTranslations("tokens");

  const labels: TokenLabels = {
    title: t("title"),
    empty: t("empty"),
    adminOnly: t("adminOnly"),
    create: t("create"),
    createTitle: t("createTitle"),
    nameLabel: t("nameLabel"),
    namePlaceholder: t("namePlaceholder"),
    expiresLabel: t("expiresLabel"),
    kindLabel: t("kindLabel"),
    kindProject: t("kindProject"),
    kindUser: t("kindUser"),
    scopesLabel: t("scopesLabel"),
    cancel: t("cancel"),
    confirm: t("confirm"),
    secretTitle: t("secretTitle"),
    secretWarning: t("secretWarning"),
    copy: t("copy"),
    copied: t("copied"),
    revoke: t("revoke"),
    revokeConfirm: t("revokeConfirm"),
    colName: t("colName"),
    colKind: t("colKind"),
    colScopes: t("colScopes"),
    colPrefix: t("colPrefix"),
    colStatus: t("colStatus"),
    colCreated: t("colCreated"),
    colLastUsed: t("colLastUsed"),
    colExpires: t("colExpires"),
    statusActive: t("statusActive"),
    statusRevoked: t("statusRevoked"),
    statusExpired: t("statusExpired"),
    scopeAll: t("scopeAll"),
    scopeTasksCreate: t("scopeTasksCreate"),
    scopeTasksRead: t("scopeTasksRead"),
    scopeTasksUpdate: t("scopeTasksUpdate"),
    scopeRunsLaunch: t("scopeRunsLaunch"),
    scopeRunsRead: t("scopeRunsRead"),
    scopeReadinessRead: t("scopeReadinessRead"),
    scopeGatesReport: t("scopeGatesReport"),
    scopeHitlRead: t("scopeHitlRead"),
    scopeHitlRespond: t("scopeHitlRespond"),
    scopeHitlInboxRead: t("scopeHitlInboxRead"),
    scopeHitlRespondHuman: t("scopeHitlRespondHuman"),
    scopeCommentsRead: t("scopeCommentsRead"),
    scopeCommentsCreate: t("scopeCommentsCreate"),
    scopeTasksTriage: t("scopeTasksTriage"),
    scopeRelationsRead: t("scopeRelationsRead"),
    scopeRelationsCreate: t("scopeRelationsCreate"),
    scopeRelationsDelete: t("scopeRelationsDelete"),
    scopeAgentsTrigger: t("scopeAgentsTrigger"),
    scopeRunsDelegate: t("scopeRunsDelegate"),
    scopeRunsCollect: t("scopeRunsCollect"),
    scopeRunsCancel: t("scopeRunsCancel"),
    scopeRunsPromote: t("scopeRunsPromote"),
    errorGeneric: t("errorGeneric"),
  };

  const auditLabels: TokenAuditLabels = {
    title: t("audit.title"),
    description: t("audit.description"),
    empty: t("audit.empty"),
    colWhen: t("audit.colWhen"),
    colToken: t("audit.colToken"),
    colMethod: t("audit.colMethod"),
    colEndpoint: t("audit.colEndpoint"),
    colScope: t("audit.colScope"),
    colResult: t("audit.colResult"),
    colStatus: t("audit.colStatus"),
    filterToken: t("audit.filterToken"),
    filterResult: t("audit.filterResult"),
    filterAny: t("audit.filterAny"),
    resultOk: t("audit.resultOk"),
    resultError: t("audit.resultError"),
    apply: t("audit.apply"),
    pagePrev: t("audit.pagePrev"),
    pageNext: t("audit.pageNext"),
    // Raw template: TokenAuditTable interpolates {page}/{pages} itself, so the
    // server must not format it eagerly.
    pageInfo: t.raw("audit.pageInfo"),
  };

  return (
    <>
      <TokensTable
        createSlot={
          isAdmin ? <CreateTokenModal labels={labels} slug={slug} /> : null
        }
        isAdmin={isAdmin}
        labels={labels}
        renderRevoke={(token) => (
          <RevokeTokenButton labels={labels} slug={slug} tokenId={token.id} />
        )}
        tokens={tokens}
      />
      {isAdmin && audit ? (
        <TokenAuditTable
          filters={audit.filters}
          labels={auditLabels}
          page={audit.page}
          pageSize={audit.pageSize}
          rows={audit.rows}
          slug={slug}
          tokenOptions={audit.tokenOptions}
          total={audit.total}
        />
      ) : null}
    </>
  );
}
