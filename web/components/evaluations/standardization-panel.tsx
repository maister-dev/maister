"use client";

import type { ReactElement } from "react";

import { CheckCircleIcon, NoSymbolIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { evalErrorKey, evalRequest } from "@/components/evaluations/api-error";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";

export interface StandardizationEligibilityView {
  eligible: boolean;
  refusals: string[];
}

export interface StandardizedCurrentView {
  revision: number;
  action: string;
  rolledBackToRevision: number | null;
}

// Localize one refusal code. Preflight refusals arrive prefixed `preflight:<code>`
// and reuse the shared controlled-launch refusal copy; the standardization-only
// codes have their own copy. A raw code never reaches the operator.
export function standardizationRefusalLabel(
  t: (key: string) => string,
  tControlled: (key: string) => string,
  code: string,
): string {
  if (code.startsWith("preflight:")) {
    return tControlled(`preflight.refusal.${code.slice("preflight:".length)}`);
  }

  return t(`standardization.refusal.${code}`);
}

// The current-standard badge — the ledger head (revision + action), or a
// not-standardized note. Pure/presentational.
export function StandardizationCurrentBadge({
  current,
}: {
  current: StandardizedCurrentView | null;
}): ReactElement {
  const t = useTranslations("evaluationsLab");

  if (!current) {
    return (
      <span className="text-[12px] text-mute">{t("standardization.none")}</span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-good">
      <CheckCircleIcon aria-hidden="true" className="h-4 w-4" />
      {current.action === "rollback"
        ? t("standardization.rolledBack", {
            revision: current.revision,
            to: current.rolledBackToRevision ?? "?",
          })
        : t("standardization.standardizedAt", { revision: current.revision })}
    </span>
  );
}

// The eligibility state — eligible all-clear, or the localized refusal list.
export function StandardizationEligibility({
  eligibility,
}: {
  eligibility: StandardizationEligibilityView;
}): ReactElement {
  const t = useTranslations("evaluationsLab");
  const tControlled = useTranslations("evaluationsControlled");

  if (eligibility.eligible) {
    return (
      <p className="text-[12px] text-ink-2">{t("standardization.eligible")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-mute">
        {t("standardization.ineligible")}
      </span>
      <ul
        aria-label={t("standardization.ineligible")}
        className="flex flex-col gap-1"
      >
        {eligibility.refusals.map((code) => (
          <li
            key={code}
            className="flex items-start gap-1.5 text-[12px] text-danger"
          >
            <NoSymbolIcon
              aria-hidden="true"
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
            />
            {standardizationRefusalLabel(t, tControlled, code)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StandardizationPanel({
  slug,
  studyId,
}: {
  slug: string;
  studyId: string;
}): ReactElement {
  const t = useTranslations("evaluationsLab");
  const tErr = useTranslations("evaluationsErrors");
  const router = useRouter();
  const titleId = useId();

  const [eligibility, setEligibility] =
    useState<StandardizationEligibilityView | null>(null);
  const [current, setCurrent] = useState<StandardizedCurrentView | null>(null);
  const [confirming, setConfirming] = useState<
    "standardize" | "rollback" | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [eligRes, curRes] = await Promise.all([
        evalRequest(
          `/api/projects/${slug}/evaluations/studies/${studyId}/standardization-eligibility`,
        ),
        evalRequest(
          `/api/projects/${slug}/evaluations/standardization?slot=default`,
        ),
      ]);
      const elig = (await eligRes.json()) as StandardizationEligibilityView;
      const cur = (await curRes.json()) as {
        current: StandardizedCurrentView | null;
      };

      setEligibility(elig);
      setCurrent(cur.current);
    } catch (err) {
      setError(tErr(evalErrorKey(err)));
    }
  }, [slug, studyId, tErr]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(kind: "standardize" | "rollback"): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const url =
        kind === "standardize"
          ? `/api/projects/${slug}/evaluations/studies/${studyId}/standardize`
          : `/api/projects/${slug}/evaluations/standardization/rollback`;

      await evalRequest(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      setConfirming(null);
      await load();
      router.refresh();
    } catch (err) {
      setError(tErr(evalErrorKey(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6 rounded-[10px] border border-line bg-paper p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("standardization.section")}
        </h2>
        <StandardizationCurrentBadge current={current} />
      </div>

      {eligibility ? (
        <StandardizationEligibility eligibility={eligibility} />
      ) : (
        <p aria-busy="true" className="text-[12px] text-mute">
          {t("standardization.loading")}
        </p>
      )}

      {error ? (
        <p className="mt-2 text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-line bg-ink px-3 text-[12px] font-semibold text-paper disabled:opacity-50"
          disabled={busy || !eligibility?.eligible}
          type="button"
          onClick={() => setConfirming("standardize")}
        >
          {t("standardization.standardize")}
        </button>
        {current && current.revision >= 2 ? (
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-line bg-paper px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
            disabled={busy}
            type="button"
            onClick={() => setConfirming("rollback")}
          >
            {t("standardization.rollback")}
          </button>
        ) : null}
      </div>

      {confirming ? (
        <ConfirmDialog
          body={t(
            confirming === "standardize"
              ? "standardization.confirmStandardizeBody"
              : "standardization.confirmRollbackBody",
          )}
          busy={busy}
          cancelLabel={t("cancel")}
          testId="evaluation-standardization-confirm"
          title={t(
            confirming === "standardize"
              ? "standardization.confirmStandardizeTitle"
              : "standardization.confirmRollbackTitle",
          )}
          titleId={titleId}
          onClose={() => setConfirming(null)}
        >
          <div className="flex items-center justify-end gap-2">
            <button
              className="rounded-[8px] border border-line bg-paper px-3 py-1.5 text-[12px] font-semibold text-mute hover:text-ink disabled:opacity-50"
              disabled={busy}
              type="button"
              onClick={() => setConfirming(null)}
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-[8px] border border-line bg-ink px-3 py-1.5 text-[12px] font-semibold text-paper disabled:opacity-50"
              data-testid="evaluation-standardization-confirm-submit"
              disabled={busy}
              type="button"
              onClick={() => void run(confirming)}
            >
              {t("standardization.confirm")}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
