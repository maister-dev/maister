"use client";

import type { ReactElement } from "react";
import type {
  LibrarianAvailabilityState,
  LibrarianSettingsView,
} from "@/lib/librarian/settings-view";

import { Button } from "@heroui/react";
import { CheckIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { PanelSection } from "@/components/settings/panel-section";

type Props = { view: LibrarianSettingsView };

const REFUSAL_KEYS: Record<string, string> = {
  runner_missing: "librarianErrorRunnerMissing",
  runner_disabled: "librarianErrorRunnerDisabled",
  capability_not_supported: "librarianIneligible_capability_not_supported",
  builtin_denial_unverified: "librarianIneligible_builtin_denial_unverified",
  not_read_only_capable: "librarianIneligible_not_read_only_capable",
  skips_permissions: "librarianIneligible_skips_permissions",
  reserved_env: "librarianIneligible_reserved_env",
};

// ADR-185 (LCV-11): the admin's enable toggle, runner choice and the
// resulting readiness. Disabling stops admission only; nothing is deleted.
export function LibrarianSettingsCard({ view }: Props): ReactElement {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(view.enabled);
  const [runnerId, setRunnerId] = useState(view.runnerId ?? "");
  const [availability, setAvailability] = useState<LibrarianAvailabilityState>(
    view.availability,
  );
  const [saved, setSaved] = useState({
    enabled: view.enabled,
    runnerId: view.runnerId ?? "",
  });
  const [pending, setPending] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const eligible = view.runners.filter((runner) => runner.ineligible === null);
  const changed = enabled !== saved.enabled || runnerId !== saved.runnerId;
  const labelClass =
    "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute";

  async function save(): Promise<void> {
    setPending(true);
    setErrorKey(null);
    try {
      const response = await fetch("/api/admin/platform/librarian", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, runnerId: runnerId || null }),
      });
      const payload = (await response.json().catch(() => null)) as {
        readiness?: { state: LibrarianAvailabilityState };
        details?: { reason?: string };
      } | null;

      if (!response.ok) {
        setErrorKey(
          REFUSAL_KEYS[payload?.details?.reason ?? ""] ?? "librarianErrorSave",
        );

        return;
      }
      setAvailability(payload?.readiness?.state ?? availability);
      setSaved({ enabled, runnerId });
      setShowSaved(true);
    } catch {
      setErrorKey("librarianErrorSave");
    } finally {
      setPending(false);
    }
  }

  return (
    <PanelSection title={t("librarianTitle")}>
      <p className="m-0 mb-3 font-mono text-[10.5px] leading-[1.5] tracking-[0.02em] text-mute">
        {t("librarianHint")}
      </p>
      <div className="grid gap-4" data-testid="librarian-settings-card">
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            checked={enabled}
            data-testid="librarian-enabled"
            type="checkbox"
            onChange={(event) => {
              setShowSaved(false);
              setEnabled(event.target.checked);
            }}
          />
          {t("librarianEnable")}
        </label>
        <label className="flex max-w-[520px] flex-col gap-1.5">
          <span className={labelClass}>{t("librarianRunner")}</span>
          <select
            aria-label={t("librarianRunner")}
            className="h-10 rounded-[8px] border border-line bg-canvas px-3 text-[13px] text-ink"
            data-testid="librarian-runner"
            value={runnerId}
            onChange={(event) => {
              setShowSaved(false);
              setRunnerId(event.target.value);
            }}
          >
            <option value="">{t("librarianNoRunner")}</option>
            {view.runners.map((runner) => (
              <option
                key={runner.id}
                disabled={runner.ineligible !== null}
                value={runner.id}
              >
                {runner.ineligible === null
                  ? `${runner.label}${runner.ready ? "" : ` — ${t("librarianRunnerNotReady")}`}`
                  : `${runner.label} — ${t(`librarianIneligible_${runner.ineligible}`)}`}
              </option>
            ))}
          </select>
        </label>
        {eligible.length === 0 ? (
          <p
            className="m-0 text-[12px] leading-[1.45] text-mute"
            data-testid="librarian-no-eligible"
          >
            {t("librarianNoEligibleRunner")}
          </p>
        ) : null}
        <p
          className="m-0 text-[12.5px] leading-[1.45] text-ink"
          data-testid="librarian-readiness"
        >
          {t("librarianReadinessLabel")}:{" "}
          {t(`librarianReadiness_${availability}`)}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="border-line bg-ink text-[13px] font-semibold text-paper"
            isDisabled={pending || !changed}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void save()}
          >
            {pending ? t("saving") : t("save")}
          </Button>
          {showSaved && !changed ? (
            <span
              aria-label={t("librarianSaved")}
              className="flex items-center text-emerald-600"
              role="status"
              title={t("librarianSaved")}
            >
              <CheckIcon className="h-5 w-5" />
            </span>
          ) : null}
        </div>
      </div>
      {errorKey ? (
        <p
          className="m-0 mt-2 text-[12px] leading-[1.45] text-red-700"
          role="alert"
        >
          {t(errorKey)}
        </p>
      ) : null}
    </PanelSection>
  );
}
