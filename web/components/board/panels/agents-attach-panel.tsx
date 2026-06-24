"use client";

import type { ReactElement } from "react";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  AttachEditModal,
  sendJson,
} from "@/components/board/panels/agents-attach-edit-modal";

export type AttachScheduleView = {
  triggerType: "cron" | "event";
  cronExpr?: string;
  timezone?: string;
  eventKinds?: string[];
  enabled: boolean;
};

export type AutoApplyMode = "off" | "permissions" | "full";
export type OnBudgetBreachMode =
  | "escalate"
  | "terminate"
  | "terminate_restorable";

// (ADR-106) Instance runner-policy override projection (the AgentRunnerPolicy
// `{autoApply, onBudgetBreach}` shape). Each field unset → inherit the agent
// `recommended`, then the project/platform default.
export type ExecutionPolicyOverrideView = {
  autoApply?: AutoApplyMode;
  onBudgetBreach?: OnBudgetBreachMode;
};

// (ADR-106) Package-recommended bindings — seed the attach/edit modal and act
// as the inherit fallback when an instance leaves a field unset.
export type AgentRecommendedView = {
  runner?: string;
  branchBase?: string;
  cron?: { expr: string; timezone: string };
  events?: string[];
  executionPolicy?: ExecutionPolicyOverrideView;
};

export type AttachedAgentRow = {
  linkId: string;
  enabled: boolean;
  runnerOverrideId: string | null;
  // (ADR-106) Per-instance overrides; null → inherit the agent `recommended`.
  branchBase: string | null;
  executionPolicyOverride: ExecutionPolicyOverrideView | null;
  schedules: AttachScheduleView[];
  agent: {
    id: string;
    name: string;
    packageName: string;
    workspace: string;
    mode: string;
    triggers: string[];
    riskTier: string;
    enabled: boolean;
    quarantinedAt: string | null;
    recommended: AgentRecommendedView | null;
  };
};

export type AvailableAgentRow = {
  id: string;
  name: string;
  packageName: string;
  // RD5: package-recommended bindings — pre-fill the attach modal; nothing
  // applies without Save.
  recommended: AgentRecommendedView | null;
};

type Props = {
  slug: string;
  canManage: boolean;
  attached: AttachedAgentRow[];
  available: AvailableAgentRow[];
  runners: Array<{ id: string; label: string }>;
  eventKinds: string[];
};

function scheduleSummary(schedules: AttachScheduleView[]): string {
  if (schedules.length === 0) return "—";

  return schedules
    .map((s) =>
      s.triggerType === "cron"
        ? `cron ${s.cronExpr ?? "?"}`
        : `event ${(s.eventKinds ?? []).join("|")}`,
    )
    .join(" · ");
}

// (ADR-106) Terse view-only summary of the per-instance policy overrides; "—"
// when every field inherits. Editing happens in the modal (view-only table).
function policySummary(row: AttachedAgentRow): string {
  const parts: string[] = [];

  if (row.branchBase) parts.push(row.branchBase);
  if (row.executionPolicyOverride?.autoApply) {
    parts.push(`auto:${row.executionPolicyOverride.autoApply}`);
  }
  if (row.executionPolicyOverride?.onBudgetBreach) {
    parts.push(`budget:${row.executionPolicyOverride.onBudgetBreach}`);
  }

  return parts.length > 0 ? parts.join(" · ") : "—";
}

// M34 (ADR-089 D11): the per-project attach panel — links CRUD, runner
// override, cron + domain-event trigger bindings.
export function AgentsAttachPanel({
  slug,
  canManage,
  attached,
  available,
  runners,
  eventKinds,
}: Props): ReactElement {
  const t = useTranslations("agentsAttach");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachId, setAttachId] = useState(available[0]?.id ?? "");
  const [editing, setEditing] = useState<AttachedAgentRow | null>(null);
  const [attaching, setAttaching] = useState<AvailableAgentRow | null>(null);

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

  return (
    <section className="rounded-[16px] border border-line bg-paper p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-[15px] font-semibold text-ink">{t("title")}</h2>
        {canManage && available.length > 0 ? (
          <div className="flex items-center gap-2">
            <select
              aria-label={t("attachPicker")}
              className="h-9 rounded-[8px] border border-line bg-paper px-2 text-[12px] text-ink outline-none"
              value={attachId}
              onChange={(event) => setAttachId(event.target.value)}
            >
              {available.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.packageName})
                </option>
              ))}
            </select>
            <button
              className="h-9 rounded-[8px] border border-amber bg-amber px-3 text-[12px] font-semibold text-white disabled:opacity-50"
              disabled={pending !== null || attachId === ""}
              type="button"
              onClick={() => {
                const agent = available.find((a) => a.id === attachId);

                if (agent) setAttaching(agent);
              }}
            >
              {t("attach")}
            </button>
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="m-0 mb-3 text-[12px] text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-left">
          <thead className="border-b border-line bg-ivory">
            <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
              <th className="px-4 py-3">{t("colAgent")}</th>
              <th className="px-4 py-3">{t("colWorkspace")}</th>
              <th className="px-4 py-3">{t("colRunnerOverride")}</th>
              <th className="px-4 py-3">{t("colPolicy")}</th>
              <th className="px-4 py-3">{t("colSchedules")}</th>
              <th className="px-4 py-3">{t("colEnabled")}</th>
              {canManage ? (
                <th className="px-4 py-3 text-right">{t("colActions")}</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {attached.length === 0 ? (
              <tr>
                <td
                  className="px-4 py-6 text-[12px] text-mute"
                  colSpan={canManage ? 7 : 6}
                >
                  {t("empty")}
                </td>
              </tr>
            ) : null}
            {attached.map((row) => (
              <tr
                key={row.linkId}
                className="border-b border-line align-middle text-[12px] last:border-b-0"
              >
                <td className="px-4 py-3">
                  <span className="font-mono font-semibold text-ink">
                    {row.agent.id}
                  </span>
                  {row.agent.quarantinedAt ? (
                    <span className="ml-2 rounded-full border border-red-500/30 px-2 py-0.5 text-[10.5px] font-semibold text-red-700">
                      {t("quarantined")}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-ink-2">
                  {row.agent.workspace} · {row.agent.mode}
                </td>
                <td className="px-4 py-3 font-mono text-ink-2">
                  {row.runnerOverrideId ?? "—"}
                </td>
                <td className="px-4 py-3 font-mono text-[11px] text-ink-2">
                  {policySummary(row)}
                </td>
                <td className="px-4 py-3 font-mono text-[11px] text-ink-2">
                  {scheduleSummary(row.schedules)}
                </td>
                <td className="px-4 py-3 text-ink-2">
                  {row.enabled ? "✓" : "—"}
                </td>
                {canManage ? (
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink"
                        type="button"
                        onClick={() => setEditing(row)}
                      >
                        {t("edit")}
                      </button>
                      <button
                        className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                        disabled={pending !== null}
                        type="button"
                        onClick={() =>
                          void act(row.linkId, () =>
                            sendJson(
                              `/api/projects/${slug}/agents/${row.agent.id}`,
                              "DELETE",
                            ),
                          )
                        }
                      >
                        {t("detach")}
                      </button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing ? (
        <AttachEditModal
          eventKinds={eventKinds}
          row={editing}
          runners={runners}
          slug={slug}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
      {attaching ? (
        <AttachEditModal
          attachAgentId={attaching.id}
          eventKinds={eventKinds}
          row={rowFromAvailable(attaching)}
          runners={runners}
          slug={slug}
          onClose={() => setAttaching(null)}
          onSaved={refresh}
        />
      ) : null}
    </section>
  );
}

// RD5: an attach starts from the package-recommended bindings — runner
// override + one cron row + one event row pre-fill the modal; the user's
// Save applies them (POST attach, then the bindings PATCH).
function rowFromAvailable(agent: AvailableAgentRow): AttachedAgentRow {
  const rec = agent.recommended;

  return {
    linkId: "",
    enabled: true,
    runnerOverrideId: rec?.runner ?? null,
    branchBase: rec?.branchBase ?? null,
    executionPolicyOverride: rec?.executionPolicy ?? null,
    schedules: [
      ...(rec?.cron
        ? [
            {
              triggerType: "cron" as const,
              cronExpr: rec.cron.expr,
              timezone: rec.cron.timezone,
              enabled: true,
            },
          ]
        : []),
      ...(rec?.events && rec.events.length > 0
        ? [
            {
              triggerType: "event" as const,
              eventKinds: rec.events,
              enabled: true,
            },
          ]
        : []),
    ],
    agent: {
      id: agent.id,
      name: agent.name,
      packageName: agent.packageName,
      workspace: "",
      mode: "",
      triggers: [],
      riskTier: "",
      enabled: true,
      quarantinedAt: null,
      recommended: rec,
    },
  };
}
