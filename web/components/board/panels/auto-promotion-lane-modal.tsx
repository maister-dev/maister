"use client";

import type { AutoPromotionLane } from "@/lib/auto-promotion/config";
import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

// ADR-126 / T18: the per-lane popup editor. Mirrors user-edit-modal.tsx focus-trap
// convention (initial focus + focus restore + Escape + body-scroll lock + Tab
// loop + aria-labelledby). Produces a validated AutoPromotionLane on Apply; the
// parent control owns the aggregating save.

const LANE_MODES = ["local_merge", "rebase_merge", "pull_request"] as const;

type LaneModeChoice = "default" | (typeof LANE_MODES)[number];

export interface AutoPromotionLaneModalProps {
  lane: AutoPromotionLane;
  onApply: (lane: AutoPromotionLane) => void;
  onClose: () => void;
}

const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";
const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

function parseExcludeGlobs(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function AutoPromotionLaneModal({
  lane,
  onApply,
  onClose,
}: AutoPromotionLaneModalProps): ReactElement {
  const t = useTranslations("settings.autoPromotion");
  const tSettings = useTranslations("settings");

  const [enabled, setEnabled] = useState(lane.enabled);
  const [mode, setMode] = useState<LaneModeChoice>(lane.mode ?? "default");
  const [delay, setDelay] = useState(String(lane.delayMinutes));
  const [checkId, setCheckId] = useState(lane.requireExternalCheckId ?? "");
  const [excludeGlobs, setExcludeGlobs] = useState(
    (lane.excludeGlobs ?? []).join("\n"),
  );

  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  const delayNum = Number.parseInt(delay.trim(), 10);
  const delayValid =
    delay.trim() !== "" &&
    Number.isInteger(delayNum) &&
    delayNum >= 0 &&
    delayNum <= 1440;
  const globs = parseExcludeGlobs(excludeGlobs);
  const globsValid = globs.length <= 64;
  const valid = delayValid && globsValid;

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];

    focusable()[0]?.focus();

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();

        return;
      }

      if (event.key !== "Tab") return;

      const items = focusable();

      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, []);

  function apply(): void {
    if (!valid) return;

    const next: AutoPromotionLane = {
      class: lane.class,
      enabled,
      delayMinutes: delayNum,
      ...(mode !== "default" ? { mode } : {}),
      ...(checkId.trim() ? { requireExternalCheckId: checkId.trim() } : {}),
      ...(globs.length > 0 ? { excludeGlobs: globs } : {}),
    };

    onApply(next);
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={tSettings("cancel")}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="auto-promotion-lane-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[520px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        data-testid="auto-promotion-lane-modal"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2
            className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
            id="auto-promotion-lane-title"
          >
            {t("editLaneTitle", { class: t(`class.${lane.class}`) })}
          </h2>
          <button
            aria-label={tSettings("cancel")}
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5">
          <label className="flex items-center gap-2 text-[12px] text-ink-2">
            <input
              checked={enabled}
              type="checkbox"
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("fieldEnabled")}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldMode")}</span>
            <select
              className={inputClass}
              value={mode}
              onChange={(e) => setMode(e.target.value as LaneModeChoice)}
            >
              <option value="default">{t("mode.default")}</option>
              {LANE_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`mode.${m}`)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldDelay")}</span>
            <input
              className={clsx(inputClass, !delayValid && "border-red-500")}
              inputMode="numeric"
              max={1440}
              min={0}
              type="number"
              value={delay}
              onChange={(e) => setDelay(e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldCheck")}</span>
            <input
              className={inputClass}
              placeholder={t("fieldCheckPlaceholder")}
              spellCheck={false}
              type="text"
              value={checkId}
              onChange={(e) => setCheckId(e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldExclude")}</span>
            <textarea
              className={clsx(inputClass, "min-h-[72px] py-2 leading-[1.5]")}
              placeholder={t("fieldExcludePlaceholder")}
              spellCheck={false}
              value={excludeGlobs}
              onChange={(e) => setExcludeGlobs(e.target.value)}
            />
            <span className="font-mono text-[10px] text-mute">
              {t("fieldExcludeHint")}
            </span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          <button
            className="touch-manipulation rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
            type="button"
            onClick={onClose}
          >
            {tSettings("cancel")}
          </button>
          <button
            className={clsx(
              "touch-manipulation rounded-lg border border-ink bg-ink px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-paper hover:opacity-90",
              !valid && "opacity-60",
            )}
            data-testid="auto-promotion-lane-apply"
            disabled={!valid}
            type="button"
            onClick={apply}
          >
            {tSettings("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
