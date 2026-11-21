"use client";

import { Button } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useRef, useState, type FormEvent, type ReactElement } from "react";

import {
  integrityValueSchema,
  workspaceIntegrityFields,
  workspaceIntegrityFieldNames,
  type IntegrityField,
  type IntegrityPatch,
  type IntegritySettings,
} from "@/lib/workspace-integrity/settings-schema";

type Draft = Partial<Record<IntegrityField, string | null>>;

export function WorkspaceIntegritySettingsCard({
  initial,
  invalidFields,
}: {
  initial: Partial<IntegritySettings> | null;
  invalidFields: readonly IntegrityField[];
}): ReactElement {
  const t = useTranslations("workspaceIntegrity");
  const [settings, setSettings] = useState(initial);
  const [unresolvedFields, setUnresolvedFields] = useState(invalidFields);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<{
    kind: "range" | "invalidEnvironment" | "unavailable";
    field?: IntegrityField;
  } | null>(initial ? null : { kind: "unavailable" });
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  function edit(field: IntegrityField, value: string | null): void {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setSaved(false);
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    const patch: IntegrityPatch = {};
    for (const field of workspaceIntegrityFieldNames) {
      const value = draft[field];
      if (value === undefined) continue;
      if (value === null) {
        patch[field] = null;
        continue;
      }
      const parsed = integrityValueSchema(field).safeParse(
        /^[0-9]+$/.test(value) ? Number(value) : undefined,
      );
      if (!parsed.success) {
        setError({ kind: "range", field });
        return;
      }
      patch[field] = parsed.data;
    }

    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/platform/workspace-integrity", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        const body = await response.json();
        const field = workspaceIntegrityFieldNames.find(
          (name) => name === body?.details?.field,
        );
        setError({
          kind:
            body?.details?.reason === "invalid_environment"
              ? "invalidEnvironment"
              : body?.details?.reason === "invalid_value" && field
                ? "range"
                : "unavailable",
          field,
        });
        return;
      }
      setSettings((await response.json()) as IntegritySettings);
      setDraft({});
      setUnresolvedFields([]);
      setSaved(true);
    } catch {
      setError({ kind: "unavailable" });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="workspace-integrity-heading"
      className="mt-5 rounded-2xl border border-line bg-paper p-7"
    >
      <h2 id="workspace-integrity-heading" className="text-lg font-semibold">
        {t("title")}
      </h2>
      <form onSubmit={save} noValidate className="mt-4 max-w-xl space-y-4">
        {workspaceIntegrityFieldNames.map((field) => {
          const definition = workspaceIntegrityFields[field];
          const current = settings?.[field];
          const fieldError =
            error?.field === field
              ? error.kind
              : unresolvedFields.includes(field)
                ? "invalidEnvironment"
                : null;

          return (
            <div key={field} className="space-y-1">
              <label htmlFor={definition.anchor} className="block font-medium">
                {t(`fields.${field}`)}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={definition.anchor}
                  className="w-36 scroll-mt-24 rounded-md border border-line bg-paper px-3 py-2"
                  type="text"
                  inputMode="numeric"
                  value={
                    draft[field] === null
                      ? ""
                      : (draft[field] ?? current?.value ?? "")
                  }
                  onChange={(event) => edit(field, event.target.value)}
                  disabled={busy}
                  aria-invalid={fieldError !== null}
                  aria-describedby={`${definition.anchor}-status`}
                />
                <Button
                  type="button"
                  variant="outline"
                  isDisabled={
                    busy ||
                    current?.source !== "platform" ||
                    draft[field] === null
                  }
                  onPress={() => edit(field, null)}
                  aria-label={t("resetField", { field: t(`fields.${field}`) })}
                >
                  {t("reset")}
                </Button>
              </div>
              <div
                id={`${definition.anchor}-status`}
                className="text-sm text-mute"
              >
                {current && (
                  <p>
                    {t("effective", {
                      value: current.value,
                      source: t(`sources.${current.source}`),
                    })}
                  </p>
                )}
                {draft[field] === null && <p>{t("pendingReset")}</p>}
                {fieldError && (
                  <p role="alert">{t(fieldError, { max: definition.max })}</p>
                )}
              </div>
            </div>
          );
        })}
        <Button
          type="submit"
          variant="primary"
          isDisabled={busy || Object.keys(draft).length === 0}
        >
          {t("save")}
        </Button>
        {saved && <p role="status">{t("saved")}</p>}
        {error && !error.field && <p role="alert">{t("unavailable")}</p>}
      </form>
    </section>
  );
}
