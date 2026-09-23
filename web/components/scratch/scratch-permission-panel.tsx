"use client";

import type { ScratchDetail } from "@/lib/scratch-runs/dialog";
import type { KeyboardEvent, ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";
import { Button } from "@heroui/react";
import { ArrowPathIcon } from "@heroicons/react/24/outline";

import { canReplayHitlAnswer } from "@/lib/hitl-response-contract";

const shell =
  "rounded-lg border border-line-soft bg-[color-mix(in_oklab,var(--ivory)_35%,var(--paper))]";
const inputBase =
  "w-full rounded-lg border border-line bg-paper px-3.5 py-3 font-mono text-[13px] leading-[1.35] text-ink outline-none transition focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)] placeholder:text-mute";

export interface ScratchPermissionPanelProps {
  pendingHitl: NonNullable<ScratchDetail["pendingHitl"]>;
  pending: boolean;
  canAct: boolean;
  onAnswer: (payload: Record<string, unknown>) => void;
  onRefresh: () => void;
}

// The live HITL surface for a scratch run (M35 T3.2): a binary permission
// prompt renders option buttons; a form/human prompt renders a JSON editor.
// Extracted from the former ScratchDialog sidebar so it can live inline in the
// conversation center.
export function ScratchPermissionPanel({
  pendingHitl,
  pending,
  canAct,
  onAnswer,
  onRefresh,
}: ScratchPermissionPanelProps): ReactElement {
  const t = useTranslations("scratch");
  const tRun = useTranslations("run");
  const [hitlJson, setHitlJson] = useState("{}");
  const [parseError, setParseError] = useState<string | null>(null);
  const previousAnswerState = useRef(pendingHitl.answerState);
  const storedActionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (
      previousAnswerState.current === "open" &&
      pendingHitl.answerState === "answer_stored"
    ) {
      storedActionRef.current?.focus();
    }
    previousAnswerState.current = pendingHitl.answerState;
  }, [pendingHitl.answerState]);

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
    if (!pending && canAct) submitJson();
  }

  if (pendingHitl.answerState === "answer_stored") {
    const saved = pendingHitl.storedResponse;
    const chosen =
      saved && "optionId" in saved
        ? pendingHitl.options.find(
            (option) => option.optionId === saved.optionId,
          )
        : undefined;
    const canRetry =
      saved !== null &&
      canReplayHitlAnswer(pendingHitl.kind, pendingHitl.schema) &&
      (pendingHitl.kind !== "permission" || chosen !== undefined);

    return (
      <section
        className={`${shell} p-3`}
        data-testid="scratch-permission-panel"
      >
        <span aria-live="polite" className="sr-only">
          {tRun("answerSaved")}
        </span>
        <p className="mb-2 text-[13px] text-ink">{pendingHitl.prompt}</p>
        <p className="text-[12px] text-ink-2">{tRun("answerSaved")}</p>
        {chosen ? (
          <p className="mt-2 font-semibold text-ink">{chosen.label}</p>
        ) : null}
        {saved && "response" in saved ? (
          <div className="mt-2">
            <p className="mb-1 text-xs font-semibold text-ink-2">
              {tRun("savedResponse")}
            </p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-paper p-2 text-xs text-ink-2">
              {typeof saved.response === "string"
                ? saved.response
                : JSON.stringify(saved.response, null, 2)}
            </pre>
          </div>
        ) : null}
        {!canRetry ? (
          <>
            <p className="mt-2 text-xs text-mute">
              {saved && "optionId" in saved
                ? tRun("savedInvalidOption")
                : tRun("savedNoReplay")}
            </p>
            <Button
              ref={storedActionRef}
              className="mt-2 border-line bg-paper text-sm text-ink-2"
              size="sm"
              type="button"
              variant="outline"
              onClick={onRefresh}
            >
              <ArrowPathIcon aria-hidden="true" className="size-4" />
              {tRun("refreshAnswer")}
            </Button>
          </>
        ) : canAct ? (
          <Button
            ref={storedActionRef}
            className="mt-2 border-amber bg-amber text-sm text-white"
            isDisabled={pending}
            size="sm"
            type="button"
            onClick={() => onAnswer(saved as Record<string, unknown>)}
          >
            <ArrowPathIcon aria-hidden="true" className="size-4" />
            {tRun("retryDelivery")}
          </Button>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className={`${shell} border-amber-line bg-[color-mix(in_oklab,var(--amber-soft)_45%,var(--paper))] p-3`}
      data-testid="scratch-permission-panel"
    >
      <span aria-live="polite" className="sr-only" />
      <div className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-amber">
        {t("permission")}
      </div>
      <p className="mb-3 whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">
        {pendingHitl.prompt}
      </p>
      {pendingHitl.kind === "permission" ? (
        <div className="flex flex-wrap gap-2">
          {pendingHitl.options.map((option) => (
            <Button
              key={option.optionId}
              className={clsx(
                "rounded-lg border px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em]",
                option.optionId.includes("deny")
                  ? "border-line bg-paper text-mute hover:border-mute hover:text-ink-2"
                  : "border-amber bg-amber text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
              )}
              isDisabled={pending || !canAct}
              size="sm"
              type="button"
              onClick={() => onAnswer({ optionId: option.optionId })}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={t("permissionResponseAria")}
            className={clsx(inputBase, "min-h-[120px]")}
            disabled={!canAct}
            value={hitlJson}
            onChange={(event) => setHitlJson(event.target.value)}
            onKeyDown={handleJsonKeyDown}
          />
          {parseError ? (
            <p className="font-mono text-[10.5px] text-[#d9534f]" role="alert">
              {parseError}
            </p>
          ) : null}
          <Button
            className="w-max rounded-full bg-amber px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-amber-2 disabled:opacity-60"
            isDisabled={pending || !canAct}
            size="sm"
            type="button"
            onClick={submitJson}
          >
            {t("submit")}
          </Button>
        </div>
      )}
    </section>
  );
}
