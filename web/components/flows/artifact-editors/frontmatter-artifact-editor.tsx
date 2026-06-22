"use client";

import type { ReactElement } from "react";

import { useState } from "react";

import { CodeEditor } from "@/components/flows/code-editor";
import { agentDefinitionFrontmatterSchema } from "@/lib/agents/definition";
import {
  serializeFrontmatter,
  splitFrontmatter,
} from "@/lib/flows/artifact-frontmatter";

// The three artifact kinds this editor serves. Mirrors `CodeEditorKind`'s
// frontmatter-bearing members; the Coordinator dispatches here by kind.
export type FrontmatterArtifactKind = "skill" | "agent_definition" | "rule";

export interface FrontmatterArtifactEditorLabels {
  frontmatterHeading: string;
  bodyHeading: string;
  name: string;
  description: string;
  // Platform-agent contract fields (ADR-089 rework): agents/*.md inside a
  // package IS the platform-agent definition.
  agentWorkspace: string;
  agentWorkspaceRef: string;
  agentMode: string;
  agentTriggers: string;
  agentRiskTier: string;
  agentRunner: string;
  agentRecommendedHeading: string;
  agentRecommendedRunner: string;
  agentRecommendedCronExpr: string;
  agentRecommendedCronTz: string;
  agentRecommendedEvents: string;
  agentCapabilityProfile: string;
  agentCapabilityProfileInvalid: string;
  allowedPaths: string;
  forbiddenPaths: string;
  allowedCommands: string;
  requireStructuredResponse: string;
  listHint: string;
  guardrailNotice: string;
  malformedNotice: string;
  rawHeading: string;
  agentSchemaWarning: string;
}

type FieldValue =
  | string
  | string[]
  | boolean
  | number
  | Record<string, unknown>
  | undefined;

/**
 * Apply a single frontmatter field edit and re-serialize, mutating ONLY the
 * named key. Unknown / passthrough keys keep their position and value (we
 * shallow-clone the parsed mapping, which preserves insertion order), and the
 * markdown body is untouched. A `value` of `undefined` deletes the key.
 *
 * If `content` has no parseable frontmatter (`splitFrontmatter` → `ok:false`),
 * the content is returned unchanged — the malformed path is handled by raw
 * editing in the component, not by silently rewriting a broken document.
 *
 * Editing a field back to its current value is a fixed point (byte-stable),
 * because `serializeFrontmatter` of an untouched mapping round-trips.
 */
export function applyFrontmatterFieldEdit(
  content: string,
  key: string,
  value: FieldValue,
): string {
  const split = splitFrontmatter(content);

  if (!split.ok) {
    return content;
  }

  const next: Record<string, unknown> = { ...(split.frontmatter ?? {}) };

  if (value === undefined) {
    delete next[key];
  } else {
    next[key] = value;
  }

  return serializeFrontmatter({ frontmatter: next, body: split.body });
}

function applyBodyEdit(content: string, body: string): string {
  const split = splitFrontmatter(content);

  if (!split.ok) {
    return content;
  }

  return serializeFrontmatter({ frontmatter: split.frontmatter, body });
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;

  return String(value);
}

// Frontmatter list fields (allowed_paths, …) are yaml sequences. We present
// them one-per-line in a <textarea>; blank lines are dropped on the way back.
function linesToList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function listToLines(value: unknown): string {
  if (!Array.isArray(value)) return "";

  return value.map((item) => asText(item)).join("\n");
}

const labelClass =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";
const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";
const textareaClass =
  "min-h-[80px] rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber";
const fieldClass = "flex flex-col gap-1.5";

interface FieldProps {
  label: string;
  value: string;
  readOnly: boolean;
  type?: "text" | "number";
  onValue: (next: string) => void;
}

function TextField({
  label,
  value,
  readOnly,
  type = "text",
  onValue,
}: FieldProps): ReactElement {
  return (
    <label className={fieldClass}>
      <span className={labelClass}>{label}</span>
      <input
        className={inputClass}
        readOnly={readOnly}
        spellCheck={false}
        type={type}
        value={value}
        onChange={(event) => onValue(event.target.value)}
      />
    </label>
  );
}

interface ListFieldProps {
  label: string;
  hint: string;
  value: string;
  readOnly: boolean;
  onValue: (next: string) => void;
}

function ListField({
  label,
  hint,
  value,
  readOnly,
  onValue,
}: ListFieldProps): ReactElement {
  return (
    <label className={fieldClass}>
      <span className={labelClass}>{label}</span>
      <textarea
        className={textareaClass}
        placeholder={hint}
        readOnly={readOnly}
        spellCheck={false}
        value={value}
        onChange={(event) => onValue(event.target.value)}
      />
    </label>
  );
}

interface CapabilityProfileFieldProps {
  label: string;
  invalidLabel: string;
  readOnly: boolean;
  value: Record<string, unknown> | undefined;
  onCommit: (value: Record<string, unknown>) => void;
  onClear: () => void;
}

// `capability_profile` is an arbitrary JSON object. Edited as raw JSON with a
// local draft so intermediate invalid text survives while typing: a valid object
// commits to frontmatter, an invalid one shows a notice and is NOT saved (the
// field stays editable — never blocks). The ContentEditor `key={file.path}`
// remounts this on file switch, so the draft re-seeds for each artifact.
function CapabilityProfileField({
  label,
  invalidLabel,
  readOnly,
  value,
  onCommit,
  onClear,
}: CapabilityProfileFieldProps): ReactElement {
  const [draft, setDraft] = useState(
    value ? JSON.stringify(value, null, 2) : "",
  );
  const [error, setError] = useState<string | null>(null);

  const handle = (text: string): void => {
    setDraft(text);

    if (text.trim() === "") {
      setError(null);
      onClear();

      return;
    }

    try {
      const parsed: unknown = JSON.parse(text);

      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        setError(invalidLabel);

        return;
      }
      setError(null);
      onCommit(parsed as Record<string, unknown>);
    } catch {
      setError(invalidLabel);
    }
  };

  return (
    <label className={fieldClass}>
      <span className={labelClass}>{label}</span>
      <textarea
        className={textareaClass}
        readOnly={readOnly}
        spellCheck={false}
        value={draft}
        onChange={(event) => handle(event.target.value)}
      />
      {error ? (
        <span className="font-mono text-[10px] text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export interface FrontmatterArtifactEditorProps {
  content: string;
  onChange: (next: string) => void;
  kind: FrontmatterArtifactKind;
  readOnly?: boolean;
  labels: FrontmatterArtifactEditorLabels;
}

/**
 * Edits a skill / agent / rule artifact's CONTENT (a `---`-fenced frontmatter
 * document) as a structured FORM over the known fields plus a markdown BODY
 * editor. Every edit re-serializes via `serializeFrontmatter`, preserving
 * unknown keys and leaving untouched fields byte-stable. Malformed frontmatter
 * degrades to a notice + raw editor so the user can repair it without a crash.
 *
 * Uniform contract (`content` + `onChange` + `kind` + `labels`) so the
 * package-files editor can dispatch to this component by inferred kind.
 */
export function FrontmatterArtifactEditor({
  content,
  onChange,
  kind,
  readOnly = false,
  labels,
}: FrontmatterArtifactEditorProps): ReactElement {
  const split = splitFrontmatter(content);

  if (!split.ok) {
    return (
      <div className="flex flex-col gap-3">
        <div
          className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
          role="alert"
        >
          {labels.malformedNotice}
        </div>
        <div className={fieldClass}>
          <span className={labelClass}>{labels.rawHeading}</span>
          <CodeEditor
            ariaLabel={labels.rawHeading}
            kind={kind}
            readOnly={readOnly}
            value={content}
            onChange={onChange}
          />
        </div>
      </div>
    );
  }

  const fm = split.frontmatter ?? {};

  // Lenient platform-agent validation: surface a ⚠ badge for incomplete/invalid
  // agent frontmatter, but keep every field editable (never block the save).
  const agentSchema =
    kind === "agent_definition"
      ? agentDefinitionFrontmatterSchema.safeParse(fm)
      : null;

  const editField = (key: string, value: FieldValue): void => {
    onChange(applyFrontmatterFieldEdit(content, key, value));
  };

  const editTextKey = (key: string) => (next: string) =>
    editField(key, next.length === 0 ? undefined : next);

  const editListKey = (key: string) => (next: string) => {
    const list = linesToList(next);

    editField(key, list.length === 0 ? undefined : list);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-ivory/40 px-3.5 py-3">
        <span className={labelClass}>{labels.frontmatterHeading}</span>

        {agentSchema && !agentSchema.success ? (
          <div
            className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[10.5px] leading-snug text-amber"
            data-testid="agent-schema-warning"
            role="alert"
          >
            ⚠ {labels.agentSchemaWarning}
            <ul className="mt-1 list-disc pl-4">
              {agentSchema.error.issues.slice(0, 6).map((issue) => (
                <li key={`${issue.path.join(".")}:${issue.message}`}>
                  {(issue.path.join(".") || "frontmatter") +
                    ": " +
                    issue.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {kind === "rule" ? (
          <RuleFields
            editField={editField}
            editListKey={editListKey}
            fm={fm}
            labels={labels}
            readOnly={readOnly}
          />
        ) : (
          <SkillAgentFields
            editField={editField}
            editListKey={editListKey}
            editTextKey={editTextKey}
            fm={fm}
            kind={kind}
            labels={labels}
            readOnly={readOnly}
          />
        )}
      </div>

      <div className={fieldClass}>
        <span className={labelClass}>{labels.bodyHeading}</span>
        <CodeEditor
          ariaLabel={labels.bodyHeading}
          kind="readme"
          readOnly={readOnly}
          value={split.body}
          onChange={(nextBody) => onChange(applyBodyEdit(content, nextBody))}
        />
      </div>
    </div>
  );
}

interface SkillAgentFieldsProps {
  fm: Record<string, unknown>;
  kind: "skill" | "agent_definition";
  readOnly: boolean;
  labels: FrontmatterArtifactEditorLabels;
  editField: (key: string, value: FieldValue) => void;
  editTextKey: (key: string) => (next: string) => void;
  editListKey: (key: string) => (next: string) => void;
}

function SkillAgentFields({
  fm,
  kind,
  readOnly,
  labels,
  editField,
  editTextKey,
  editListKey,
}: SkillAgentFieldsProps): ReactElement {
  // `recommended` is a nested mapping — edits rewrite the whole object and
  // drop it entirely when every sub-field clears (CLEAR-able round-trip).
  const recommended = (fm.recommended ?? {}) as {
    runner?: string;
    cron?: { expr?: string; timezone?: string };
    events?: string[];
  };
  const editRecommended = (
    patch: Partial<{
      runner: string;
      cronExpr: string;
      cronTz: string;
      events: string[];
    }>,
  ): void => {
    const runner = patch.runner ?? recommended.runner ?? "";
    const cronExpr = patch.cronExpr ?? recommended.cron?.expr ?? "";
    const cronTz = patch.cronTz ?? recommended.cron?.timezone ?? "";
    const events = patch.events ?? recommended.events ?? [];

    const next: Record<string, unknown> = {
      ...(runner.trim() !== "" ? { runner: runner.trim() } : {}),
      ...(cronExpr.trim() !== "" || cronTz.trim() !== ""
        ? { cron: { expr: cronExpr.trim(), timezone: cronTz.trim() } }
        : {}),
      ...(events.length > 0 ? { events } : {}),
    };

    editField("recommended", Object.keys(next).length === 0 ? undefined : next);
  };

  return (
    <>
      <TextField
        label={labels.name}
        readOnly={readOnly}
        value={asText(fm.name)}
        onValue={editTextKey("name")}
      />
      <TextField
        label={labels.description}
        readOnly={readOnly}
        value={asText(fm.description)}
        onValue={editTextKey("description")}
      />
      {kind === "agent_definition" ? (
        <>
          <TextField
            label={labels.agentWorkspace}
            readOnly={readOnly}
            value={asText(fm.workspace)}
            onValue={editTextKey("workspace")}
          />
          <TextField
            label={labels.agentWorkspaceRef}
            readOnly={readOnly}
            value={asText(fm.workspace_ref)}
            onValue={editTextKey("workspace_ref")}
          />
          <TextField
            label={labels.agentMode}
            readOnly={readOnly}
            value={asText(fm.mode)}
            onValue={editTextKey("mode")}
          />
          <ListField
            hint={labels.listHint}
            label={labels.agentTriggers}
            readOnly={readOnly}
            value={listToLines(fm.triggers)}
            onValue={editListKey("triggers")}
          />
          <TextField
            label={labels.agentRiskTier}
            readOnly={readOnly}
            value={asText(fm.risk_tier)}
            onValue={editTextKey("risk_tier")}
          />
          <TextField
            label={labels.agentRunner}
            readOnly={readOnly}
            value={asText(fm.runner)}
            onValue={editTextKey("runner")}
          />
          <p className="m-0 font-mono text-[10.5px] leading-snug text-mute">
            {labels.agentRecommendedHeading}
          </p>
          <TextField
            label={labels.agentRecommendedRunner}
            readOnly={readOnly}
            value={asText(recommended.runner)}
            onValue={(next) => editRecommended({ runner: next })}
          />
          <TextField
            label={labels.agentRecommendedCronExpr}
            readOnly={readOnly}
            value={asText(recommended.cron?.expr)}
            onValue={(next) => editRecommended({ cronExpr: next })}
          />
          <TextField
            label={labels.agentRecommendedCronTz}
            readOnly={readOnly}
            value={asText(recommended.cron?.timezone)}
            onValue={(next) => editRecommended({ cronTz: next })}
          />
          <ListField
            hint={labels.listHint}
            label={labels.agentRecommendedEvents}
            readOnly={readOnly}
            value={listToLines(recommended.events)}
            onValue={(next) => editRecommended({ events: linesToList(next) })}
          />
          <CapabilityProfileField
            invalidLabel={labels.agentCapabilityProfileInvalid}
            label={labels.agentCapabilityProfile}
            readOnly={readOnly}
            value={fm.capability_profile as Record<string, unknown> | undefined}
            onClear={() => editField("capability_profile", undefined)}
            onCommit={(next) => editField("capability_profile", next)}
          />
        </>
      ) : null}
    </>
  );
}

interface RuleFieldsProps {
  fm: Record<string, unknown>;
  readOnly: boolean;
  labels: FrontmatterArtifactEditorLabels;
  editField: (key: string, value: FieldValue) => void;
  editListKey: (key: string) => (next: string) => void;
}

function RuleFields({
  fm,
  readOnly,
  labels,
  editField,
  editListKey,
}: RuleFieldsProps): ReactElement {
  return (
    <>
      <p className="m-0 font-mono text-[10.5px] leading-snug text-mute">
        {labels.guardrailNotice}
      </p>
      <ListField
        hint={labels.listHint}
        label={labels.allowedPaths}
        readOnly={readOnly}
        value={listToLines(fm.allowed_paths)}
        onValue={editListKey("allowed_paths")}
      />
      <ListField
        hint={labels.listHint}
        label={labels.forbiddenPaths}
        readOnly={readOnly}
        value={listToLines(fm.forbidden_paths)}
        onValue={editListKey("forbidden_paths")}
      />
      <ListField
        hint={labels.listHint}
        label={labels.allowedCommands}
        readOnly={readOnly}
        value={listToLines(fm.allowed_commands)}
        onValue={editListKey("allowed_commands")}
      />
      <label className="flex items-center gap-2 text-[12px] text-mute">
        <input
          checked={fm.require_structured_response === true}
          disabled={readOnly}
          type="checkbox"
          onChange={(event) =>
            editField(
              "require_structured_response",
              event.target.checked ? true : undefined,
            )
          }
        />
        {labels.requireStructuredResponse}
      </label>
    </>
  );
}
