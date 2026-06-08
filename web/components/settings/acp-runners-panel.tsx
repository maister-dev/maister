"use client";

import type { ReactElement } from "react";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  AcpRunnerModal,
  type PresetRow as ModalPresetRow,
  type RunnerRow,
} from "@/components/settings/acp-runner-modal";

export type { RunnerRow };

type PresetRow = ModalPresetRow & {
  readinessStatus: "Ready" | "NotReady";
  readinessReasons: readonly string[];
};

type Props = {
  defaultRunnerId: string | null;
  presets: PresetRow[];
  runners: RunnerRow[];
  sidecars: { id: string }[];
};

function statusClass(status: RunnerRow["readinessStatus"]): string {
  if (status === "Ready") return "border-emerald-500/30 text-emerald-700";
  if (status === "NotReady") return "border-red-500/30 text-red-700";

  return "border-line text-mute";
}

async function patchJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;

    throw new Error(payload?.message ?? `request failed: ${response.status}`);
  }
}

export function AcpRunnersPanel({
  defaultRunnerId,
  presets,
  runners,
  sidecars,
}: Props): ReactElement {
  const t = useTranslations("settings");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selectedDefaultRunnerId, setSelectedDefaultRunnerId] = useState(
    defaultRunnerId ?? runners[0]?.id ?? "",
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RunnerRow | null>(null);

  const refresh = (): void => startTransition(() => router.refresh());
  const defaultRunner = runners.find(
    (runner) => runner.id === selectedDefaultRunnerId,
  );

  async function saveDefaultRunner(): Promise<void> {
    setPending("default");
    setError(null);
    try {
      await patchJson("/api/admin/acp-runners", {
        defaultRunnerId: selectedDefaultRunnerId,
      });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function setRunnerEnabled(
    runnerId: string,
    enabled: boolean,
  ): Promise<void> {
    setPending(runnerId);
    setError(null);
    try {
      await patchJson(`/api/admin/acp-runners/${runnerId}`, { enabled });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="mt-6 border-t border-line pt-6">
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[260px] flex-1 flex-col gap-1.5">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
              {t("platformDefaultRunner")}
            </span>
            <select
              className="h-10 rounded-[8px] border border-line bg-paper px-3 text-[13px] text-ink outline-none"
              value={selectedDefaultRunnerId}
              onChange={(event) =>
                setSelectedDefaultRunnerId(event.target.value)
              }
            >
              {runners.map((runner) => (
                <option
                  key={runner.id}
                  disabled={
                    !runner.enabled || runner.readinessStatus !== "Ready"
                  }
                  value={runner.id}
                >
                  {runner.id}
                </option>
              ))}
            </select>
          </label>
          <button
            className="h-10 rounded-[8px] border border-line bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-50"
            disabled={
              pending !== null ||
              !defaultRunner ||
              !defaultRunner.enabled ||
              defaultRunner.readinessStatus !== "Ready" ||
              selectedDefaultRunnerId === defaultRunnerId
            }
            type="button"
            onClick={() => void saveDefaultRunner()}
          >
            {t("save")}
          </button>
          <button
            className="h-10 rounded-[8px] border border-amber bg-amber px-4 text-[13px] font-semibold text-white hover:bg-amber-2"
            type="button"
            onClick={() => setCreating(true)}
          >
            {t("addRunner")}
          </button>
        </div>
        {error ? (
          <p className="m-0 text-[12px] leading-[1.45] text-red-700">{error}</p>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left">
          <thead className="border-b border-line bg-ivory">
            <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
              <th className="px-4 py-3">{t("colId")}</th>
              <th className="px-4 py-3">{t("colAdapter")}</th>
              <th className="px-4 py-3">{t("colModel")}</th>
              <th className="px-4 py-3">{t("colProvider")}</th>
              <th className="px-4 py-3">{t("colSidecar")}</th>
              <th className="px-4 py-3">{t("colPolicy")}</th>
              <th className="px-4 py-3">{t("colReadiness")}</th>
              <th className="px-4 py-3">{t("colEnabled")}</th>
              <th className="px-4 py-3 text-right">{t("colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {runners.map((runner) => (
              <tr
                key={runner.id}
                className="border-b border-line align-middle last:border-b-0 text-[12px]"
              >
                <td className="px-4 py-3 font-mono font-semibold text-ink">
                  {runner.id}
                </td>
                <td className="px-4 py-3 text-ink-2">{runner.adapter}</td>
                <td className="px-4 py-3 font-mono text-ink-2">
                  {runner.model}
                </td>
                <td className="px-4 py-3 text-ink-2">{runner.provider.kind}</td>
                <td className="px-4 py-3 text-ink-2">
                  {runner.sidecarId ?? "-"}
                </td>
                <td className="px-4 py-3 text-ink-2">
                  {runner.permissionPolicy}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${statusClass(
                      runner.readinessStatus,
                    )}`}
                  >
                    {runner.readinessStatus}
                  </span>
                </td>
                <td className="px-4 py-3 text-ink-2">
                  {runner.enabled ? "✓" : "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-2">
                    <button
                      className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                      type="button"
                      onClick={() => setEditing(runner)}
                    >
                      {t("editAction")}
                    </button>
                    <button
                      className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                      disabled={
                        pending !== null ||
                        (runner.id === defaultRunnerId && runner.enabled)
                      }
                      type="button"
                      onClick={() =>
                        void setRunnerEnabled(runner.id, !runner.enabled)
                      }
                    >
                      {runner.enabled ? t("disable") : t("enable")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 border-t border-line pt-4">
        <h3 className="m-0 mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("providerPresets")}
        </h3>
        <div className="grid gap-2">
          {presets.map((preset) => (
            <article
              key={preset.id}
              className="rounded-[8px] border border-line bg-paper px-3 py-2"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-semibold text-ink">
                    {preset.id}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-[1.4] text-mute">
                    {preset.adapter} · {preset.model} · {preset.provider.kind}
                    {preset.permissionPolicy === "dangerously_skip_permissions"
                      ? " · dangerous"
                      : ""}
                  </div>
                </div>
                <span
                  className={`rounded-full border px-2 py-1 text-[10.5px] font-semibold ${statusClass(
                    preset.readinessStatus,
                  )}`}
                >
                  {preset.readinessStatus}
                </span>
              </div>
              {preset.readinessReasons.length > 0 ? (
                <ul className="m-0 mt-1.5 list-none p-0 text-[11px] leading-[1.45] text-mute">
                  {preset.readinessReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      </div>

      {creating || editing ? (
        <AcpRunnerModal
          mode={editing ? "edit" : "create"}
          presets={presets}
          runner={editing ?? undefined}
          sidecars={sidecars}
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
