"use client";

import type { BrainSettings } from "@/lib/brain/settings";
import type { ReactElement } from "react";

import { Button, Input } from "@heroui/react";
import { CheckIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { PanelSection } from "@/components/settings/panel-section";

type Props = { settings: BrainSettings };

// The API key is a reference to an env var, never the secret; the value is
// resolved from process.env server-side at embed time. An empty field clears the
// column (null); a dimension must be a positive integer (else the PATCH returns
// CONFIG, surfaced inline).
type FormState = {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: string;
  embeddingApiKeyRef: string;
  distillModel: string;
};

function toForm(s: BrainSettings): FormState {
  return {
    embeddingBaseUrl: s.embeddingBaseUrl ?? "",
    embeddingModel: s.embeddingModel ?? "",
    embeddingDimensions:
      s.embeddingDimensions != null ? String(s.embeddingDimensions) : "",
    embeddingApiKeyRef: s.embeddingApiKeyRef ?? "",
    distillModel: s.distillModel ?? "",
  };
}

function formKey(f: FormState): string {
  return [
    f.embeddingBaseUrl.trim(),
    f.embeddingModel.trim(),
    f.embeddingDimensions.trim(),
    f.embeddingApiKeyRef.trim(),
    f.distillModel.trim(),
  ].join("|");
}

// Empty string → null (clear the column); otherwise the trimmed value. Returns
// "invalid" when dimensions is present but not a positive integer.
function toPatch(f: FormState): Record<string, unknown> | "invalid" {
  const dims = f.embeddingDimensions.trim();
  let embeddingDimensions: number | null = null;

  if (dims !== "") {
    const parsed = Number.parseInt(dims, 10);

    if (!Number.isFinite(parsed) || parsed < 1) return "invalid";

    embeddingDimensions = parsed;
  }

  const orNull = (v: string): string | null =>
    v.trim() === "" ? null : v.trim();

  return {
    embeddingBaseUrl: orNull(f.embeddingBaseUrl),
    embeddingModel: orNull(f.embeddingModel),
    embeddingDimensions,
    embeddingApiKeyRef: orNull(f.embeddingApiKeyRef),
    distillModel: orNull(f.distillModel),
  };
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

// Admin-only platform Project-Brain embedding + distillation config (ADR-122).
// A model OR dimension change is a non-destructive reindex generation server-side
// (new expression index + queued reindex jobs), never a schema migration.
export function BrainSettingsPanel({ settings }: Props): ReactElement {
  const t = useTranslations("settings");
  const [form, setForm] = useState<FormState>(toForm(settings));
  const [savedKey, setSavedKey] = useState(formKey(toForm(settings)));
  const [pending, setPending] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = formKey(form) !== savedKey;
  const labelClass =
    "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute";

  function edit(patch: Partial<FormState>): void {
    setShowSaved(false);
    setForm((prev) => ({ ...prev, ...patch }));
  }

  async function save(): Promise<void> {
    const patch = toPatch(form);

    if (patch === "invalid") {
      setError(t("brainDimensionsInvalid"));

      return;
    }

    setPending(true);
    setError(null);

    try {
      await patchJson("/api/admin/brain-settings", patch);
      setSavedKey(formKey(form));
      setShowSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  const fields: Array<{
    key: keyof FormState;
    label: string;
    placeholder?: string;
    numeric?: boolean;
  }> = [
    {
      key: "embeddingBaseUrl",
      label: t("brainBaseUrl"),
      placeholder: "https://api.openai.com/v1",
    },
    {
      key: "embeddingModel",
      label: t("brainModel"),
      placeholder: "text-embedding-3-small",
    },
    {
      key: "embeddingDimensions",
      label: t("brainDimensions"),
      placeholder: "1536",
      numeric: true,
    },
    {
      key: "embeddingApiKeyRef",
      label: t("brainApiKeyRef"),
      placeholder: "env:EMBEDDING_API_KEY",
    },
    {
      key: "distillModel",
      label: t("brainDistillModel"),
      placeholder: "gpt-4o-mini",
    },
  ];

  return (
    <PanelSection title={t("brainTitle")}>
      <p className="m-0 mb-3 font-mono text-[10.5px] leading-[1.5] tracking-[0.02em] text-mute">
        {t("brainHint")}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        {fields.map((field) => (
          <label
            key={field.key}
            className="flex min-w-[220px] flex-col gap-1.5"
          >
            <span className={labelClass}>{field.label}</span>
            <Input
              aria-label={field.label}
              className="h-10 rounded-[8px] border-line bg-canvas px-3 text-[13px] text-ink"
              inputMode={field.numeric ? "numeric" : undefined}
              placeholder={field.placeholder}
              type={field.numeric ? "number" : "text"}
              value={form[field.key]}
              onChange={(event) => edit({ [field.key]: event.target.value })}
            />
          </label>
        ))}
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
            aria-label={t("brainSaved")}
            className="flex items-center text-emerald-600"
            role="status"
            title={t("brainSaved")}
          >
            <CheckIcon className="h-5 w-5" />
          </span>
        ) : null}
      </div>
      {error ? (
        <p
          className="m-0 mt-2 text-[12px] leading-[1.45] text-red-700"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </PanelSection>
  );
}
