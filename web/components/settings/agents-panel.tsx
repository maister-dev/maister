"use client";

import type { ReactElement } from "react";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  AgentModal,
  type AgentSummaryRow,
} from "@/components/settings/agent-modal";

export type { AgentSummaryRow };

type Props = {
  agents: AgentSummaryRow[];
  runners: Array<{ id: string }>;
  projects: Array<{ id: string; slug: string; name: string }>;
};

async function sendJson(
  url: string,
  method: string,
  body?: unknown,
): Promise<void> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;

    throw new Error(payload?.message ?? `request failed: ${response.status}`);
  }
}

// M34 (ADR-089 D11): the platform agent catalog — view-only table, edits in
// the modal, quarantine surfaced inline, manual launch per row.
export function AgentsPanel({
  agents,
  runners,
  projects,
}: Props): ReactElement {
  const t = useTranslations("agents");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [launchProject, setLaunchProject] = useState(projects[0]?.slug ?? "");
  const [launchNote, setLaunchNote] = useState<string | null>(null);

  const refresh = (): void => startTransition(() => router.refresh());

  async function act(key: string, fn: () => Promise<void>): Promise<void> {
    setPending(key);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function launch(agentId: string): Promise<void> {
    setPending(agentId);
    setError(null);
    setLaunchNote(null);
    try {
      const response = await fetch(
        `/api/projects/${launchProject}/agents/${agentId}/launch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const payload = (await response.json().catch(() => null)) as {
        runId?: string;
        status?: string;
        message?: string;
      } | null;

      if (!response.ok) {
        throw new Error(
          payload?.message ?? `request failed: ${response.status}`,
        );
      }

      setLaunchNote(`${t("launched")} ${payload?.runId ?? ""}`.trim());
      setLaunchingId(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="mt-6 border-t border-line pt-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="m-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("title")}
        </h3>
        <div className="flex items-center gap-2">
          <button
            className="h-10 rounded-[8px] border border-line px-4 text-[13px] font-semibold text-ink disabled:opacity-50"
            disabled={pending !== null}
            type="button"
            onClick={() =>
              void act("resync", () =>
                sendJson("/api/admin/agents/resync", "POST"),
              )
            }
          >
            {t("resync")}
          </button>
          <button
            className="h-10 rounded-[8px] border border-amber bg-amber px-4 text-[13px] font-semibold text-white hover:bg-amber-2"
            type="button"
            onClick={() => setCreating(true)}
          >
            {t("addAgent")}
          </button>
        </div>
      </div>
      {error ? (
        <p
          className="m-0 mb-3 text-[12px] leading-[1.45] text-red-700"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {launchNote ? (
        <p
          aria-live="polite"
          className="m-0 mb-3 text-[12px] leading-[1.45] text-emerald-700"
        >
          {launchNote}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] border-collapse text-left">
          <thead className="border-b border-line bg-ivory">
            <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
              <th className="px-4 py-3">{t("colId")}</th>
              <th className="px-4 py-3">{t("colScope")}</th>
              <th className="px-4 py-3">{t("colRunner")}</th>
              <th className="px-4 py-3">{t("colWorkspace")}</th>
              <th className="px-4 py-3">{t("colMode")}</th>
              <th className="px-4 py-3">{t("colTriggers")}</th>
              <th className="px-4 py-3">{t("colRisk")}</th>
              <th className="px-4 py-3">{t("colState")}</th>
              <th className="px-4 py-3 text-right">{t("colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {agents.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-[12px] text-mute" colSpan={9}>
                  {t("empty")}
                </td>
              </tr>
            ) : null}
            {agents.map((agent) => (
              <tr
                key={agent.id}
                className="border-b border-line align-middle text-[12px] last:border-b-0"
              >
                <td className="px-4 py-3 font-mono font-semibold text-ink">
                  {agent.id}
                </td>
                <td className="px-4 py-3 text-ink-2">{agent.scope}</td>
                <td className="px-4 py-3 font-mono text-ink-2">
                  {agent.runnerId ?? "—"}
                </td>
                <td className="px-4 py-3 text-ink-2">{agent.workspace}</td>
                <td className="px-4 py-3 text-ink-2">{agent.mode}</td>
                <td className="px-4 py-3 font-mono text-[11px] text-ink-2">
                  {agent.triggers.join(", ")}
                </td>
                <td className="px-4 py-3 text-ink-2">{agent.riskTier}</td>
                <td className="px-4 py-3">
                  {agent.quarantinedAt ? (
                    <span
                      className="rounded-full border border-red-500/30 px-2 py-1 text-[11px] font-semibold text-red-700"
                      title={agent.quarantineReason ?? undefined}
                    >
                      {t("quarantined")}
                    </span>
                  ) : agent.enabled ? (
                    <span className="rounded-full border border-emerald-500/30 px-2 py-1 text-[11px] font-semibold text-emerald-700">
                      {t("enabled")}
                    </span>
                  ) : (
                    <span className="rounded-full border border-line px-2 py-1 text-[11px] font-semibold text-mute">
                      {t("disabled")}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex flex-wrap items-center justify-end gap-2">
                    {launchingId === agent.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <select
                          aria-label={t("launchProject")}
                          className="h-8 rounded-[8px] border border-line bg-paper px-2 text-[12px] text-ink outline-none"
                          value={launchProject}
                          onChange={(event) =>
                            setLaunchProject(event.target.value)
                          }
                        >
                          {projects.map((project) => (
                            <option key={project.id} value={project.slug}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                        <button
                          className="h-8 rounded-[8px] border border-amber bg-amber px-3 text-[12px] font-semibold text-white disabled:opacity-50"
                          disabled={pending !== null || launchProject === ""}
                          type="button"
                          onClick={() => void launch(agent.id)}
                        >
                          {t("go")}
                        </button>
                        <button
                          className="h-8 rounded-[8px] border border-line px-2 text-[12px] text-ink"
                          type="button"
                          onClick={() => setLaunchingId(null)}
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <button
                        className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                        disabled={
                          pending !== null ||
                          !agent.enabled ||
                          agent.quarantinedAt !== null ||
                          projects.length === 0
                        }
                        type="button"
                        onClick={() => setLaunchingId(agent.id)}
                      >
                        {t("launch")}
                      </button>
                    )}
                    {agent.quarantinedAt ? (
                      <button
                        className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                        disabled={pending !== null}
                        type="button"
                        onClick={() =>
                          void act(agent.id, () =>
                            sendJson(`/api/admin/agents/${agent.id}`, "PATCH", {
                              unquarantine: true,
                            }),
                          )
                        }
                      >
                        {t("unquarantine")}
                      </button>
                    ) : null}
                    <button
                      className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                      disabled={pending !== null}
                      type="button"
                      onClick={() =>
                        void act(agent.id, () =>
                          sendJson(`/api/admin/agents/${agent.id}`, "PATCH", {
                            enabled: !agent.enabled,
                          }),
                        )
                      }
                    >
                      {agent.enabled ? t("disable") : t("enable")}
                    </button>
                    <button
                      className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                      type="button"
                      onClick={() => setEditingId(agent.id)}
                    >
                      {t("edit")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating || editingId ? (
        <AgentModal
          editingId={editingId}
          projects={projects}
          runners={runners}
          onClose={() => {
            setCreating(false);
            setEditingId(null);
          }}
          onSaved={refresh}
        />
      ) : null}
    </section>
  );
}
