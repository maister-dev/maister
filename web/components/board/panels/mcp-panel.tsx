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

export interface McpPanelProps {
  servers: ProjectMcpRow[];
  slug: string;
  isAdmin: boolean;
}

export function McpPanel({
  servers,
  slug,
  isAdmin,
}: McpPanelProps): ReactElement {
  const t = useTranslations("mcpPanel");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProjectMcpRow | null>(null);

  const refresh = (): void => startTransition(() => router.refresh());

  return (
    <section>
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
