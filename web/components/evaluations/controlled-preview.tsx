"use client";

import type { ReactElement } from "react";

import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  NoSymbolIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";

// T6.4 controlled-creation preview surfaces (ADR-143). Presentational: it renders
// SERVER-computed data (the T6.1 preflight result + the T6.2 materialization
// snapshot) with NO raw IDs/JSON — a refusal/warning shows localized actionable
// copy keyed by its stable code, a slot shows its human label + model +
// capability. The creation wizard's final step embeds this before launch.

// One preflight refusal/warning, reduced to a stable code the UI localizes.
export interface PreflightVerdictView {
  ok: boolean;
  refusalCodes: string[];
  warningCodes: string[];
}

// The effective per-slot runner/model a launched participant will use, plus the
// non-runner facets the plan's GREEN criteria require the operator to see.
export interface EffectiveSlotView {
  slotLabel: string;
  capabilityAgent: string;
  model: string;
  softMismatch: boolean;
}

export interface MaterializationPreviewView {
  slots: EffectiveSlotView[];
  overlay: {
    rulesAdded: number;
    skillsAdded: number;
    mcpsAdded: number;
    subagentsAdded: number;
  };
  policyPreset: string;
  // The always-on evaluation promotion hold (D15) — never removable by a recipe.
  promotionHeld: true;
  evidenceMethodQualifiedId: string;
  evidenceCoverage: string[];
  estimatedJudgeAttempts: number;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-forest-text-secondary">{label}</span>
      <span className="text-forest-text-primary">{children}</span>
    </div>
  );
}

// The preflight verdict block — a green all-clear, or the aggregated set of
// localized refusals (blocking) and warnings (advisory soft mismatches).
export function PreflightVerdict({
  verdict,
}: {
  verdict: PreflightVerdictView;
}): ReactElement {
  const t = useTranslations("evaluationsControlled");

  if (verdict.ok && verdict.warningCodes.length === 0) {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
        role="status"
      >
        <CheckCircleIcon aria-hidden className="h-5 w-5" />
        <span>{t("preflight.ok")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" role="status">
      {verdict.ok ? (
        <div className="flex items-center gap-2 text-sm text-amber-300">
          <ExclamationTriangleIcon aria-hidden className="h-5 w-5" />
          <span>{t("preflight.okWithWarnings")}</span>
        </div>
      ) : (
        <ul
          aria-label={t("preflight.refusalsLabel")}
          className="flex flex-col gap-1"
        >
          {verdict.refusalCodes.map((code) => (
            <li
              key={code}
              className="flex items-start gap-2 text-sm text-rose-300"
            >
              <NoSymbolIcon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t(`preflight.refusal.${code}`)}</span>
            </li>
          ))}
        </ul>
      )}
      {verdict.warningCodes.length > 0 ? (
        <ul
          aria-label={t("preflight.warningsLabel")}
          className="flex flex-col gap-1"
        >
          {verdict.warningCodes.map((code) => (
            <li
              key={code}
              className="flex items-start gap-2 text-sm text-amber-300"
            >
              <ExclamationTriangleIcon
                aria-hidden
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span>{t(`preflight.warning.${code}`)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// The effective-materialization preview — per-slot runner/model, overlay summary,
// policy, the held promotion, evidence scope, and the estimated judge-attempt
// token footprint. No raw runner/package ids reach the operator.
export function MaterializationPreview({
  preview,
}: {
  preview: MaterializationPreviewView;
}): ReactElement {
  const t = useTranslations("evaluationsControlled");
  const overlayCount =
    preview.overlay.rulesAdded +
    preview.overlay.skillsAdded +
    preview.overlay.mcpsAdded +
    preview.overlay.subagentsAdded;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-forest-border p-3">
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-medium text-forest-text-primary">
          {t("preview.slotsHeading")}
        </h4>
        <ul className="flex flex-col gap-1">
          {preview.slots.map((slot) => (
            <li
              key={slot.slotLabel}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="text-forest-text-secondary">
                {slot.slotLabel}
              </span>
              <span className="flex items-center gap-2 text-forest-text-primary">
                <span>{slot.model}</span>
                <span className="text-forest-text-secondary">
                  ({slot.capabilityAgent})
                </span>
                {slot.softMismatch ? (
                  <span
                    className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300"
                    title={t("preview.softMismatch")}
                  >
                    {t("preview.softMismatchBadge")}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-forest-border pt-2">
        <Row label={t("preview.policy")}>
          {t(`policy.${preview.policyPreset}`)}
        </Row>
        <Row label={t("preview.promotion")}>
          <span className="flex items-center gap-1 text-amber-300">
            <NoSymbolIcon aria-hidden className="h-4 w-4" />
            {t("preview.promotionHeld")}
          </span>
        </Row>
        <Row label={t("preview.overlay")}>
          {overlayCount === 0
            ? t("preview.overlayNone")
            : t("preview.overlayCount", { count: overlayCount })}
        </Row>
        <Row label={t("preview.evidence")}>
          {preview.evidenceMethodQualifiedId}
        </Row>
        <Row label={t("preview.coverage")}>
          {preview.evidenceCoverage.length === 0
            ? t("preview.coverageNone")
            : preview.evidenceCoverage.join(", ")}
        </Row>
        <Row label={t("preview.estimatedAttempts")}>
          {preview.estimatedJudgeAttempts}
        </Row>
      </div>
    </div>
  );
}
