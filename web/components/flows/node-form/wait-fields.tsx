"use client";

import type { NodeDef } from "@/lib/config.schema";
import type { TransitionTarget } from "@/lib/flows/graph/transition-target";
import type { WaitCondition } from "@/lib/waits/manifest";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";

import {
  waitConditionSchema,
  waitOutcomes,
  waitSeconds,
  waitTransitionError,
} from "@/lib/waits/manifest";

type WaitNode = Extract<NodeDef, { type: "wait" }>;

const RETAIN_FAILURE = "@classified-failure";

function parseCondition(source: string): WaitCondition | null {
  let value: unknown;

  try {
    value = JSON.parse(source);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = waitConditionSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

export function WaitFields({
  node,
  readOnly,
  targets,
  onChange,
}: {
  node: WaitNode;
  readOnly: boolean;
  targets: readonly string[];
  onChange: (node: WaitNode) => void;
}) {
  const t = useTranslations("flowWait");
  const labelId = useId();
  const [source, setSource] = useState(() => JSON.stringify(node.on, null, 2));
  const [timeout, setTimeout] = useState(String(node.timeout));
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [error, setError] = useState<
    "invalidCondition" | "missingTargets" | null
  >(null);
  const condition = parseCondition(source);
  const exhaustion = node.rework?.onExhaustion;
  const outcomes = condition
    ? [
        ...new Set([
          ...waitOutcomes(condition),
          ...(exhaustion ? [exhaustion] : []),
        ]),
      ]
    : [];
  const graphTargets = new Set(["done", ...targets]);

  function selectedTarget(outcome: string): string {
    const existing = node.transitions[outcome];

    return (
      overrides[outcome] ??
      (typeof existing === "object" ? RETAIN_FAILURE : (existing ?? ""))
    );
  }

  function apply(): void {
    const seconds = waitSeconds.safeParse(Number(timeout));

    if (!condition || !seconds.success) {
      setError("invalidCondition");

      return;
    }
    const transitions: Record<string, TransitionTarget> = {};

    for (const outcome of outcomes) {
      const selection = selectedTarget(outcome);
      const existing = node.transitions[outcome];

      if (selection === RETAIN_FAILURE && typeof existing === "object") {
        transitions[outcome] = existing;
      } else if (graphTargets.has(selection)) {
        transitions[outcome] = selection;
      } else {
        setError("missingTargets");

        return;
      }
    }
    if (waitTransitionError(condition, transitions, exhaustion)) {
      setError("missingTargets");

      return;
    }
    setError(null);
    setOverrides({});
    onChange({ ...node, on: condition, timeout: seconds.data, transitions });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="wait-condition-editor">
      <label className="flex flex-col gap-1">
        <span>{t("conditionJson")}</span>
        <textarea
          aria-describedby={error === "invalidCondition" ? labelId : undefined}
          aria-invalid={error === "invalidCondition"}
          className="rounded border border-line bg-paper p-2 font-mono text-sm"
          readOnly={readOnly}
          rows={8}
          spellCheck={false}
          value={source}
          onChange={(event) => setSource(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span>{t("timeoutSeconds")}</span>
        <input
          className="rounded border border-line bg-paper p-2"
          min="1"
          readOnly={readOnly}
          step="1"
          type="number"
          value={timeout}
          onChange={(event) => setTimeout(event.target.value)}
        />
      </label>
      {condition && (
        <fieldset
          aria-describedby={error === "missingTargets" ? labelId : undefined}
          className="grid gap-2"
        >
          <legend className="text-sm font-medium">{t("transitions")}</legend>
          {outcomes.map((outcome) => {
            const existing = node.transitions[outcome];

            return (
              <label key={outcome} className="grid gap-1 text-sm">
                <span>{t("targetFor", { outcome })}</span>
                {readOnly ? (
                  <span>
                    {typeof existing === "object"
                      ? t(`failure.${existing.reason}`)
                      : (existing ?? "—")}
                  </span>
                ) : (
                  <select
                    className="rounded border border-line bg-paper p-1"
                    value={selectedTarget(outcome)}
                    onChange={(event) =>
                      setOverrides((current) => ({
                        ...current,
                        [outcome]: event.target.value,
                      }))
                    }
                  >
                    <option value="">{t("chooseTarget")}</option>
                    {[...graphTargets].map((target) => (
                      <option key={target} value={target}>
                        {target === "done" ? t("completeGraph") : target}
                      </option>
                    ))}
                    {typeof existing === "object" && (
                      <option value={RETAIN_FAILURE}>
                        {t(`failure.${existing.reason}`)}
                      </option>
                    )}
                  </select>
                )}
              </label>
            );
          })}
        </fieldset>
      )}
      {error && (
        <p id={labelId} role="alert">
          {t(error)}
        </p>
      )}
      {!readOnly && (
        <button
          className="self-start rounded border border-line px-2 py-1"
          type="button"
          onClick={apply}
        >
          {t("applyCondition")}
        </button>
      )}
    </div>
  );
}
