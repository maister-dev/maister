"use client";

import type { ReactElement } from "react";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  ProjectMcpModal,
  type ProjectMcpRow,
} from "@/components/board/panels/mcp-modal";

export type { ProjectMcpRow };

// ADR-129 (W-D): a derived requirement + its satisfaction classification.
export type McpRequirement = {
  refId: string;
  classification: "bound" | "auto" | "unbound" | "misconfigured" | "not_ready";
};

export interface McpPanelProps {
  servers: ProjectMcpRow[];
  requirements?: McpRequirement[];
  slug: string;
  isAdmin: boolean;
}

function classBadgeClass(c: McpRequirement["classification"]): string {
  if (c === "bound" || c === "auto")
    return "border-emerald-500/30 text-emerald-700";
  if (c === "not_ready") return "border-amber/40 text-amber-2";

  return "border-red-500/30 text-red-700";
}

export function McpPanel({
  servers,
  requirements = [],
  slug,
  isAdmin,
}: McpPanelProps): ReactElement {
  const t = useTranslations("mcpPanel");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProjectMcpRow | null>(null);

  const refresh = (): void => startTransition(() => router.refresh());

  // ADR-129 (W-D): drive the supervisor health probe for a bound ref.
  const testConnection = (refId: string): void => {
    startTransition(async () => {
      await fetch(`/api/projects/${encodeURIComponent(slug)}/mcp/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refId }),
      });
      router.refresh();
    });
  };

  return (
    <section>
      {requirements.length > 0 ? (
        <div className="mb-6" data-testid="mcp-requirements">
          <h3 className="m-0 mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-mute">
            {t("requirements")}
          </h3>
          <ul className="m-0 flex flex-col gap-1.5 p-0">
            {requirements.map((req) => (
              <li
                key={req.refId}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-paper px-3 py-2"
                data-testid={`mcp-req-${req.refId}`}
              >
                <span className="font-mono text-[12px] font-semibold text-ink">
                  {req.refId}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${classBadgeClass(
                    req.classification,
                  )}`}
                >
                  {t(`classification.${req.classification}`)}
                </span>
                {isAdmin &&
                (req.classification === "bound" ||
                  req.classification === "auto") ? (
                  <button
                    className="ml-auto h-7 rounded-[8px] border border-line px-2.5 text-[11px] font-semibold text-ink-2 hover:border-amber"
                    type="button"
                    onClick={() => testConnection(req.refId)}
                  >
                    {t("testConnection")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {t("title")}
        </h2>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10.5px] tracking-[0.02em] text-mute">
            {t("count", { count: servers.length })}
          </span>
          {isAdmin ? (
            <button
              className="rounded-lg border border-amber bg-amber px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2"
              type="button"
              onClick={() => setCreating(true)}
            >
              {t("add")}
            </button>
          ) : null}
        </div>
      </div>

      {!isAdmin ? (
        <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute">
          {t("adminOnly")}
        </p>
      ) : servers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute">
          {t("empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-paper">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-mute">
                <th className="px-4 py-3">{t("colId")}</th>
                <th className="px-4 py-3">{t("colTransport")}</th>
                <th className="px-4 py-3">{t("colTarget")}</th>
                <th className="px-4 py-3">{t("colAgents")}</th>
                <th className="px-4 py-3">{t("colEnabled")}</th>
                <th className="px-4 py-3 text-right">{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr
                  key={server.id}
                  className="border-b border-line-soft align-middle text-[12px] last:border-b-0"
                >
                  <td className="px-4 py-3 font-mono font-semibold text-ink">
                    {server.mcpId}
                  </td>
                  <td className="px-4 py-3 text-ink-2">{server.transport}</td>
                  <td className="px-4 py-3 font-mono text-ink-2">
                    {server.transport === "stdio"
                      ? (server.command ?? "—")
                      : (server.url ?? "—")}
                  </td>
                  <td className="px-4 py-3 text-ink-2">
                    {server.supportedAgents.join(", ")}
                  </td>
                  <td className="px-4 py-3 text-ink-2">
                    {server.enabled ? "✓" : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink hover:border-mute"
                      type="button"
                      onClick={() => setEditing(server)}
                    >
                      {t("edit")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating || editing ? (
        <ProjectMcpModal
          mode={editing ? "edit" : "create"}
          server={editing ?? undefined}
          slug={slug}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={refresh}
        />
      ) : null}
    </section>
  );
}
