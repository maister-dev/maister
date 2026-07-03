import type { ExperimentVariant } from "@/lib/experiments/types";
import type { ReactElement } from "react";

export interface VariantEditorLabels {
  variants: string;
  variantKey: string;
  variantLabel: string;
  runner: string;
  executionPolicy: string;
  rulesAdd: string;
  rulesRemove: string;
  skillsAdd: string;
  skillsRemove: string;
  mcpsAdd: string;
  mcpsRemove: string;
  subagentsAdd: string;
  subagentsRemove: string;
}

export function VariantEditor({
  labels,
  variants,
}: {
  labels: VariantEditorLabels;
  variants: ExperimentVariant[];
}): ReactElement {
  return (
    <section className="rounded-[12px] border border-line bg-ivory p-4">
      <h3 className="m-0 mb-3 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-mute">
        {labels.variants}
      </h3>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {variants.map((variant, index) => (
          <fieldset
            key={variant.key}
            className="rounded-[10px] border border-line bg-paper p-3"
          >
            <legend className="px-1 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-ink">
              {variant.label}
            </legend>
            <div className="grid grid-cols-1 gap-2">
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
                  {labels.variantKey}
                </span>
                <input
                  className="rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink"
                  defaultValue={variant.key}
                  name={`variant.${index}.key`}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
                  {labels.variantLabel}
                </span>
                <input
                  className="rounded-md border border-line bg-paper px-2 py-1.5 text-[13px] text-ink"
                  defaultValue={variant.label}
                  name={`variant.${index}.label`}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
                  {labels.runner}
                </span>
                <input
                  className="rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink"
                  defaultValue={variant.config.runnerId ?? ""}
                  name={`variant.${index}.runnerId`}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
                  {labels.executionPolicy}
                </span>
                <textarea
                  className="min-h-[54px] rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-[11px] text-ink"
                  defaultValue={
                    variant.config.executionPolicy
                      ? JSON.stringify(variant.config.executionPolicy, null, 2)
                      : ""
                  }
                  name={`variant.${index}.executionPolicy`}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  ["rulesAdd", labels.rulesAdd],
                  ["rulesRemove", labels.rulesRemove],
                  ["skillsAdd", labels.skillsAdd],
                  ["skillsRemove", labels.skillsRemove],
                  ["mcpsAdd", labels.mcpsAdd],
                  ["mcpsRemove", labels.mcpsRemove],
                  ["subagentsAdd", labels.subagentsAdd],
                  ["subagentsRemove", labels.subagentsRemove],
                ].map(([key, label]) => (
                  <label key={key} className="flex flex-col gap-1">
                    <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.08em] text-mute">
                      {label}
                    </span>
                    <input
                      className="rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-[11px] text-ink"
                      name={`variant.${index}.${key}`}
                    />
                  </label>
                ))}
              </div>
            </div>
          </fieldset>
        ))}
      </div>
    </section>
  );
}

export function csv(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
