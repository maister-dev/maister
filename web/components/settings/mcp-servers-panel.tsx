"use client";

import type { ReactElement } from "react";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  McpServerModal,
  type McpServerRow,
} from "@/components/settings/mcp-server-modal";
import { PanelSection } from "@/components/settings/panel-section";

export type { McpServerRow };

type Props = {
  servers: McpServerRow[];
};

function readinessClass(status: string): string {
  if (status === "Ready") return "border-emerald-500/30 text-emerald-700";
  if (status === "NotReady") return "border-red-500/30 text-red-700";

  return "border-line text-mute";
}

export function McpServersPanel({ servers }: Props): ReactElement {
  const t = useTranslations("settings");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<McpServerRow | null>(null);

  const refresh = (): void => startTransition(() => router.refresh());

  return (
    <PanelSection
      actions={
        <button
          className="h-10 rounded-[8px] border border-amber bg-amber px-4 text-[13px] font-semibold text-white hover:bg-amber-2"
          type="button"
          onClick={() => setCreating(true)}
        >
          {t("addMcp")}
        </button>
      }
      title={t("mcpServersTitle")}
    >
      {servers.length === 0 ? (
        <p className="m-0 text-[12px] leading-[1.5] text-mute">
          {t("mcpEmpty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead className="border-b border-line bg-ivory">
              <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
                <th className="px-4 py-3">{t("colId")}</th>
                <th className="px-4 py-3">{t("colTransport")}</th>
                <th className="px-4 py-3">{t("colTarget")}</th>
                <th className="px-4 py-3">{t("colAgents")}</th>
                <th className="px-4 py-3">{t("colReadiness")}</th>
                <th className="px-4 py-3">{t("colEnabled")}</th>
                <th className="px-4 py-3 text-right">{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr
                  key={server.id}
                  className="border-b border-line align-middle text-[12px] last:border-b-0"
                >
                  <td className="px-4 py-3 font-mono font-semibold text-ink">
                    {server.id}
                  </td>
                  <td className="px-4 py-3 text-ink-2">{server.transport}</td>
                  <td className="px-4 py-3 font-mono text-ink-2">
                    {server.transport === "stdio"
                      ? (server.command ?? "-")
                      : (server.url ?? "-")}
                  </td>
                  <td className="px-4 py-3 text-ink-2">
                    {server.supportedAgents.join(", ")}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${readinessClass(
                        server.readinessStatus,
                      )}`}
                    >
                      {server.readinessStatus}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink-2">
                    {server.enabled ? "✓" : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink"
                      type="button"
                      onClick={() => setEditing(server)}
                    >
                      {t("editAction")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating || editing ? (
        <McpServerModal
          mode={editing ? "edit" : "create"}
          server={editing ?? undefined}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={refresh}
        />
      ) : null}
    </PanelSection>
  );
}
