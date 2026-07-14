"use client";

import type { HitlOption } from "@/lib/queries/hitl";
import type { ReactElement } from "react";
import type {
  ReviewSchema,
  ReviewThreadCountsView,
} from "@/components/board/hitl-decision-controls";
import type {
  BudgetBreachAvailableOption,
  BudgetBreachClaimStage,
  BudgetBreachParkMode,
  BudgetBreachProgressDto,
} from "@/lib/runs/budget-breach-fork";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import {
  HitlDecisionControls,
  budgetBreachFromSchema,
  consensusHitlFromSchema,
  formFieldsFromSchema,
} from "@/components/board/hitl-decision-controls";
import { requestPendingHitlFocus } from "@/components/board/pending-hitl-focus-restorer";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { resolveUiErrorMessageKey } from "@/lib/ui-error-message";

export interface RunHitlResponseProps {
  runId: string;
  hitlRequestId: string;
  kind:
    | "permission"
    | "form"
    | "human"
    | "agent_question"
    | "infra_recovery"
    | "budget_breach"
    | "hook_trip"
    | "decision_request";
  options: HitlOption[];
  availableOptions?: BudgetBreachAvailableOption[];
  budgetProgress?: BudgetBreachProgressDto | null;
  claimStage?: BudgetBreachClaimStage | null;
  schema: unknown;
  canAct: boolean;
  onRespond?: () => void;
  restoreFocusAfterResponse?: boolean;
  compact?: boolean;
  criticality?: "low" | "medium" | "high" | "critical" | null;
  // ADR-071 Task 13: server-computed open/outdated review-thread counts for
  // the run-detail gate panel; board/inbox consumers omit it (no badges, no
  // approve soft-warn there).
  reviewCounts?: ReviewThreadCountsView | null;
}

export function RunHitlResponse({
  runId,
  hitlRequestId,
  kind,
  options,
  availableOptions,
  budgetProgress,
  claimStage,
  schema,
  canAct,
  onRespond,
  restoreFocusAfterResponse = false,
  compact,
  criticality,
  reviewCounts,
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
  const [budgetParkMode, setBudgetParkMode] =
    useState<BudgetBreachParkMode>("snapshot");
  const [budgetBranchName, setBudgetBranchName] = useState("");
  const [budgetDropWorkspace, setBudgetDropWorkspace] = useState(false);
  const [confirmingBudgetAbandon, setConfirmingBudgetAbandon] = useState(false);
  // Pre-fill the raise input with the suggested ceiling = breached current × 2
  // (spec §6.2). `current` ≥ the breached limit at escalate, so current × 2 is
  // always a valid suggestion (> limit). Empty for non-budget kinds.
  const [budgetCeiling, setBudgetCeiling] = useState(() => {
    const breach = budgetBreachFromSchema(schema);

    return breach ? String(breach.current * 2) : "";
  });

  // Map a typed MaisterError `code` to a localized message. Unknown codes fall
  // back to the generic message so the user never sees a raw code like CONFLICT.
  function errorMessage(code: unknown): string {
    return t(resolveUiErrorMessageKey(code));
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

        setError(errorMessage(data?.code));

        return;
      }

      if (onRespond) {
        onRespond();
      } else {
        if (restoreFocusAfterResponse) {
          requestPendingHitlFocus(runId);
        }

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

  const activeBudgetClaim =
    kind === "budget_breach" &&
    claimStage !== null &&
    claimStage !== "failed" &&
    claimStage !== "relaunch_failed";
  const disabled = busy || pending || !canAct || activeBudgetClaim;

  // M11a graph review HITL: the row's schema declares the allow-list.
  const reviewSchema =
    schema &&
    typeof schema === "object" &&
    (schema as ReviewSchema & { review?: boolean }).review
      ? (schema as ReviewSchema)
      : null;
  const consensusHitl =
    kind === "human" ? consensusHitlFromSchema(schema) : null;

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

    if (consensusHitl && decision === "provide-resolution") {
      if (!trimmed) {
        setError(t("consensusResolutionRequired"));

        return;
      }

      response.resolution = trimmed;
    } else if (trimmed) {
      response.comments = trimmed;
    }

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

  // budget_breach raise: POST the canonical object while the service still
  // accepts the legacy raiseTo/number response payloads for old clients.
  function handleBudgetRaise(): void {
    const breach = budgetBreachFromSchema(schema);
    const trimmed = budgetCeiling.trim();
    const n = Number(trimmed);

    if (
      trimmed === "" ||
      !Number.isInteger(n) ||
      n <= 0 ||
      (breach && n <= breach.limit)
    ) {
      setError(t("budgetRaiseInvalid"));

      return;
    }

    void post({
      optionId: "raise",
      response: { dimension: breach?.meter, newLimit: n },
    });
  }

  function handleBudgetRestart(): void {
    void post({ optionId: "restart" });
  }

  function handleBudgetPark(): void {
    const branchName = budgetBranchName.trim();

    if (budgetParkMode === "export" && branchName.length === 0) {
      setError(t("budgetParkBranchRequired"));

      return;
    }

    void post({
      optionId: "park",
      response: {
        mode: budgetParkMode,
        ...(budgetParkMode === "export" ? { branchName } : {}),
      },
    });
  }

  function handleBudgetAbandon(): void {
    if (budgetDropWorkspace) {
      setConfirmingBudgetAbandon(true);

      return;
    }

    void post({
      optionId: "abandon",
      response: { dropWorkspace: budgetDropWorkspace },
    });
  }

  function confirmBudgetAbandon(): void {
    void post({
      optionId: "abandon",
      response: { dropWorkspace: budgetDropWorkspace },
    });
  }

  // Confidence applies to form/human/review; NOT a task clarification,
  // permission, infra_recovery, budget_breach, or hook_trip. An agent question
  // records the human's schema answer only and never resumes its terminal source.
  const showConfidence =
    kind !== "permission" &&
    kind !== "agent_question" &&
    kind !== "infra_recovery" &&
    kind !== "budget_breach" &&
    kind !== "hook_trip" &&
    kind !== "decision_request" &&
    !consensusHitl;

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
    submit:
      kind === "agent_question"
        ? busy
          ? t("answeringClarification")
          : t("answerClarification")
        : busy
          ? t("submitting")
          : t("submit"),
    reviewCommentsPlaceholder: t("reviewCommentsPlaceholder"),
    formInstructions:
      kind === "agent_question"
        ? t("agentQuestionInstructions")
        : t("formInstructions"),
    formCustomPlaceholder: t("formCustomPlaceholder"),
    reviewOpenCount: t("reviewOpenCount"),
    reviewOutdatedCount: t("reviewOutdatedCount"),
    reviewLoopChip: t("reviewLoopChip"),
    reviewApproveOpenWarn: t("reviewApproveOpenWarn"),
    reviewReworkExhausted: t("reviewReworkExhausted"),
    infraRecoveryRetry: t("infraRecoveryRetry"),
    infraRecoveryAbandon: t("infraRecoveryAbandon"),
    budgetBreachTitle: t("budgetBreachTitle"),
    budgetNewCeiling: t("budgetNewCeiling"),
    budgetRaiseResume: t("budgetRaiseResume"),
    budgetRestart: t("budgetRestart"),
    budgetPark: t("budgetPark"),
    budgetAbandon: t("budgetAbandon"),
    budgetDropWorkspace: t("budgetDropWorkspace"),
    budgetParkModeSnapshot: t("budgetParkModeSnapshot"),
    budgetParkModeExport: t("budgetParkModeExport"),
    budgetParkBranchName: t("budgetParkBranchName"),
    budgetParkBranchPlaceholder: t("budgetParkBranchPlaceholder"),
    budgetProgressLabel: t("budgetProgressLabel"),
    budgetProgressBudget: t("budgetProgressBudget"),
    budgetProgressNodes: t("budgetProgressNodes"),
    budgetProgressDiff: t("budgetProgressDiff"),
    budgetProgressGates: t("budgetProgressGates"),
    budgetProgressWallclock: t("budgetProgressWallclock"),
    budgetProgressResumes: t("budgetProgressResumes"),
    budgetProgressNoData: t("budgetProgressNoData"),
    budgetClaimStage: t("budgetClaimStage"),
    "budgetClaimStage.claimed": t("budgetClaimStageLabels.claimed"),
    "budgetClaimStage.preserving": t("budgetClaimStageLabels.preserving"),
    "budgetClaimStage.terminalized": t("budgetClaimStageLabels.terminalized"),
    "budgetClaimStage.failed": t("budgetClaimStageLabels.failed"),
    "budgetClaimStage.relaunch_failed": t(
      "budgetClaimStageLabels.relaunch_failed",
    ),
    budgetBreachSummary: t("budgetBreachSummary"),
    "budgetScope.run": t("budgetScope.run"),
    "budgetScope.task": t("budgetScope.task"),
    "budgetScope.tree": t("budgetScope.tree"),
    "budgetMeter.tokens": t("budgetMeter.tokens"),
    "budgetMeter.failures": t("budgetMeter.failures"),
    "budgetMeter.wallclock": t("budgetMeter.wallclock"),
    hookTripTitle: t("hookTripTitle"),
    hookTripSummary: t("hookTripSummary"),
    "hookTripRule.repetition": t("hookTripRule.repetition"),
    "hookTripRule.no_progress": t("hookTripRule.no_progress"),
    "hookTripRule.capability_guard": t("hookTripRule.capability_guard"),
    hookTripToolCall: t("hookTripToolCall"),
    hookTripResume: t("hookTripResume"),
    hookTripAbort: t("hookTripAbort"),
    consensusTitle: t("consensusTitle"),
    consensusRound: t("consensusRound"),
    consensusDrafts: t("consensusDrafts"),
    consensusDisagreements: t("consensusDisagreements"),
    consensusNoDisagreements: t("consensusNoDisagreements"),
    consensusDebateLog: t("consensusDebateLog"),
    consensusDraftFallback: t("consensusDraftFallback"),
    consensusPickDraft: t("consensusPickDraft"),
    consensusResolutionLabel: t("consensusResolutionLabel"),
    consensusResolutionPlaceholder: t("consensusResolutionPlaceholder"),
    consensusProvideResolution: t("consensusProvideResolution"),
    consensusRerunRound: t("consensusRerunRound"),
    consensusAbort: t("consensusAbort"),
    planDecisionTitle: t("planDecisionTitle"),
    planDecisionRecommendation: t("planDecisionRecommendation"),
    planReviewAssumptions: t("planReviewAssumptions"),
    planReviewAssumptionDefault: t("planReviewAssumptionDefault"),
    planReviewAssumptionImpact: t("planReviewAssumptionImpact"),
    planReviewApprovalBlocked: t("planReviewApprovalBlocked"),
  };

  return (
    <>
      <HitlDecisionControls
        availableOptions={availableOptions}
        budgetBranchName={budgetBranchName}
        budgetCeiling={budgetCeiling}
        budgetDropWorkspace={budgetDropWorkspace}
        budgetParkMode={budgetParkMode}
        budgetProgress={budgetProgress}
        claimStage={claimStage}
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
        reviewCounts={reviewCounts}
        reviewSchema={reviewSchema}
        schema={schema}
        showConfidence={showConfidence}
        onBudgetAbandon={handleBudgetAbandon}
        onBudgetBranchNameChange={setBudgetBranchName}
        onBudgetCeilingChange={setBudgetCeiling}
        onBudgetDropWorkspaceChange={setBudgetDropWorkspace}
        onBudgetPark={handleBudgetPark}
        onBudgetParkModeChange={setBudgetParkMode}
        onBudgetRaise={handleBudgetRaise}
        onBudgetRestart={handleBudgetRestart}
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
      {confirmingBudgetAbandon ? (
        <ConfirmDialog
          body={t("budgetDropConfirm")}
          busy={busy}
          cancelLabel={t("cancel")}
          testId="budget-drop-confirm"
          title={t("budgetDropConfirmTitle")}
          titleId="budget-drop-confirm-title"
          onClose={() => setConfirmingBudgetAbandon(false)}
        >
          <div className="flex items-center justify-end gap-2">
            <button
              className="rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold text-mute hover:border-mute hover:text-ink-2 disabled:opacity-50"
              disabled={busy}
              type="button"
              onClick={() => setConfirmingBudgetAbandon(false)}
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-lg border border-danger-line bg-danger-soft px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-danger hover:bg-paper disabled:opacity-50"
              data-testid="budget-drop-confirm-submit"
              disabled={busy}
              type="button"
              onClick={confirmBudgetAbandon}
            >
              {t("budgetAbandon")}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
