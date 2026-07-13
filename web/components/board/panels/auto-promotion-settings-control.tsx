"use client";

import type {
  AutoPromotionConfig,
  AutoPromotionLane,
  LaneClass,
} from "@/lib/auto-promotion/config";
import type { ReactElement } from "react";

import { Button, Switch } from "@heroui/react";
import { CheckIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { laneClassSchema } from "@/lib/auto-promotion/config";
import { HARD_DENY_GLOBS } from "@/lib/auto-promotion/classify";
import { AutoPromotionLaneModal } from "@/components/board/panels/auto-promotion-lane-modal";

// ADR-126 / T18: project auto-promotion settings. Master Switch + a view-only
// lanes table (admin view-table + popup-edit convention) with a per-lane edit
// modal; the non-configurable HARD_DENY_GLOBS render read-only with a lock
// glyph. Saves via the ONE aggregating PATCH /api/projects/:slug/settings.

export interface AutoPromotionSettingsControlProps {
  projectSlug: string;
  // The stored config (null ⇒ never configured ⇒ BUILT_IN_LANES + master OFF).
  config: AutoPromotionConfig | null;
}

const LANE_ORDER: LaneClass[] = laneClassSchema.options;

// The default lane for a class the stored config omitted (BUILT_IN_LANES shape).
function defaultLane(cls: LaneClass): AutoPromotionLane {
  return { class: cls, enabled: true, delayMinutes: 10 };
}

// Normalize any stored config into a full, class-keyed lane map so the table
// always shows all four classes in a stable order (a stored config can omit a
// class; a never-configured project has none).
function normalizeLanes(
  config: AutoPromotionConfig | null,
): Record<LaneClass, AutoPromotionLane> {
  const byClass = new Map<LaneClass, AutoPromotionLane>();

  for (const lane of config?.lanes ?? []) {
    if (!byClass.has(lane.class)) byClass.set(lane.class, lane);
  }

  return Object.fromEntries(
    LANE_ORDER.map((cls) => [cls, byClass.get(cls) ?? defaultLane(cls)]),
  ) as Record<LaneClass, AutoPromotionLane>;
}

async function patchAutoPromotion(
  slug: string,
  body: AutoPromotionConfig | null,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(slug)}/settings`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoPromotion: body }),
    },
  );

  if (!res.ok) {
    throw new Error("request failed");
  }
}

export function AutoPromotionSettingsControl({
  projectSlug,
  config,
}: AutoPromotionSettingsControlProps): ReactElement {
  const t = useTranslations("settings.autoPromotion");
  const tSettings = useTranslations("settings");

  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [lanes, setLanes] = useState<Record<LaneClass, AutoPromotionLane>>(() =>
    normalizeLanes(config),
  );
  const [savedKey, setSavedKey] = useState(() =>
    JSON.stringify({
      enabled: config?.enabled ?? false,
      lanes: normalizeLanes(config),
    }),
  );
  const [editingClass, setEditingClass] = useState<LaneClass | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSaved, setShowSaved] = useState(false);

  const currentKey = JSON.stringify({ enabled, lanes });
  const changed = currentKey !== savedKey;

  const labelClass =
    "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute";
  const cellClass = "px-3 py-2.5 text-ink-2";

  function onEdit(next: () => void): void {
    setShowSaved(false);
    next();
  }

  function applyLane(lane: AutoPromotionLane): void {
    setShowSaved(false);
    setLanes((prev) => ({ ...prev, [lane.class]: lane }));
    setEditingClass(null);
  }

  async function save(): Promise<void> {
    setPending(true);
    setError(null);

    try {
      // Persist the current lane set as an explicit config (ordered), so a stored
      // config always carries all four classes and the master flag.
      await patchAutoPromotion(projectSlug, {
        enabled,
        lanes: LANE_ORDER.map((cls) => lanes[cls]),
      });
      setSavedKey(currentKey);
      setShowSaved(true);
    } catch {
      setError(tSettings("requestFailed"));
    } finally {
      setPending(false);
    }
  }

  async function reset(): Promise<void> {
    setPending(true);
    setError(null);

    try {
      // null clears the column to shipped defaults + master OFF.
      await patchAutoPromotion(projectSlug, null);
      const fresh = normalizeLanes(null);

      setEnabled(false);
      setLanes(fresh);
      setSavedKey(JSON.stringify({ enabled: false, lanes: fresh }));
      setShowSaved(true);
    } catch {
      setError(tSettings("requestFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mb-4 rounded-[8px] border border-line bg-paper px-[18px] py-[15px]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="m-0 text-[13px] font-semibold tracking-[-0.005em] text-ink">
            {t("title")}
          </h3>
          <p className="m-0 mt-1 font-mono text-[10.5px] leading-[1.5] text-mute">
            {t("hint")}
          </p>
        </div>
        {showSaved && !changed ? (
          <span
            aria-label={t("saved")}
            className="flex items-center text-emerald-600"
            role="status"
            title={t("saved")}
          >
            <CheckIcon className="h-5 w-5" />
          </span>
        ) : null}
      </div>

      <div className="mb-4">
        <Switch
          className="inline-flex items-center gap-2.5 font-mono text-[11.5px] font-semibold text-ink"
          data-testid="auto-promotion-master"
          isSelected={enabled}
          onChange={(next) => onEdit(() => setEnabled(next))}
        >
          <Switch.Control className="inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full border border-line bg-ivory p-[2px] transition-colors data-[selected=true]:border-good data-[selected=true]:bg-good-soft">
            <Switch.Thumb className="h-[12px] w-[12px] rounded-full bg-mute transition-transform data-[selected=true]:translate-x-[14px] data-[selected=true]:bg-good" />
          </Switch.Control>
          <span>
            {t("master")} · {enabled ? t("masterOn") : t("masterOff")}
          </span>
        </Switch>
      </div>

      <div className="overflow-x-auto">
        <table
          className="w-full min-w-[640px] border-collapse text-left"
          data-testid="auto-promotion-lanes-table"
        >
          <thead className="border-b border-line bg-ivory/60">
            <tr className={labelClass}>
              <th className="px-3 py-2">{t("colClass")}</th>
              <th className="px-3 py-2">{t("colEnabled")}</th>
              <th className="px-3 py-2">{t("colMode")}</th>
              <th className="px-3 py-2">{t("colDelay")}</th>
              <th className="px-3 py-2">{t("colCheck")}</th>
              <th className="px-3 py-2">{t("colExclude")}</th>
              <th className="px-3 py-2 text-right">{t("colEdit")}</th>
            </tr>
          </thead>
          <tbody>
            {LANE_ORDER.map((cls) => {
              const lane = lanes[cls];

              return (
                <tr
                  key={cls}
                  className="border-b border-line align-middle text-[12px] last:border-b-0"
                  data-lane={cls}
                >
                  <td className="px-3 py-2.5 font-mono font-semibold text-ink">
                    {t(`class.${cls}`)}
                  </td>
                  <td className={cellClass} data-enabled={lane.enabled}>
                    {lane.enabled ? (
                      <span className="text-good" title={t("colEnabled")}>
                        ✓
                      </span>
                    ) : (
                      <span className="text-mute">{t("none")}</span>
                    )}
                  </td>
                  <td className={cellClass}>
                    {lane.mode ? t(`mode.${lane.mode}`) : t("mode.default")}
                  </td>
                  <td className={cellClass}>
                    {t("delayValue", { n: lane.delayMinutes })}
                  </td>
                  <td className={clsx(cellClass, "font-mono")}>
                    {lane.requireExternalCheckId ?? t("none")}
                  </td>
                  <td className={clsx(cellClass, "font-mono")}>
                    {lane.excludeGlobs && lane.excludeGlobs.length > 0
                      ? lane.excludeGlobs.join(", ")
                      : t("none")}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Button
                      aria-label={t("edit")}
                      className="border-line bg-ivory text-[11px] font-semibold text-ink-2"
                      data-testid={`auto-promotion-edit-${cls}`}
                      size="sm"
                      type="button"
                      variant="outline"
                      onClick={() => setEditingClass(cls)}
                    >
                      {tSettings("editAction")}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div
        className="mt-4 rounded-[8px] border border-line bg-ivory/40 px-3.5 py-3"
        data-testid="auto-promotion-deny-list"
      >
        <div className="mb-1.5 flex items-center gap-1.5">
          <LockClosedIcon
            aria-hidden="true"
            className="h-3.5 w-3.5 text-mute"
          />
          <span className={labelClass}>{t("denyTitle")}</span>
        </div>
        <p className="m-0 mb-2 font-mono text-[10px] leading-[1.5] text-mute">
          {t("denyHint")}
        </p>
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {HARD_DENY_GLOBS.map((glob) => (
            <li
              key={glob}
              className="rounded-[4px] border border-line bg-paper px-1.5 py-px font-mono text-[10px] text-ink-2"
            >
              {glob}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button
          className="border-line bg-ivory text-[12px] font-semibold text-ink"
          isDisabled={pending}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void reset()}
        >
          {t("reset")}
        </Button>
        <Button
          className="border-line bg-ink text-[12px] font-semibold text-paper"
          isDisabled={pending || !changed}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void save()}
        >
          {pending ? tSettings("saving") : tSettings("save")}
        </Button>
      </div>

      {error ? (
        <p
          className="m-0 mt-2 text-[12px] leading-[1.45] text-red-700"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {editingClass ? (
        <AutoPromotionLaneModal
          lane={lanes[editingClass]}
          onApply={applyLane}
          onClose={() => setEditingClass(null)}
        />
      ) : null}
    </div>
  );
}
