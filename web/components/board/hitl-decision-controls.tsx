import type { HitlOption } from "@/lib/queries/hitl";
import type { ReactElement } from "react";

import clsx from "clsx";

export interface HitlDecisionControlsLabels {
  criticalityLabel: string;
  "criticality.low": string;
  "criticality.medium": string;
  "criticality.high": string;
  "criticality.critical": string;
  confidenceLabel: string;
  reviewComments: string;
  decisionApprove: string;
  decisionRework: string;
  sendBackWithComments: string;
  responseLabel: string;
  responseHint: string;
  schemaLabel: string;
  submit: string;
  reviewCommentsPlaceholder: string;
  formInstructions: string;
  formCustomPlaceholder: string;
}

export interface ReviewSchema {
  allowedDecisions?: string[];
  transitions?: Record<string, string>;
  reworkTargets?: string[];
  workspacePolicies?: string[];
}

// A single field view derived from a stored `form_schema` doc (config.schema
// `formSchemaSchema`). Narrowed structurally so the pure presentational layer
// stays decoupled from the server-side Zod type.
export interface HitlFormFieldView {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: string[];
}

// A `form` HITL renders option buttons + free-text per field ONLY when the
// stored schema is a form-schema doc with a non-empty `fields[]`. Any other
// schema (or a non-form kind) falls back to the raw-JSON response textarea.
export function formFieldsFromSchema(
  schema: unknown,
): HitlFormFieldView[] | null {
  if (!schema || typeof schema !== "object") return null;
  const fields = (schema as { fields?: unknown }).fields;

  if (!Array.isArray(fields) || fields.length === 0) return null;

  const views = fields.filter(
    (f): f is HitlFormFieldView =>
      !!f &&
      typeof f === "object" &&
      typeof (f as { name?: unknown }).name === "string",
  );

  return views.length > 0 ? views : null;
}

export interface HitlDecisionControlsProps {
  kind: "permission" | "form" | "human";
  reviewSchema: ReviewSchema | null;
  options: HitlOption[];
  schema: unknown;
  criticality?: "low" | "medium" | "high" | "critical" | null;
  showConfidence: boolean;
  confidence: string;
  comments: string;
  jsonValue: string;
  formValues: Record<string, string>;
  disabled: boolean;
  compact?: boolean;
  error: string | null;
  labels: HitlDecisionControlsLabels;
  onConfidenceChange: (v: string) => void;
  onCommentsChange: (v: string) => void;
  onJsonChange: (v: string) => void;
  onFormFieldChange: (name: string, value: string) => void;
  onDecision: (decision: string) => void;
  onSendBack: () => void;
  onOption: (optionId: string) => void;
  onSubmitJson: () => void;
  onSubmitForm: () => void;
}

const CRITICALITY_PILL: Record<"low" | "medium" | "high" | "critical", string> =
  {
    low: "border-line text-mute bg-ivory",
    medium: "border-amber-line bg-amber-soft text-amber",
    high: "border-[color-mix(in_oklab,var(--amber)_60%,var(--red-500))] bg-[color-mix(in_oklab,var(--amber-soft)_70%,transparent)] text-[color-mix(in_oklab,var(--amber)_70%,var(--red-500))]",
    critical: "border-red-500/40 bg-red-500/10 text-red-500",
  };

function CriticalityBadge({
  criticality,
  labels,
}: {
  criticality: "low" | "medium" | "high" | "critical";
  labels: HitlDecisionControlsLabels;
}): ReactElement {
  const levelLabel =
    labels[`criticality.${criticality}` as keyof HitlDecisionControlsLabels];

  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
        {labels.criticalityLabel}
      </span>
      <span
        className={clsx(
          "rounded-full border px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.04em]",
          CRITICALITY_PILL[criticality],
        )}
      >
        {levelLabel}
      </span>
    </div>
  );
}

function ConfidenceInput({
  confidence,
  label,
  onChange,
  disabled,
}: {
  confidence: string;
  label: string;
  onChange: (v: string) => void;
  disabled: boolean;
}): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <label
        className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
        htmlFor="hitl-confidence"
      >
        {label}
      </label>
      <input
        className="w-20 rounded-[7px] border border-line bg-paper px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-amber"
        disabled={disabled}
        id="hitl-confidence"
        max={1}
        min={0}
        step={0.1}
        type="number"
        value={confidence}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function FormFieldControl({
  field,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  field: HitlFormFieldView;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (v: string) => void;
}): ReactElement {
  const options = field.options ?? [];

  return (
    <div className="flex flex-col gap-1.5">
      <label
        className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
        htmlFor={`hitl-form-field-${field.name}`}
      >
        {field.label ?? field.name}
        {field.required ? " *" : ""}
      </label>
      {options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {options.map((opt) => (
            <button
              key={opt}
              className={clsx(
                "rounded-lg border px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em]",
                value === opt
                  ? "border-amber bg-amber text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2"
                  : "border-line bg-paper text-mute hover:border-mute hover:text-ink-2",
                disabled && "opacity-60",
              )}
              disabled={disabled}
              type="button"
              onClick={() => onChange(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : null}
      <input
        className="rounded-[7px] border border-line bg-paper px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-amber"
        disabled={disabled}
        id={`hitl-form-field-${field.name}`}
        placeholder={placeholder}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function HitlDecisionControls({
  kind,
  reviewSchema,
  options,
  schema,
  criticality,
  showConfidence,
  confidence,
  comments,
  jsonValue,
  formValues,
  disabled,
  compact,
  error,
  labels,
  onConfidenceChange,
  onCommentsChange,
  onJsonChange,
  onFormFieldChange,
  onDecision,
  onSendBack,
  onOption,
  onSubmitJson,
  onSubmitForm,
}: HitlDecisionControlsProps): ReactElement {
  const formFields = kind === "form" ? formFieldsFromSchema(schema) : null;
  const decisionLabel = (d: string): string => {
    if (d === "approve") return labels.decisionApprove;
    if (d === "rework") return labels.decisionRework;

    return d;
  };

  const isReworkDecision = (d: string): boolean => {
    if (!reviewSchema) return false;
    const transitions = reviewSchema.transitions ?? {};
    const reworkTargets = reviewSchema.reworkTargets ?? [];

    return (
      Object.hasOwn(transitions, d) && reworkTargets.includes(transitions[d])
    );
  };

  return (
    <div className={clsx("flex flex-col", compact ? "gap-2" : "gap-3")}>
      {criticality ? (
        <CriticalityBadge criticality={criticality} labels={labels} />
      ) : null}

      {reviewSchema ? (
        <>
          <label
            className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
            htmlFor="hitl-review-comments"
          >
            {labels.reviewComments}
          </label>
          <textarea
            className={clsx(
              "rounded-[10px] border border-line bg-paper p-3 text-[12.5px] text-ink outline-none focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)]",
              compact ? "min-h-[60px]" : "min-h-[90px]",
            )}
            disabled={disabled}
            id="hitl-review-comments"
            placeholder={labels.reviewCommentsPlaceholder}
            value={comments}
            onChange={(e) => onCommentsChange(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {(reviewSchema.allowedDecisions ?? []).map((d) => (
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
                onClick={() => onDecision(d)}
              >
                {decisionLabel(d)}
              </button>
            ))}
            <button
              className={clsx(
                "rounded-lg border border-line bg-paper px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2",
                disabled && "opacity-60",
              )}
              disabled={disabled}
              type="button"
              onClick={onSendBack}
            >
              {labels.sendBackWithComments}
            </button>
          </div>
          {showConfidence ? (
            <ConfidenceInput
              confidence={confidence}
              disabled={disabled}
              label={labels.confidenceLabel}
              onChange={onConfidenceChange}
            />
          ) : null}
        </>
      ) : kind === "permission" ? (
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
              onClick={() => onOption(opt.optionId)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : formFields ? (
        <div className={clsx("flex flex-col", compact ? "gap-2" : "gap-3")}>
          <p className="text-[12px] text-mute">{labels.formInstructions}</p>
          {formFields.map((field) => (
            <FormFieldControl
              key={field.name}
              disabled={disabled}
              field={field}
              placeholder={labels.formCustomPlaceholder}
              value={formValues[field.name] ?? ""}
              onChange={(v) => onFormFieldChange(field.name, v)}
            />
          ))}
          <button
            className="mt-1 inline-flex w-max items-center rounded-full bg-amber px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-8px_var(--amber)] transition-all hover:bg-amber-2 disabled:opacity-60"
            disabled={disabled}
            type="button"
            onClick={onSubmitForm}
          >
            {labels.submit}
          </button>
        </div>
      ) : (
        <>
          <label
            className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
            htmlFor="hitl-json-response"
          >
            {labels.responseLabel}
          </label>
          <p className="text-[12px] text-mute">{labels.responseHint}</p>
          <textarea
            aria-label={labels.responseLabel}
            className={clsx(
              "rounded-[10px] border border-line bg-paper p-3 font-mono text-[12.5px] text-ink outline-none focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)]",
              compact ? "min-h-[60px]" : "min-h-[120px]",
            )}
            disabled={disabled}
            id="hitl-json-response"
            value={jsonValue}
            onChange={(e) => onJsonChange(e.target.value)}
          />
          {schema != null ? (
            <details className="text-[11.5px] text-mute">
              <summary className="cursor-pointer font-mono uppercase tracking-[0.06em]">
                {labels.schemaLabel}
              </summary>
              <pre className="mt-2 overflow-auto rounded-lg border border-line-soft bg-ivory p-3 text-[11px] text-ink-2">
                {JSON.stringify(schema, null, 2)}
              </pre>
            </details>
          ) : null}
          {showConfidence ? (
            <ConfidenceInput
              confidence={confidence}
              disabled={disabled}
              label={labels.confidenceLabel}
              onChange={onConfidenceChange}
            />
          ) : null}
          <button
            className="mt-1 inline-flex w-max items-center rounded-full bg-amber px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-8px_var(--amber)] transition-all hover:bg-amber-2 disabled:opacity-60"
            disabled={disabled}
            type="button"
            onClick={onSubmitJson}
          >
            {labels.submit}
          </button>
        </>
      )}

      {error ? (
        <p
          aria-live="assertive"
          className="font-mono text-[12px] text-[#d9534f]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
