"use client";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { ReactElement } from "react";

import {
  CheckCircleIcon,
  NoSymbolIcon,
  PencilSquareIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
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
  unavailableAdapters?: readonly AdapterId[];
};

type ReadinessLabels = {
  ready: string;
  notReady: string;
  unknown: string;
  ambient: string;
};

// ADR-094: readiness is shown as a color dot + tooltip, never a hardcoded
// label. A Ready native anthropic/openai runner is only binary-available (no
// credential check), so its tooltip says so rather than an unqualified "Ready".
function statusDot(runner: RunnerRow, labels: ReadinessLabels): ReactElement {
  const { readinessStatus, provider, readinessReasons } = runner;
  const isNativeAmbient =
    readinessStatus === "Ready" &&
    (provider.kind === "anthropic" || provider.kind === "openai");
  const tone =
    readinessStatus === "Ready"
      ? "bg-good"
      : readinessStatus === "NotReady"
        ? "bg-attention"
        : "bg-mute";
  const statusLabel =
    readinessStatus === "Ready"
      ? isNativeAmbient
        ? labels.ambient
        : labels.ready
      : readinessStatus === "NotReady"
        ? labels.notReady
        : labels.unknown;
  const title =
    readinessStatus === "NotReady" && readinessReasons.length > 0
      ? readinessReasons.join("; ")
      : statusLabel;

  return (
    <span
      aria-label={title}
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${tone}`}
      role="img"
      title={title}
    />
  );
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
  unavailableAdapters,
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
  const [usePresetId, setUsePresetId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );

  const refresh = (): void => startTransition(() => router.refresh());
  const defaultRunner = runners.find(
    (runner) => runner.id === selectedDefaultRunnerId,
  );
  const readinessLabels: ReadinessLabels = {
    ready: t("readinessReady"),
    notReady: t("readinessNotReady"),
    unknown: t("readinessUnknown"),
    ambient: t("readinessAmbient"),
  };

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

  async function deleteRunner(runnerId: string): Promise<void> {
    setPending(runnerId);
    setError(null);
    try {
      const res = await fetch(`/api/admin/acp-runners/${runnerId}`, {
        method: "DELETE",
      });

      if (res.status === 204) {
        setConfirmingDeleteId(null);
        refresh();

        return;
      }

      const payload = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;

      // The DELETE usage-guard returns 409 CONFLICT when the runner is still
      // referenced (platform/project/flow default, active run, …) — surface the
      // same explanation the edit-modal delete shows.
      setError(
        payload?.code === "CONFLICT"
          ? `${t("deleteBlockedTitle")}: ${payload.message ?? t("deleteBlockedIntro")}`
          : (payload?.message ?? `request failed: ${res.status}`),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="mt-8 first:mt-0">
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
            onClick={() => {
              setUsePresetId(null);
              setCreating(true);
            }}
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
                  {statusDot(runner, readinessLabels)}
                </td>
                <td className="px-4 py-3 text-ink-2">
                  {runner.enabled ? "✓" : "—"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1.5">
                    {confirmingDeleteId === runner.id ? (
                      <>
                        <button
                          aria-label={t("deleteConfirm")}
                          className="grid h-8 w-8 place-items-center rounded-[8px] border border-[#b5332b] bg-[#b5332b] text-white disabled:opacity-50"
                          disabled={pending !== null}
                          title={t("deleteConfirm")}
                          type="button"
                          onClick={() => void deleteRunner(runner.id)}
                        >
                          <TrashIcon aria-hidden="true" className="h-4 w-4" />
                        </button>
                        <button
                          aria-label={t("cancel")}
                          className="grid h-8 w-8 place-items-center rounded-[8px] border border-line text-mute hover:text-ink disabled:opacity-50"
                          disabled={pending !== null}
                          title={t("cancel")}
                          type="button"
                          onClick={() => setConfirmingDeleteId(null)}
                        >
                          <XMarkIcon aria-hidden="true" className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          aria-label={t("editAction")}
                          className="grid h-8 w-8 place-items-center rounded-[8px] border border-line text-ink hover:border-mute disabled:opacity-50"
                          disabled={pending !== null}
                          title={t("editAction")}
                          type="button"
                          onClick={() => setEditing(runner)}
                        >
                          <PencilSquareIcon
                            aria-hidden="true"
                            className="h-4 w-4"
                          />
                        </button>
                        <button
                          className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-line px-2.5 text-[12px] font-semibold text-ink hover:border-mute disabled:opacity-50"
                          disabled={
                            pending !== null ||
                            (runner.id === defaultRunnerId && runner.enabled)
                          }
                          type="button"
                          onClick={() =>
                            void setRunnerEnabled(runner.id, !runner.enabled)
                          }
                        >
                          {runner.enabled ? (
                            <NoSymbolIcon
                              aria-hidden="true"
                              className="h-4 w-4"
                            />
                          ) : (
                            <CheckCircleIcon
                              aria-hidden="true"
                              className="h-4 w-4"
                            />
                          )}
                          {runner.enabled ? t("disable") : t("enable")}
                        </button>
                        <button
                          aria-label={t("deleteRunner")}
                          className="grid h-8 w-8 place-items-center rounded-[8px] border border-[#b5332b]/40 text-[#b5332b] hover:border-[#b5332b] hover:bg-[#b5332b]/5 disabled:opacity-50"
                          disabled={pending !== null}
                          title={t("deleteRunner")}
                          type="button"
                          onClick={() => setConfirmingDeleteId(runner.id)}
                        >
                          <TrashIcon aria-hidden="true" className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="mt-4 border-t border-line pt-4">
        <summary className="cursor-pointer list-none font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute hover:text-ink-2">
          {t("providerPresetsReference")}
        </summary>
        <ul className="mt-3 grid list-none gap-1.5 p-0">
          {presets.map((preset) => (
            <li
              key={preset.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-line bg-paper px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-[12px] font-semibold text-ink">
                  {preset.id}
                </div>
                <div className="mt-0.5 font-mono text-[11px] leading-[1.4] text-mute">
                  {preset.adapter} · {preset.model} · {preset.provider.kind}
                  {preset.permissionPolicy === "dangerously_skip_permissions"
                    ? " · dangerous"
                    : ""}
                </div>
              </div>
              <button
                className="h-8 shrink-0 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink hover:border-mute"
                type="button"
                onClick={() => {
                  setUsePresetId(preset.id);
                  setCreating(true);
                }}
              >
                {t("usePreset")}
              </button>
            </li>
          ))}
        </ul>
      </details>

      {creating || editing ? (
        <AcpRunnerModal
          initialPresetId={usePresetId ?? undefined}
          mode={editing ? "edit" : "create"}
          presets={presets}
          runner={editing ?? undefined}
          sidecars={sidecars}
          unavailableAdapters={unavailableAdapters}
          onClose={() => {
            setCreating(false);
            setEditing(null);
            setUsePresetId(null);
          }}
          onSaved={refresh}
        />
      ) : null}
    </section>
  );
}
