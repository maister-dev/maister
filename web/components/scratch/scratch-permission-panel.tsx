"use client";

import type { ScratchDetail } from "@/lib/scratch-runs/dialog";
import type { KeyboardEvent, ReactElement } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

const shell =
  "rounded-lg border border-line-soft bg-[color-mix(in_oklab,var(--ivory)_35%,var(--paper))]";
const inputBase =
  "w-full rounded-lg border border-line bg-paper px-3.5 py-3 font-mono text-[13px] leading-[1.35] text-ink outline-none transition focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)] placeholder:text-mute";

export interface ScratchPermissionPanelProps {
  pendingHitl: NonNullable<ScratchDetail["pendingHitl"]>;
  pending: boolean;
  onAnswer: (payload: Record<string, unknown>) => void;
}

// The live HITL surface for a scratch run (M35 T3.2): a binary permission
// prompt renders option buttons; a form/human prompt renders a JSON editor.
// Extracted from the former ScratchDialog sidebar so it can live inline in the
// conversation center.
export function ScratchPermissionPanel({
  pendingHitl,
  pending,
  onAnswer,
}: ScratchPermissionPanelProps): ReactElement {
  const t = useTranslations("scratch");
  const [hitlJson, setHitlJson] = useState("{}");
  const [parseError, setParseError] = useState<string | null>(null);

  function submitJson(): void {
    try {
      const response = JSON.parse(hitlJson);

      setParseError(null);
      onAnswer({ response });
    } catch {
      setParseError(t("invalidJson"));
    }
  }

  function handleJsonKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;

    event.preventDefault();
    if (!pending) submitJson();
  }

  return (
    <section
      className={`${shell} border-amber-line bg-[color-mix(in_oklab,var(--amber-soft)_45%,var(--paper))] p-3`}
      data-testid="scratch-permission-panel"
    >
      <div className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-amber">
        {t("permission")}
      </div>
      <p className="mb-3 whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">
        {pendingHitl.prompt}
      </p>
      {pendingHitl.kind === "permission" ? (
        <div className="flex flex-wrap gap-2">
          {pendingHitl.options.map((option) => (
            <button
              key={option.optionId}
              className={clsx(
                "rounded-lg border px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em]",
                option.optionId.includes("deny")
                  ? "border-line bg-paper text-mute hover:border-mute hover:text-ink-2"
                  : "border-amber bg-amber text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
              )}
              disabled={pending}
              type="button"
              onClick={() => onAnswer({ optionId: option.optionId })}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={t("permissionResponseAria")}
            className={clsx(inputBase, "min-h-[120px]")}
            value={hitlJson}
            onChange={(event) => setHitlJson(event.target.value)}
            onKeyDown={handleJsonKeyDown}
          />
          {parseError ? (
            <p className="font-mono text-[10.5px] text-[#d9534f]" role="alert">
              {parseError}
            </p>
          ) : null}
          <button
            className="w-max rounded-full bg-amber px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-amber-2 disabled:opacity-60"
            disabled={pending}
            type="button"
            onClick={submitJson}
          >
            {t("submit")}
          </button>
        </div>
      )}
    </section>
  );
}
