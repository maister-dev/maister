"use client";

import type { NodeDef } from "@/lib/config.schema";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";

import {
  waitConditionSchema,
  waitOutcomes,
  waitSeconds,
  waitTransitionError,
} from "@/lib/waits/manifest";

type WaitNode = Extract<NodeDef, { type: "wait" }>;

export function WaitFields({
  node,
  readOnly,
  onChange,
}: {
  node: WaitNode;
  readOnly: boolean;
  onChange: (node: WaitNode) => void;
}) {
  const t = useTranslations("flowWait");
  const labelId = useId();
  const [source, setSource] = useState(() => JSON.stringify(node.on, null, 2));
  const [timeout, setTimeout] = useState(String(node.timeout));
  const [error, setError] = useState(false);

  function apply(): void {
    let value: unknown;

    try {
      value = JSON.parse(source);
    } catch (parseError: unknown) {
      if (!(parseError instanceof SyntaxError)) throw parseError;
      setError(true);

      return;
    }

    const on = waitConditionSchema.safeParse(value);
    const seconds = waitSeconds.safeParse(Number(timeout));

    if (!on.success || !seconds.success) {
      setError(true);

      return;
    }
    const outcomes = [
      ...waitOutcomes(on.data),
      ...(node.rework?.onExhaustion ? [node.rework.onExhaustion] : []),
    ];
    const transitions = Object.fromEntries(
      outcomes.map((outcome) => [
        outcome,
        node.transitions?.[outcome] ?? "done",
      ]),
    );

    if (waitTransitionError(on.data, transitions, node.rework?.onExhaustion)) {
      setError(true);

      return;
    }

    setError(false);
    onChange({ ...node, on: on.data, timeout: seconds.data, transitions });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="wait-condition-editor">
      <label className="flex flex-col gap-1">
        <span>{t("conditionJson")}</span>
        <textarea
          aria-describedby={error ? labelId : undefined}
          aria-invalid={error}
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
      {error && (
        <p id={labelId} role="alert">
          {t("invalidCondition")}
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
      <dl
        aria-label={t("transitions")}
        className="grid grid-cols-2 gap-1 text-sm"
      >
        {Object.entries(node.transitions ?? {}).map(([outcome, target]) => (
          <div key={outcome} className="contents">
            <dt>{outcome}</dt>
            <dd>
              {typeof target === "string"
                ? target
                : t(`failure.${target.reason}`)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
