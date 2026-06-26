"use client";

import type {
  ProjectFlowRunnerRemap,
  ProjectRunner,
} from "@/lib/queries/project";
import type { ReactElement } from "react";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";

type Props = {
  projectSlug: string;
  remaps: ProjectFlowRunnerRemap[];
  runners: ProjectRunner[];
  // M42 (ADR-114): the same slot-keyed binding control backs BOTH the project
  // settings tab (all flows) and the per-flow connect-time binding screen. The
  // connect-time host overrides the heading/hint, supplies friendly slot labels
  // (`session:<name>` / `consensus:<node>:<participant>` → readable), and asks
  // for a positive empty-state instead of rendering nothing when every slot
  // already auto-resolves.
  heading?: string;
  hint?: string;
  slotLabels?: Record<string, string>;
  allResolvedLabel?: string;
};

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

function remapStatusClass(status: ProjectFlowRunnerRemap["status"]): string {
  if (status === "Mapped") return "text-emerald-700";

  return "text-amber";
}

export function FlowRunnerReconfigurationControl({
  projectSlug,
  remaps,
  runners,
  heading,
  hint,
  slotLabels,
  allResolvedLabel,
}: Props): ReactElement | null {
  const t = useTranslations("settings");
  const [items, setItems] = useState(remaps);
  const [selectedById, setSelectedById] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      remaps.map((remap) => [remap.id, remap.mappedRunnerId ?? ""]),
    ),
  );
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectableRunners = useMemo(
    () =>
      runners.filter(
        (runner) => runner.enabled && runner.readinessStatus === "Ready",
      ),
    [runners],
  );
  const title = heading ?? t("flowRunnerReconfiguration");
  const subhead = hint ?? t("flowRunnerReconfigurationHint");

  // Connect-time host (allResolvedLabel set) shows a positive "nothing to bind"
  // state; the settings tab keeps the legacy collapse-to-nothing behavior.
  if (items.length === 0) {
    if (!allResolvedLabel) return null;

    return (
      <div className="mb-4 rounded-[8px] border border-line bg-paper px-[18px] py-[15px]">
        <h3 className="m-0 text-[13px] font-semibold tracking-[-0.005em] text-ink">
          {title}
        </h3>
        <p
          className="m-0 mt-2 inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-700"
          data-testid="flow-runner-binding-all-resolved"
        >
          <span aria-hidden="true">✓</span>
          {allResolvedLabel}
        </p>
      </div>
    );
  }

  async function save(remap: ProjectFlowRunnerRemap): Promise<void> {
    const mappedRunnerId = selectedById[remap.id] || null;

    setPendingId(remap.id);
    setError(null);

    try {
      await patchJson(
        `/api/projects/${encodeURIComponent(projectSlug)}/flow-runner-remaps`,
        {
          flowRevisionId: remap.flowRevisionId,
          slotKey: remap.slotKey,
          mappedRunnerId,
        },
      );
      setItems((current) =>
        current.map((item) =>
          item.id === remap.id
            ? {
                ...item,
                mappedRunnerId,
                status: mappedRunnerId ? "Mapped" : "Pending",
              }
            : item,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="mb-4 rounded-[8px] border border-amber/40 bg-paper px-[18px] py-[15px]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="m-0 text-[13px] font-semibold tracking-[-0.005em] text-ink">
            {title}
          </h3>
          <p className="m-0 mt-1 font-mono text-[10.5px] tracking-[0.02em] text-mute">
            {subhead}
          </p>
        </div>
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-amber">
          {items.filter((item) => item.status === "Pending").length}{" "}
          {t("pending")}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {items.map((remap) => {
          const selectedRunnerId = selectedById[remap.id] ?? "";
          const changed = selectedRunnerId !== (remap.mappedRunnerId ?? "");

          return (
            <div
              key={remap.id}
              className="grid gap-2 rounded-[8px] border border-line bg-canvas p-3 md:grid-cols-[1fr_minmax(220px,0.8fr)_auto]"
            >
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-ink">
                  {remap.flowRef}
                </div>
                <div className="mt-1 font-mono text-[10.5px] tracking-[0.02em] text-mute">
                  {t("slot")}: {slotLabels?.[remap.slotKey] ?? remap.slotKey}
                </div>
                <div
                  className={`mt-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] ${remapStatusClass(
                    remap.status,
                  )}`}
                >
                  {remap.status}
                </div>
              </div>
              <select
                className="h-9 rounded-[8px] border border-line bg-paper px-3 text-[12px] text-ink outline-none"
                value={selectedRunnerId}
                onChange={(event) =>
                  setSelectedById((current) => ({
                    ...current,
                    [remap.id]: event.target.value,
                  }))
                }
              >
                <option value="">{t("chooseRunner")}</option>
                {selectableRunners.map((runner) => (
                  <option key={runner.id} value={runner.id}>
                    {runner.label}
                  </option>
                ))}
              </select>
              <button
                className="h-9 rounded-[8px] border border-line bg-ink px-3 text-[12px] font-semibold text-paper disabled:opacity-50"
                disabled={pendingId !== null || !changed}
                type="button"
                onClick={() => void save(remap)}
              >
                {t("save")}
              </button>
            </div>
          );
        })}
      </div>
      {error ? (
        <p className="m-0 mt-2 text-[12px] leading-[1.45] text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
