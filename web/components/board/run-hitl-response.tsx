"use client";

import type { HitlOption } from "@/lib/queries/hitl";
import type {
  HitlAnswerState,
  HitlStoredResponse,
} from "@/lib/hitl-response-contract";
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
import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@heroui/react";
import { ArrowPathIcon } from "@heroicons/react/24/outline";

import {
  HitlDecisionControls,
  type NodeInterruptOptionMatrixView,
  budgetBreachFromSchema,
  coerceFormFieldValue,
  consensusHitlFromSchema,
  formFieldsFromSchema,
} from "@/components/board/hitl-decision-controls";
import { requestPendingHitlFocus } from "@/components/board/pending-hitl-focus-restorer";
import {
  canReplayHitlAnswer,
  isPendingHitlDeliveryState,
} from "@/lib/hitl-response-contract";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { useOptionalFeedback } from "@/components/feedback/feedback-provider";
import {
  isStaleViewErrorCode,
  resolveHitlErrorMessage,
  resolveUiErrorMessageKey,
  type HitlErrorMessage,
} from "@/lib/ui-error-message";

type ReviewFeedbackPreview = {
  reviewSource: {
    scope: "review";
    baseCommit: string;
    fingerprint: string;
  };
  feedback: {
    fingerprint: string;
    target: { nodeId: string; commentsVar: string };
    openThreadIds: string[];
    resolvedThreadCount: number;
    gateChatMessageCount: number;
    payload: string;
  };
};

type PendingReviewRework = {
  response: Record<string, unknown>;
  preview: ReviewFeedbackPreview;
};

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
    // ADR-161: the operator node interrupt.
    | "node_interrupt"
    | "decision_request";
  options: HitlOption[];
  answerState: HitlAnswerState;
  storedResponse: HitlStoredResponse | null;
  availableOptions?: BudgetBreachAvailableOption[];
  // ADR-161: the server-owned interrupt matrix, passed straight through.
  nodeInterrupt?: NodeInterruptOptionMatrixView | null;
  budgetProgress?: BudgetBreachProgressDto | null;
  claimStage?: BudgetBreachClaimStage | null;
  schema: unknown;
  canAct: boolean;
  surface?: "flow" | "scratch";
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
  answerState,
  storedResponse,
  availableOptions,
  nodeInterrupt,
  budgetProgress,
  claimStage,
  schema,
  canAct,
  surface = "flow",
  onRespond,
  restoreFocusAfterResponse = false,
  compact,
  criticality,
  reviewCounts,
}: RunHitlResponseProps): ReactElement {
  const t = useTranslations("run");
  const router = useRouter();
  const feedback = useOptionalFeedback();
  const [pending, startTransition] = useTransition();
  const submissionOrdinal = useRef(0);
  const [busyRequestKey, setBusyRequestKey] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<{
    requestKey: string;
    message: string | null;
  } | null>(null);
  const [refusal, setRefusal] = useState<{
    requestKey: string;
    descriptor: HitlErrorMessage;
  } | null>(null);
  const [diagnosticState, setDiagnosticState] = useState<{
    requestKey: string;
    code: string | null;
  } | null>(null);
  const [localAnswer, setLocalAnswer] = useState<{
    requestKey: string;
    payload: HitlStoredResponse | null;
    reconciling: boolean;
    completed?: boolean;
  } | null>(null);
  const requestKey = `${runId}:${hitlRequestId}`;
  const busy = busyRequestKey === requestKey;
  const error =
    refusal?.requestKey === requestKey
      ? t(refusal.descriptor.key, refusal.descriptor.values)
      : errorState?.requestKey === requestKey
        ? errorState.message
        : null;
  const diagnostic =
    diagnosticState?.requestKey === requestKey ? diagnosticState.code : null;

  function setError(message: string | null): void {
    setRefusal(null);
    setErrorState({ requestKey, message });
    setDiagnosticState({ requestKey, code: null });
  }

  function setDiagnostic(code: string | null): void {
    setDiagnosticState({ requestKey, code });
  }
  const activeRequestKey = useRef(requestKey);
  const storedActionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeRequestKey.current = requestKey;
  }, [requestKey]);
  const currentAnswer =
    localAnswer?.requestKey === requestKey ? localAnswer : null;
  const budgetClaimCanBeReplaced =
    kind === "budget_breach" && claimStage === "failed";
  const isStored =
    (answerState === "answer_stored" || currentAnswer !== null) &&
    !budgetClaimCanBeReplaced;
  const canReplaySubmittedAnswer = canReplayHitlAnswer(kind, schema);
  const retryPayload =
    answerState === "answer_stored"
      ? storedResponse
      : (currentAnswer?.payload ?? null);

  useEffect(() => {
    if (currentAnswer !== null && !busy) storedActionRef.current?.focus();
  }, [currentAnswer, busy]);
  const [json, setJson] = useState("{}");
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [comments, setComments] = useState("");
  const [pendingReviewRework, setPendingReviewRework] =
    useState<PendingReviewRework | null>(null);
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

  // A refusal that means this card no longer reflects the run. Leaving it as
  // rendered hands the operator live-looking buttons on a request the server
  // will keep refusing, which is how a stale permission card outlives its run.
  function reportError(
    body: {
      code?: unknown;
      details?: { reason?: unknown; causeCode?: unknown } | null;
    },
    submissionId = `${requestKey}:${++submissionOrdinal.current}`,
  ): void {
    const descriptor = resolveHitlErrorMessage({
      ...body,
      surface,
      answerState: isStored ? "answer_stored" : "open",
    });
    const message = t(descriptor.key, descriptor.values);

    setRefusal({ requestKey, descriptor });
    setDiagnostic(descriptor.causeCode ?? null);

    if (body.code === "HITL_TIMEOUT") {
      feedback?.error({ message, mutationId: `hitl-terminal:${submissionId}` });
    }

    if (
      body.details?.reason === "permission_resume_in_flight" ||
      body.details?.reason === "option_mismatch"
    ) {
      setLocalAnswer({ requestKey, payload: null, reconciling: true });
    }

    if (isStaleViewErrorCode(body.code)) {
      startTransition(() => router.refresh());
    }
  }

  async function post(payload: Record<string, unknown>): Promise<void> {
    const submissionId = `${requestKey}:${++submissionOrdinal.current}`;

    setBusyRequestKey(requestKey);
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
          details?: { reason?: string; causeCode?: string };
        } | null;

        if (activeRequestKey.current !== requestKey) return;

        if (
          data?.code === "EXECUTOR_UNAVAILABLE" &&
          data.details?.reason === "delivery_unavailable"
        ) {
          setLocalAnswer({
            requestKey,
            payload: canReplaySubmittedAnswer
              ? (payload as HitlStoredResponse)
              : null,
            reconciling: !canReplaySubmittedAnswer,
          });
        }
        reportError(data ?? {}, submissionId);

        return;
      }

      const accepted = (await res.json().catch(() => null)) as {
        state?: string;
      } | null;

      if (activeRequestKey.current !== requestKey) return;

      if (res.status === 202 && accepted?.state === "resume-queued") {
        setLocalAnswer({
          requestKey,
          payload: null,
          reconciling: true,
          completed: true,
        });
      } else if (
        res.status === 202 &&
        isPendingHitlDeliveryState(accepted?.state)
      ) {
        setLocalAnswer({
          requestKey,
          payload: canReplaySubmittedAnswer
            ? (payload as HitlStoredResponse)
            : null,
          reconciling: !canReplaySubmittedAnswer,
        });
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
      if (activeRequestKey.current === requestKey)
        setError(t("deliveryUnconfirmed"));
    } finally {
      setBusyRequestKey((current) => (current === requestKey ? null : current));
    }
  }

  async function previewReviewRework(
    response: Record<string, unknown>,
  ): Promise<void> {
    setBusyRequestKey(requestKey);
    setError(null);

    try {
      const res = await fetch(
        `/api/runs/${runId}/hitl/${hitlRequestId}/review-feedback-preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | (ReviewFeedbackPreview & { code?: string })
        | null;

      if (!res.ok || body === null || !("feedback" in body)) {
        reportError(body ?? {});

        return;
      }

      setPendingReviewRework({ response, preview: body });
    } catch {
      setError(errorMessage("EXECUTOR_UNAVAILABLE"));
    } finally {
      setBusyRequestKey((current) => (current === requestKey ? null : current));
    }
  }

  function confirmReviewRework(): void {
    if (pendingReviewRework === null) return;

    const { preview, response } = pendingReviewRework;

    setPendingReviewRework(null);
    void post({
      response,
      reviewSourceFingerprint: preview.reviewSource.fingerprint,
      reviewFeedbackFingerprint: preview.feedback.fingerprint,
    });
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

      response[field.name] = coerceFormFieldValue(field.type, raw);
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

    if (isReworkDecision(decision)) {
      void previewReviewRework(response);
    } else {
      void post({ response });
    }
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

  const labels = {
    criticalityLabel: t("criticalityLabel"),
    "criticality.low": t("criticality.low"),
    "criticality.medium": t("criticality.medium"),
    "criticality.high": t("criticality.high"),
    "criticality.critical": t("criticality.critical"),
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
    jsonFieldParsed: t("jsonFieldParsed"),
    jsonFieldPlainText: t("jsonFieldPlainText"),
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

  const specialized =
    kind === "budget_breach" ||
    kind === "infra_recovery" ||
    kind === "hook_trip" ||
    kind === "node_interrupt" ||
    kind === "decision_request" ||
    reviewSchema !== null ||
    consensusHitl !== null;
  const decisionControls = (
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
      criticality={criticality}
      disabled={disabled || isStored}
      error={isStored ? null : error}
      formValues={formValues}
      jsonValue={json}
      kind={kind}
      labels={labels}
      nodeInterrupt={nodeInterrupt}
      options={options}
      reviewCounts={reviewCounts}
      reviewSchema={reviewSchema}
      schema={schema}
      onBudgetAbandon={handleBudgetAbandon}
      onBudgetBranchNameChange={setBudgetBranchName}
      onBudgetCeilingChange={setBudgetCeiling}
      onBudgetDropWorkspaceChange={setBudgetDropWorkspace}
      onBudgetPark={handleBudgetPark}
      onBudgetParkModeChange={setBudgetParkMode}
      onBudgetRaise={handleBudgetRaise}
      onBudgetRestart={handleBudgetRestart}
      onCommentsChange={setComments}
      onDecision={handleDecision}
      onFormFieldChange={handleFormFieldChange}
      onJsonChange={setJson}
      onNodeInterrupt={(payload) => void post(payload)}
      onOption={(optionId) => void post({ optionId })}
      onSendBack={handleSendBack}
      onSubmitForm={submitForm}
      onSubmitJson={submitJson}
    />
  );

  if (isStored) {
    const savedOption =
      retryPayload && "optionId" in retryPayload
        ? options.find((option) => option.optionId === retryPayload.optionId)
        : undefined;
    const validPayload =
      retryPayload !== null &&
      (kind !== "permission" || savedOption !== undefined);
    const reconciling =
      currentAnswer?.reconciling && answerState !== "answer_stored";

    return (
      <>
        <span aria-live="polite" className="sr-only">
          {t(currentAnswer?.completed ? "answerRecorded" : "answerSaved")}
        </span>
        <div
          className="grid gap-2 rounded-lg border border-line bg-ivory p-3"
          data-testid={
            currentAnswer?.completed
              ? "hitl-answer-recorded"
              : "hitl-answer-stored"
          }
        >
          {refusal?.requestKey === requestKey &&
          refusal.descriptor.key ===
            "errorReasons.delivery_unavailable" ? null : (
            <p className="text-sm text-ink-2">
              {t(currentAnswer?.completed ? "answerRecorded" : "answerSaved")}
            </p>
          )}
          {savedOption ? (
            <p className="font-semibold text-ink">{savedOption.label}</p>
          ) : null}
          {retryPayload && "response" in retryPayload ? (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-2">
                {t("savedResponse")}
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-paper p-2 text-xs text-ink-2">
                {typeof retryPayload.response === "string"
                  ? retryPayload.response
                  : JSON.stringify(retryPayload.response, null, 2)}
              </pre>
            </div>
          ) : null}
          {!validPayload && !reconciling ? (
            <p className="text-xs text-mute" role="status">
              {retryPayload && "optionId" in retryPayload
                ? t("savedInvalidOption")
                : t("savedNoReplay")}
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-[var(--status-red)]" role="alert">
              {error}
            </p>
          ) : null}
          {diagnostic ? (
            <p className="text-xs text-mute">
              {t("errorDiagnostic")}: <code>{diagnostic}</code>
            </p>
          ) : null}
          {specialized ? decisionControls : null}
          <div className="flex gap-2">
            {canAct && validPayload && !reconciling ? (
              <Button
                ref={storedActionRef}
                className="border-amber bg-amber font-mono text-xs font-semibold text-white"
                isDisabled={busy || pending}
                size="sm"
                type="button"
                onClick={() =>
                  void post(retryPayload as Record<string, unknown>)
                }
              >
                <ArrowPathIcon aria-hidden="true" className="size-4" />
                {t("retryDelivery")}
              </Button>
            ) : null}
            {reconciling ? (
              <Button
                ref={storedActionRef}
                className="border-line bg-paper font-mono text-xs font-semibold text-ink-2"
                size="sm"
                type="button"
                variant="outline"
                onClick={() => router.refresh()}
              >
                <ArrowPathIcon aria-hidden="true" className="size-4" />
                {t("refreshAnswer")}
              </Button>
            ) : null}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <span aria-live="polite" className="sr-only" />
      {decisionControls}
      {diagnostic ? (
        <p className="text-xs text-mute">
          {t("errorDiagnostic")}: <code>{diagnostic}</code>
        </p>
      ) : null}
      {pendingReviewRework ? (
        <ConfirmDialog
          body={t("reviewPreviewBody", {
            source: pendingReviewRework.preview.reviewSource.baseCommit,
            target: pendingReviewRework.preview.feedback.target.nodeId,
            threads: pendingReviewRework.preview.feedback.openThreadIds.length,
            resolved: pendingReviewRework.preview.feedback.resolvedThreadCount,
            chat: pendingReviewRework.preview.feedback.gateChatMessageCount,
          })}
          busy={busy}
          cancelLabel={t("reviewPreviewCancel")}
          testId="review-feedback-preview"
          title={t("reviewPreviewTitle")}
          titleId="review-feedback-preview-title"
          onClose={() => setPendingReviewRework(null)}
        >
          <div className="grid gap-3">
            <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-ivory p-3 whitespace-pre-wrap font-mono text-[11px] leading-[1.5] text-ink-2">
              {pendingReviewRework.preview.feedback.payload}
            </pre>
            <div className="flex items-center justify-end gap-2">
              <button
                className="rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold text-mute hover:border-mute hover:text-ink-2 disabled:opacity-50"
                disabled={busy}
                type="button"
                onClick={() => setPendingReviewRework(null)}
              >
                {t("reviewPreviewCancel")}
              </button>
              <button
                className="rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-50"
                data-testid="review-feedback-preview-confirm"
                disabled={busy}
                type="button"
                onClick={confirmReviewRework}
              >
                {t("reviewPreviewConfirm")}
              </button>
            </div>
          </div>
        </ConfirmDialog>
      ) : null}
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
