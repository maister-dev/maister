"use client";

import type { FormSchemaBuilderLabels } from "@/components/flows/artifact-editors/form-schema-builder";
import type { ReactElement } from "react";

import { useEffect, useMemo, useState } from "react";

import { FormSchemaBuilder } from "@/components/flows/artifact-editors/form-schema-builder";
import { ReferenceCombobox } from "@/components/flows/node-form/reference-combobox";
import {
  buildSchemaWriteFromRef,
  buildSchemaWriteFromTitle,
} from "@/lib/flows/editor/schema-ref-actions";
import {
  buildSchemaOptions,
  schemaRefToFilePath,
} from "@/lib/flows/editor/reference-sources";

export type SchemaRefFieldLabels = {
  placeholder: string;
  emptyHint: string;
  create: string;
  edit: string;
  paste: string;
  title: string;
  json: string;
  formSchema?: FormSchemaBuilderLabels;
};

export type SchemaRefFile = {
  path: string;
  content: string;
};

export type SchemaRefFieldProps = {
  value: string;
  label: string;
  testid: string;
  labels: SchemaRefFieldLabels;
  readOnly: boolean;
  schemaFiles?: readonly SchemaRefFile[];
  error?: string;
  onChange: (value: string) => void;
  onWriteSchemaFile?: (path: string, content: string) => void;
};

const LABEL_CLS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute";
const BTN_CLS =
  "rounded-md border border-line px-2 py-1 font-mono text-[11px] text-mute hover:bg-ivory hover:text-ink";
const INPUT_CLS =
  "rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-amber";

export function SchemaRefField({
  value,
  label,
  testid,
  labels,
  readOnly,
  schemaFiles,
  error,
  onChange,
  onWriteSchemaFile,
}: SchemaRefFieldProps): ReactElement {
  const writable = !readOnly && schemaFiles !== undefined && onWriteSchemaFile;
  const selectedContent =
    schemaFiles?.find((file) => file.path === schemaRefToFilePath(value))
      ?.content ?? "";
  const [titleDraft, setTitleDraft] = useState("");
  const [jsonDraft, setJsonDraft] = useState(selectedContent);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const options = useMemo(
    () => buildSchemaOptions(schemaFiles ?? []),
    [schemaFiles],
  );

  useEffect(() => {
    setJsonDraft(selectedContent);
  }, [selectedContent]);

  function writeCreate(): void {
    if (!schemaFiles || !onWriteSchemaFile) return;

    const result = buildSchemaWriteFromTitle(
      titleDraft,
      schemaFiles.map((file) => file.path),
      jsonDraft,
    );

    if (!result.ok) {
      setInlineError(result.error);

      return;
    }

    onWriteSchemaFile(result.path, result.content);
    onChange(result.ref);
    setInlineError(null);
  }

  function writeEdit(): void {
    if (!onWriteSchemaFile) return;

    const result = buildSchemaWriteFromRef(value, jsonDraft);

    if (!result.ok) {
      setInlineError(result.error);

      return;
    }

    onWriteSchemaFile(result.path, result.content);
    onChange(result.ref);
    setInlineError(null);
  }

  return (
    <div className="grid gap-2" data-testid={`${testid}-field`}>
      <ReferenceCombobox
        emptyHint={labels.emptyHint}
        groups={[{ label: "Schemas", kind: "schema", options }]}
        label={label}
        placeholder={labels.placeholder}
        readOnly={readOnly}
        testid={testid}
        value={value}
        onInputValue={onChange}
        onSelect={(nextValue) => onChange(nextValue)}
        onUnknownKindChange={() => undefined}
      />

      {writable ? (
        <div className="grid gap-2">
          <label className="grid gap-1">
            <span className={LABEL_CLS}>{labels.title}</span>
            <input
              className={INPUT_CLS}
              data-testid={`${testid}-title`}
              type="text"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className={LABEL_CLS}>{labels.json}</span>
            <textarea
              className={`${INPUT_CLS} min-h-[80px] resize-y`}
              data-testid={`${testid}-json`}
              value={jsonDraft}
              onChange={(event) => setJsonDraft(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-1">
            <button
              className={BTN_CLS}
              data-testid={`${testid}-create`}
              type="button"
              onClick={writeCreate}
            >
              {labels.create}
            </button>
            <button
              className={BTN_CLS}
              data-testid={`${testid}-edit`}
              type="button"
              onClick={writeEdit}
            >
              {labels.edit}
            </button>
            <button
              className={BTN_CLS}
              data-testid={`${testid}-paste`}
              type="button"
              onClick={writeCreate}
            >
              {labels.paste}
            </button>
          </div>
          {labels.formSchema ? (
            <FormSchemaBuilder
              content={jsonDraft}
              labels={labels.formSchema}
              readOnly={readOnly}
              onChange={setJsonDraft}
            />
          ) : null}
        </div>
      ) : null}

      {error || inlineError ? (
        <p className="font-mono text-[11px] text-danger" role="alert">
          {error ?? inlineError}
        </p>
      ) : null}
    </div>
  );
}
