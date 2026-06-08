"use client";

import type { HitlOption } from "@/lib/queries/hitl";
import type { ReactElement } from "react";
import type { ReviewSchema } from "@/components/board/hitl-decision-controls";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import {
  HitlDecisionControls,
  formFieldsFromSchema,
} from "@/components/board/hitl-decision-controls";

// Typed MaisterError codes the respond route can return; each has a message in
// messages/*.json under `run.error.<CODE>`. Anything else → `run.error.generic`.
const KNOWN_ERROR_CODES = new Set([
  "CRASH",
  "EXECUTOR_UNAVAILABLE",
  "ACP_PROTOCOL",
  "HITL_TIMEOUT",
  "CONFLICT",
  "CONFIG",
  "NEEDS_INPUT",
  "PRECONDITION",
  "UNAUTHORIZED",
  "ACCOUNT_INACTIVE",
]);

export interface RunHitlResponseProps {
  runId: string;
  hitlRequestId: string;
  kind: "permission" | "form" | "human";
  options: HitlOption[];
  schema: unknown;
  canAct: boolean;
  onRespond?: () => void;
  compact?: boolean;
  criticality?: "low" | "medium" | "high" | "critical" | null;
}

export function RunHitlResponse({
  runId,
  hitlRequestId,
  kind,
  options,
  schema,
  canAct,
  onRespond,
  compact,
  criticality,
}: RunHitlResponseProps): ReactElement {
  const t = useTranslations("run");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [json, setJson] = useState("{}");
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [comments, setComments] = useState("");
  const [confidence, setConfidence] = useState("");

  // Map a typed MaisterError `code` to a localized message. Unknown codes fall
  // back to the generic message so the user never sees a raw code like CONFLICT.
  function errorMessage(code: string): string {
    return KNOWN_ERROR_CODES.has(code)
      ? t(`error.${code}`)
      : t("error.generic");
  }

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

        setError(errorMessage(data?.code ?? "CRASH"));

        return;
      }

      if (onRespond) {
        onRespond();
      } else {
        startTransition(() => router.refresh());
      }
    } catch {
      setError(errorMessage("EXECUTOR_UNAVAILABLE"));
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

    const payload: Record<string, unknown> = { response: parsed };

    if (confidence !== "") {
      payload.confidence = Math.min(1, Math.max(0, Number(confidence)));
    }

    void post(payload);
  }

  function handleFormFieldChange(name: string, value: string): void {
    setFormValues((prev) => ({ ...prev, [name]: value }));
  }

  // Structured form (intake): build the response object from the per-field
  // values, coercing by the field's declared type. The server re-validates
  // against the stored form_schema, so omitted/required fields surface as a
  // NEEDS_INPUT error rather than failing client-side.
  function submitForm(): void {
    const fields = formFieldsFromSchema(schema) ?? [];
    const response: Record<string, unknown> = {};

    for (const field of fields) {
      const raw = formValues[field.name];

      if (raw === undefined || raw === "") continue;

      if (field.type === "number") {
        const n = Number(raw);

        response[field.name] = Number.isFinite(n) ? n : raw;
      } else if (field.type === "boolean") {
        response[field.name] = raw === "true";
      } else {
        response[field.name] = raw;
      }
    }

    void post({ response });
  }

  const disabled = busy || pending || !canAct;

  // M11a graph review HITL: the row's schema declares the allow-list.
  const reviewSchema =
    schema &&
    typeof schema === "object" &&
    (schema as ReviewSchema & { review?: boolean }).review
      ? (schema as ReviewSchema)
      : null;

  const isReworkDecision = (d: string): boolean => {
    if (!reviewSchema) return false;
    const transitions = reviewSchema.transitions ?? {};
    const reworkTargets = reviewSchema.reworkTargets ?? [];

    return (
      Object.hasOwn(transitions, d) && reworkTargets.includes(transitions[d])
    );
  };

  function handleDecision(decision: string): void {
    const response: Record<string, unknown> = { decision };
    const trimmed = comments.trim();

    if (trimmed) response.comments = trimmed;

    const policies = reviewSchema?.workspacePolicies ?? [];

    if (isReworkDecision(decision)) {
      response.workspacePolicy = policies[0] ?? "keep";
    }

    const payload: Record<string, unknown> = { response };

    if (confidence !== "") {
      payload.confidence = Math.min(1, Math.max(0, Number(confidence)));
    }

    void post(payload);
  }

  function handleSendBack(): void {
    // Rework/send-back: pick the first rework decision or fall back to "rework".
    const decisions = reviewSchema?.allowedDecisions ?? [];
    const reworkDecision =
      decisions.find((d) => isReworkDecision(d)) ?? "rework";

    handleDecision(reworkDecision);
  }

  // Confidence applies to form/human/review; NOT permission.
  const showConfidence = kind !== "permission";

  const labels = {
    criticalityLabel: t("criticalityLabel"),
    "criticality.low": t("criticality.low"),
    "criticality.medium": t("criticality.medium"),
    "criticality.high": t("criticality.high"),
    "criticality.critical": t("criticality.critical"),
    confidenceLabel: t("confidenceLabel"),
    reviewComments: t("reviewComments"),
    decisionApprove: t("decisionApprove"),
    decisionRework: t("decisionRework"),
    sendBackWithComments: t("sendBackWithComments"),
    responseLabel: t("responseLabel"),
    responseHint: t("responseHint"),
    schemaLabel: t("schemaLabel"),
    submit: busy ? t("submitting") : t("submit"),
    reviewCommentsPlaceholder: t("reviewCommentsPlaceholder"),
    formInstructions: t("formInstructions"),
    formCustomPlaceholder: t("formCustomPlaceholder"),
  };

  return (
    <HitlDecisionControls
      comments={comments}
      compact={compact}
      confidence={confidence}
      criticality={criticality}
      disabled={disabled}
      error={error}
      formValues={formValues}
      jsonValue={json}
      kind={kind}
      labels={labels}
      options={options}
      reviewSchema={reviewSchema}
      schema={schema}
      showConfidence={showConfidence}
      onCommentsChange={setComments}
      onConfidenceChange={setConfidence}
      onDecision={handleDecision}
      onFormFieldChange={handleFormFieldChange}
      onJsonChange={setJson}
      onOption={(optionId) => void post({ optionId })}
      onSendBack={handleSendBack}
      onSubmitForm={submitForm}
      onSubmitJson={submitJson}
    />
  );
}
