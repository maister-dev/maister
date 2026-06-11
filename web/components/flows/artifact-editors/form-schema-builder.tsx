"use client";

import type { HitlDecisionControlsLabels } from "@/components/board/hitl-decision-controls";
import type { FormSchema } from "@/lib/config.schema";
import type {
  FieldPath,
  FormSchemaField,
  FormSchemaFieldType,
} from "@/lib/flows/editor/form-schema-edit";
import type { ReactElement } from "react";

import { useState } from "react";

import { HitlDecisionControls } from "@/components/board/hitl-decision-controls";
import { CodeEditor } from "@/components/flows/code-editor";
import {
  FORM_FIELD_TYPES,
  applyFieldEdit,
  parseFormSchemaJson,
  serializeFormSchema,
} from "@/lib/flows/editor/form-schema-edit";

export interface FormSchemaBuilderLabels {
  builderTab: string;
  jsonTab: string;
  previewHeading: string;
  fieldName: string;
  fieldLabel: string;
  fieldType: string;
  fieldRequired: string;
  fieldOptions: string;
  addField: string;
  addNestedField: string;
  removeField: string;
  moveUp: string;
  moveDown: string;
  invalidJson: string;
  noFields: string;
  type: Record<FormSchemaFieldType, string>;
  preview: HitlDecisionControlsLabels;
}

export interface FormSchemaBuilderProps {
  content: string;
  readOnly?: boolean;
  labels: FormSchemaBuilderLabels;
  onChange: (next: string) => void;
}

const NOOP = (): void => {};
const NOOP_STR = (_v: string): void => {};
const NOOP_FIELD = (_n: string, _v: string): void => {};

const INPUT_CLS =
  "rounded-[7px] border border-line bg-paper px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-amber disabled:opacity-60";
const LABEL_CLS =
  "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute";
const BTN_CLS =
  "rounded-lg border border-line bg-paper px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2 disabled:opacity-60";

function FieldRow({
  field,
  path,
  isFirst,
  isLast,
  disabled,
  labels,
  onEdit,
}: {
  field: FormSchemaField;
  path: FieldPath;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  labels: FormSchemaBuilderLabels;
  onEdit: (edit: Parameters<typeof applyFieldEdit>[1]) => void;
}): ReactElement {
  const index = path[path.length - 1];
  const options = field.options ?? [];

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-line-soft bg-ivory p-3"
      data-testid={`form-schema-field-${index}`}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>{labels.fieldName}</span>
          <input
            className={INPUT_CLS}
            data-testid={`form-schema-name-${index}`}
            disabled={disabled}
            type="text"
            value={field.name}
            onChange={(e) =>
              onEdit({ kind: "update", path, patch: { name: e.target.value } })
            }
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>{labels.fieldLabel}</span>
          <input
            className={INPUT_CLS}
            disabled={disabled}
            type="text"
            value={field.label ?? ""}
            onChange={(e) =>
              onEdit({ kind: "update", path, patch: { label: e.target.value } })
            }
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>{labels.fieldType}</span>
          <select
            className={INPUT_CLS}
            disabled={disabled}
            value={field.type}
            onChange={(e) =>
              onEdit({
                kind: "update",
                path,
                patch: { type: e.target.value as FormSchemaFieldType },
              })
            }
          >
            {FORM_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {labels.type[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 pb-1.5">
          <input
            checked={field.required ?? false}
            disabled={disabled}
            type="checkbox"
            onChange={(e) =>
              onEdit({
                kind: "update",
                path,
                patch: { required: e.target.checked },
              })
            }
          />
          <span className={LABEL_CLS}>{labels.fieldRequired}</span>
        </label>
      </div>

      {field.type === "enum" ? (
        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>{labels.fieldOptions}</span>
          <input
            className={INPUT_CLS}
            disabled={disabled}
            type="text"
            value={options.join(", ")}
            onChange={(e) =>
              onEdit({
                kind: "update",
                path,
                patch: {
                  options: e.target.value
                    .split(",")
                    .map((o) => o.trim())
                    .filter((o) => o.length > 0),
                },
              })
            }
          />
        </label>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          className={BTN_CLS}
          data-testid={`form-schema-move-up-${index}`}
          disabled={disabled || isFirst}
          type="button"
          onClick={() => onEdit({ kind: "move", path, direction: "up" })}
        >
          {labels.moveUp}
        </button>
        <button
          className={BTN_CLS}
          data-testid={`form-schema-move-down-${index}`}
          disabled={disabled || isLast}
          type="button"
          onClick={() => onEdit({ kind: "move", path, direction: "down" })}
        >
          {labels.moveDown}
        </button>
        {field.type === "object" ? (
          <button
            className={BTN_CLS}
            disabled={disabled}
            type="button"
            onClick={() => onEdit({ kind: "add", path })}
          >
            {labels.addNestedField}
          </button>
        ) : null}
        <button
          className={BTN_CLS}
          data-testid={`form-schema-remove-field-${index}`}
          disabled={disabled}
          type="button"
          onClick={() => onEdit({ kind: "remove", path })}
        >
          {labels.removeField}
        </button>
      </div>

      {field.type === "object" && (field.fields ?? []).length > 0 ? (
        <div className="ml-3 flex flex-col gap-2 border-l border-line pl-3">
          {(field.fields ?? []).map((child, childIdx, arr) => (
            <FieldRow
              key={childIdx}
              disabled={disabled}
              field={child}
              isFirst={childIdx === 0}
              isLast={childIdx === arr.length - 1}
              labels={labels}
              path={[...path, childIdx]}
              onEdit={onEdit}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PreviewPane({
  schema,
  labels,
}: {
  schema: FormSchema;
  labels: FormSchemaBuilderLabels;
}): ReactElement {
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-line bg-paper p-3"
      data-testid="form-schema-preview"
    >
      <span className={LABEL_CLS}>{labels.previewHeading}</span>
      <HitlDecisionControls
        compact
        disabled
        comments=""
        confidence=""
        criticality={null}
        error={null}
        formValues={{}}
        jsonValue=""
        kind="form"
        labels={labels.preview}
        options={[]}
        reviewSchema={null}
        schema={schema}
        showConfidence={false}
        onCommentsChange={NOOP_STR}
        onConfidenceChange={NOOP_STR}
        onDecision={NOOP_STR}
        onFormFieldChange={NOOP_FIELD}
        onJsonChange={NOOP_STR}
        onOption={NOOP_STR}
        onSendBack={NOOP}
        onSubmitForm={NOOP}
        onSubmitJson={NOOP}
      />
    </div>
  );
}

/**
 * Self-contained editor for a `schemas/*.json` (or `output.result`) form-schema
 * doc. Two synchronized surfaces over the SAME `content` string:
 *  - a structured field builder (add/remove/reorder; name/label/type/required/
 *    options; recursive `object` children) — DISABLED with a banner when the
 *    JSON does not parse against `formSchemaSchema`;
 *  - a raw-JSON CodeMirror editor (always editable, so an invalid doc is
 *    fixable);
 *  - a live, non-interactive preview rendering `HitlDecisionControls`.
 *
 * Every edit (builder or JSON) re-emits the serialized doc through `onChange`.
 * The Coordinator wires `content`/`onChange` into the package files editor; this
 * component owns no persistence.
 */
export function FormSchemaBuilder({
  content,
  readOnly = false,
  labels,
  onChange,
}: FormSchemaBuilderProps): ReactElement {
  // `content` SEEDS the raw buffer once; the buffer is the source of truth
  // thereafter (mirrors CodeEditor's controlled-buffer contract). A parent that
  // swaps to a different document remounts via a per-file key.
  const [raw, setRaw] = useState(content);
  const parsed = parseFormSchemaJson(raw);

  const emit = (text: string): void => {
    setRaw(text);
    onChange(text);
  };

  const handleRawChange = (text: string): void => {
    emit(text);
  };

  const handleEdit = (edit: Parameters<typeof applyFieldEdit>[1]): void => {
    if (!parsed.ok) return;
    emit(serializeFormSchema(applyFieldEdit(parsed.schema, edit)));
  };

  const fields = parsed.ok ? parsed.schema.fields : [];

  return (
    <div className="flex flex-col gap-4" data-testid="form-schema-builder">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          {parsed.ok ? (
            <>
              {fields.length === 0 ? (
                <p className="text-[12px] text-mute">{labels.noFields}</p>
              ) : (
                fields.map((field, idx, arr) => (
                  <FieldRow
                    key={idx}
                    disabled={readOnly}
                    field={field}
                    isFirst={idx === 0}
                    isLast={idx === arr.length - 1}
                    labels={labels}
                    path={[idx]}
                    onEdit={handleEdit}
                  />
                ))
              )}
              <button
                className={BTN_CLS}
                data-testid="form-schema-add-field"
                disabled={readOnly}
                type="button"
                onClick={() => handleEdit({ kind: "add", path: [] })}
              >
                {labels.addField}
              </button>
            </>
          ) : (
            <p
              className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 text-[12px] font-semibold text-amber"
              data-testid="form-schema-invalid-banner"
              role="alert"
            >
              {labels.invalidJson}
            </p>
          )}
        </div>

        {parsed.ok ? (
          <PreviewPane labels={labels} schema={parsed.schema} />
        ) : null}
      </div>

      <CodeEditor
        ariaLabel={labels.jsonTab}
        kind="schema"
        readOnly={readOnly}
        value={raw}
        onChange={handleRawChange}
      />
    </div>
  );
}
