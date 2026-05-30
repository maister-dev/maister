"use client";

import type { HitlOption } from "@/lib/queries/hitl";
import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

interface ReviewSchema {
  review?: boolean;
  allowedDecisions?: string[];
  transitions?: Record<string, string>;
  reworkTargets?: string[];
  workspacePolicies?: string[];
}

export interface RunHitlResponseProps {
  runId: string;
  hitlRequestId: string;
  kind: "permission" | "form" | "human";
  options: HitlOption[];
  schema: unknown;
  canAct: boolean;
}

export function RunHitlResponse({
  runId,
  hitlRequestId,
  kind,
  options,
  schema,
  canAct,
}: RunHitlResponseProps): ReactElement {
  const t = useTranslations("run");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [json, setJson] = useState("{}");
  const [comments, setComments] = useState("");

  async function post(payload: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/runs/${runId}/hitl/${hitlRequestId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        setError(data?.code ?? "CRASH");

        return;
      }

      startTransition(() => router.refresh());
    } catch {
      setError("EXECUTOR_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }

  function submitJson(): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(json);
    } catch {
      setError(t("errorInvalidJson"));

      return;
    }

    void post({ response: parsed });
  }

  const disabled = busy || pending || !canAct;

  // M11a graph review HITL: the row's schema declares the allow-list. Render
  // declared decisions as buttons + a comments box; the decision rides INSIDE
  // the `response` payload (validated server-side against the allow-list).
  const reviewSchema =
    schema && typeof schema === "object" && (schema as ReviewSchema).review
      ? (schema as ReviewSchema)
      : null;

  if (reviewSchema) {
    const decisions = reviewSchema.allowedDecisions ?? [];
    const policies = reviewSchema.workspacePolicies ?? [];
    const reworkTargets = reviewSchema.reworkTargets ?? [];
    const transitions = reviewSchema.transitions ?? {};
    const isReworkDecision = (d: string): boolean =>
      Object.hasOwn(transitions, d) && reworkTargets.includes(transitions[d]);

    const submitDecision = (decision: string): void => {
      const response: Record<string, unknown> = { decision };
      const trimmed = comments.trim();

      if (trimmed) response.comments = trimmed;
      if (isReworkDecision(decision)) {
        response.workspacePolicy = policies[0] ?? "keep";
      }

      void post({ response });
    };

    const decisionLabel = (d: string): string =>
      d === "approve"
        ? t("decisionApprove")
        : d === "rework"
          ? t("decisionRework")
          : d;

    return (
      <div className="flex flex-col gap-3">
        <label
          className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
          htmlFor="review-comments"
        >
          {t("reviewComments")}
        </label>
        <textarea
          className="min-h-[90px] rounded-[10px] border border-line bg-paper p-3 text-[12.5px] text-ink outline-none focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)]"
          id="review-comments"
          placeholder={t("reviewCommentsPlaceholder")}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          {decisions.map((d) => (
            <button
              key={d}
              className={clsx(
                "rounded-lg border px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em]",
                isReworkDecision(d)
                  ? "border-line bg-paper text-mute hover:border-mute hover:text-ink-2"
                  : "border-amber bg-amber text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
                disabled && "opacity-60",
              )}
              disabled={disabled}
              type="button"
              onClick={() => submitDecision(d)}
            >
              {decisionLabel(d)}
            </button>
          ))}
        </div>
        {error ? (
          <p className="font-mono text-[12px] text-[#d9534f]">{error}</p>
        ) : null}
      </div>
    );
  }

  if (kind === "permission") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {options.map((opt) => (
            <button
              key={opt.optionId}
              className={clsx(
                "rounded-lg border px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em]",
                opt.optionId.includes("deny")
                  ? "border-line bg-paper text-mute hover:border-mute hover:text-ink-2"
                  : "border-amber bg-amber text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
                disabled && "opacity-60",
              )}
              disabled={disabled}
              type="button"
              onClick={() => void post({ optionId: opt.optionId })}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {error ? (
          <p className="font-mono text-[12px] text-[#d9534f]">{error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label
        className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
        htmlFor="hitl-response"
      >
        {t("responseLabel")}
      </label>
      <p className="text-[12px] text-mute">{t("responseHint")}</p>
      <textarea
        className="min-h-[120px] rounded-[10px] border border-line bg-paper p-3 font-mono text-[12.5px] text-ink outline-none focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)]"
        id="hitl-response"
        value={json}
        onChange={(e) => setJson(e.target.value)}
      />
      {schema != null ? (
        <details className="text-[11.5px] text-mute">
          <summary className="cursor-pointer font-mono uppercase tracking-[0.06em]">
            {t("schemaLabel")}
          </summary>
          <pre className="mt-2 overflow-auto rounded-lg border border-line-soft bg-ivory p-3 text-[11px] text-ink-2">
            {JSON.stringify(schema, null, 2)}
          </pre>
        </details>
      ) : null}
      {error ? (
        <p className="font-mono text-[12px] text-[#d9534f]">{error}</p>
      ) : null}
      <button
        className="mt-1 inline-flex w-max items-center rounded-full bg-amber px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-8px_var(--amber)] transition-all hover:bg-amber-2 disabled:opacity-60"
        disabled={disabled}
        type="button"
        onClick={submitJson}
      >
        {busy ? t("submitting") : t("submit")}
      </button>
    </div>
  );
}
