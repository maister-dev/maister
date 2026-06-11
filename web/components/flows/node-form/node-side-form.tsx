"use client";

import type {
  GateDraft,
  GateFormLabels,
} from "@/components/flows/node-form/gate-form";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { ReactElement } from "react";

import { GateForm } from "@/components/flows/node-form/gate-form";

type NodeDef = NonNullable<FlowYamlV1["nodes"]>[number];

export type NodeSideFormLabels = {
  empty: string;
  action: string;
  settings: string;
  gates: string;
  transitions: string;
  rework: string;
  output: string;
  prompt: string;
  command: string;
  model: string;
  thinkingEffort: string;
  permissionMode: string;
  workspaceAccess: string;
  skills: string;
  restrictions: string;
  mcps: string;
  enforcement: {
    title: string;
    mcps: string;
    tools: string;
    skills: string;
    restrictions: string;
    permissionMode: string;
    workspaceAccess: string;
  };
  timeoutMs: string;
  environmentPolicy: string;
  failureClass: string;
  decisions: string;
  criticality: string;
  roles: string;
  assignees: string;
  allowTakeover: string;
  outputSchema: string;
  outputRequired: string;
  presentation: string;
  presentationWidth: string;
  presentationHeight: string;
  presentationColor: string;
  reworkAllowedTargets: string;
  reworkWorkspacePolicies: string;
  reworkMaxLoops: string;
  reworkCommentsVar: string;
  transitionOutcome: string;
  transitionTarget: string;
  addTransition: string;
  removeTransition: string;
  noTransitions: string;
  noGates: string;
  gate: GateFormLabels;
};

const FIELD_CLS =
  "rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-amber";
const LABEL_CLS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute";
const SECTION_CLS =
  "font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-ink";

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec {
  return (value && typeof value === "object" ? value : {}) as Rec;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function joinList(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : "";
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function TextField({
  testid,
  label,
  value,
  type = "text",
  onChange,
}: {
  testid: string;
  label: string;
  value: string;
  type?: "text" | "number";
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="grid gap-1">
      <span className={LABEL_CLS}>{label}</span>
      <input
        className={FIELD_CLS}
        data-testid={testid}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function SelectField({
  testid,
  label,
  value,
  options,
  onChange,
}: {
  testid: string;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="grid gap-1">
      <span className={LABEL_CLS}>{label}</span>
      <select
        className={FIELD_CLS}
        data-testid={testid}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

export type NodePresentationStyle = {
  width?: number;
  height?: number;
  color?: string;
};

export function NodeSideForm({
  node,
  labels,
  presentation,
  onChange,
  onPresentationChange,
}: {
  node: NodeDef | null;
  labels: NodeSideFormLabels;
  presentation?: NodePresentationStyle;
  onChange: (next: NodeDef) => void;
  onPresentationChange?: (patch: NodePresentationStyle) => void;
}): ReactElement {
  if (node === null) {
    return (
      <div
        className="rounded-lg border border-line bg-paper p-4 font-mono text-[11px] text-mute"
        data-testid="node-side-form-empty"
      >
        {labels.empty}
      </div>
    );
  }

  const n = node as unknown as Rec;
  const type = str(n.type);
  const action = asRec(n.action);
  const settings = asRec(n.settings);
  const rework = asRec(n.rework);
  const result = asRec(asRec(n.output).result);
  const gates = (asRec(n.pre_finish).gates as GateDraft[] | undefined) ?? [];

  const emit = (next: Rec): void => onChange(next as unknown as NodeDef);
  const setSetting = (key: string, value: unknown): void =>
    emit({ ...n, settings: { ...settings, [key]: value } });
  const setEnforcement = (cls: string, value: string): void => {
    const next: Record<string, unknown> = {
      ...(settings.enforcement as Record<string, unknown> | undefined),
    };

    if (value === "") delete next[cls];
    else next[cls] = value;
    setSetting("enforcement", Object.keys(next).length ? next : undefined);
  };
  const setAction = (key: string, value: unknown): void =>
    emit({ ...n, action: { ...action, [key]: value } });
  const setRework = (patch: Rec): void =>
    emit({ ...n, rework: { ...rework, ...patch } });
  const setResult = (patch: Rec): void =>
    emit({
      ...n,
      output: { ...asRec(n.output), result: { ...result, ...patch } },
    });
  const setGate = (index: number, next: GateDraft): void => {
    const nextGates = gates.map((g, i) => (i === index ? next : g));

    emit({ ...n, pre_finish: { ...asRec(n.pre_finish), gates: nextGates } });
  };
  const removeGateAt = (index: number): void => {
    const nextGates = gates.filter((_, i) => i !== index);

    emit({ ...n, pre_finish: { ...asRec(n.pre_finish), gates: nextGates } });
  };

  const transitions = asRec(n.transitions) as Record<string, string>;
  const transitionRows = Object.entries(transitions);
  const setTransitionRow = (
    index: number,
    outcome: string,
    target: string,
  ): void => {
    const next: Record<string, string> = {};

    transitionRows.forEach(([o, t], i) => {
      if (i === index) {
        if (outcome) next[outcome] = target;
      } else {
        next[o] = t;
      }
    });
    emit({ ...n, transitions: next });
  };
  const removeTransitionRow = (index: number): void => {
    const next = Object.fromEntries(
      transitionRows.filter((_, i) => i !== index),
    );

    emit({ ...n, transitions: next });
  };
  const addTransitionRow = (): void => {
    let i = 1;

    while (transitions[`outcome_${i}`] !== undefined) i += 1;

    emit({ ...n, transitions: { ...transitions, [`outcome_${i}`]: "done" } });
  };

  const isPromptType = type === "ai_coding" || type === "judge";
  const isCommandType = type === "cli" || type === "check";

  return (
    <div
      className="grid gap-4 rounded-lg border border-line bg-paper p-4"
      data-testid="node-side-form"
    >
      <div className="font-mono text-[11px] font-bold text-ink">
        {str(n.id)} · {type}
      </div>

      <section className="grid gap-2">
        <h3 className={SECTION_CLS}>{labels.action}</h3>
        {isPromptType ? (
          <label className="grid gap-1">
            <span className={LABEL_CLS}>{labels.prompt}</span>
            <textarea
              className={`${FIELD_CLS} min-h-[90px] resize-y`}
              data-testid="node-action-prompt"
              spellCheck={false}
              value={str(action.prompt)}
              onChange={(e) => setAction("prompt", e.target.value)}
            />
          </label>
        ) : null}
        {isCommandType ? (
          <TextField
            label={labels.command}
            testid="node-action-command"
            value={str(action.command)}
            onChange={(v) => setAction("command", v)}
          />
        ) : null}
      </section>

      <section className="grid gap-2">
        <h3 className={SECTION_CLS}>{labels.settings}</h3>
        {type === "ai_coding" || type === "judge" ? (
          <>
            <TextField
              label={labels.model}
              testid="node-model"
              value={str(settings.model)}
              onChange={(v) => setSetting("model", v || undefined)}
            />
            <SelectField
              label={labels.thinkingEffort}
              options={["low", "medium", "high"]}
              testid="node-thinking-effort"
              value={str(settings.thinkingEffort)}
              onChange={(v) => setSetting("thinkingEffort", v || undefined)}
            />
            <SelectField
              label={labels.permissionMode}
              options={["ask", "allow", "deny"]}
              testid="node-permission-mode"
              value={str(settings.permissionMode)}
              onChange={(v) => setSetting("permissionMode", v || undefined)}
            />
            <TextField
              label={labels.skills}
              testid="node-skills"
              value={joinList(settings.skills)}
              onChange={(v) =>
                setSetting(
                  "skills",
                  parseList(v).length ? parseList(v) : undefined,
                )
              }
            />
            <TextField
              label={labels.restrictions}
              testid="node-restrictions"
              value={joinList(settings.restrictions)}
              onChange={(v) =>
                setSetting(
                  "restrictions",
                  parseList(v).length ? parseList(v) : undefined,
                )
              }
            />
            <TextField
              label={labels.mcps}
              testid="node-mcps"
              value={joinList(settings.mcps)}
              onChange={(v) =>
                setSetting(
                  "mcps",
                  parseList(v).length ? parseList(v) : undefined,
                )
              }
            />
            <div className="grid gap-2">
              <h4 className={SECTION_CLS}>{labels.enforcement.title}</h4>
              {(
                [
                  "mcps",
                  "tools",
                  "skills",
                  "restrictions",
                  "permissionMode",
                  "workspaceAccess",
                ] as const
              ).map((cls) => (
                <SelectField
                  key={cls}
                  label={labels.enforcement[cls]}
                  options={["strict", "instruct", "off"]}
                  testid={`node-enforcement-${cls}`}
                  value={str(
                    (
                      settings.enforcement as
                        | Record<string, unknown>
                        | undefined
                    )?.[cls],
                  )}
                  onChange={(v) => setEnforcement(cls, v)}
                />
              ))}
            </div>
          </>
        ) : null}
        {type === "ai_coding" ? (
          <SelectField
            label={labels.workspaceAccess}
            options={["read", "write", "none"]}
            testid="node-workspace-access"
            value={str(settings.workspaceAccess)}
            onChange={(v) => setSetting("workspaceAccess", v || undefined)}
          />
        ) : null}
        {isCommandType ? (
          <>
            <TextField
              label={labels.timeoutMs}
              testid="node-timeout-ms"
              type="number"
              value={str(settings.timeoutMs)}
              onChange={(v) =>
                setSetting("timeoutMs", v === "" ? undefined : Number(v))
              }
            />
            <SelectField
              label={labels.environmentPolicy}
              options={["inherit", "clean", "whitelist"]}
              testid="node-environment-policy"
              value={str(settings.environmentPolicy)}
              onChange={(v) => setSetting("environmentPolicy", v || undefined)}
            />
            <SelectField
              label={labels.failureClass}
              options={["blocking", "advisory", "retryable"]}
              testid="node-failure-class"
              value={str(settings.failureClass)}
              onChange={(v) => setSetting("failureClass", v || undefined)}
            />
          </>
        ) : null}
        {type === "human" ? (
          <>
            <TextField
              label={labels.decisions}
              testid="node-decisions"
              value={joinList(settings.decisions)}
              onChange={(v) =>
                setSetting(
                  "decisions",
                  parseList(v).length ? parseList(v) : undefined,
                )
              }
            />
            <SelectField
              label={labels.criticality}
              options={["low", "medium", "high", "critical"]}
              testid="node-criticality"
              value={str(settings.criticality)}
              onChange={(v) => setSetting("criticality", v || undefined)}
            />
            <TextField
              label={labels.roles}
              testid="node-roles"
              value={joinList(settings.roles)}
              onChange={(v) =>
                setSetting(
                  "roles",
                  parseList(v).length ? parseList(v) : undefined,
                )
              }
            />
            <TextField
              label={labels.assignees}
              testid="node-assignees"
              value={joinList(settings.assignees)}
              onChange={(v) =>
                setSetting(
                  "assignees",
                  parseList(v).length ? parseList(v) : undefined,
                )
              }
            />
            <label className="flex items-center gap-2">
              <input
                checked={Boolean(settings.allowTakeover)}
                data-testid="node-allow-takeover"
                type="checkbox"
                onChange={(e) => setSetting("allowTakeover", e.target.checked)}
              />
              <span className={LABEL_CLS}>{labels.allowTakeover}</span>
            </label>
          </>
        ) : null}
      </section>

      <section className="grid gap-2">
        <h3 className={SECTION_CLS}>{labels.gates}</h3>
        {gates.length === 0 ? (
          <p className="font-mono text-[10px] text-mute">{labels.noGates}</p>
        ) : (
          gates.map((gate, index) => (
            <GateForm
              key={gate.id}
              gate={gate}
              labels={labels.gate}
              onChange={(next) => setGate(index, next)}
              onRemove={() => removeGateAt(index)}
            />
          ))
        )}
      </section>

      <section className="grid gap-2">
        <div className="flex items-center justify-between">
          <h3 className={SECTION_CLS}>{labels.transitions}</h3>
          <button
            className="rounded-md border border-line px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:bg-paper"
            data-testid="add-transition"
            type="button"
            onClick={addTransitionRow}
          >
            {labels.addTransition}
          </button>
        </div>
        <div className="grid gap-2" data-testid="node-transitions">
          {transitionRows.length === 0 ? (
            <p className="font-mono text-[10px] text-mute">
              {labels.noTransitions}
            </p>
          ) : (
            transitionRows.map(([outcome, target], index) => (
              <div
                key={`${index}:${outcome}`}
                className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"
              >
                <label className="grid gap-1">
                  <span className={LABEL_CLS}>{labels.transitionOutcome}</span>
                  <input
                    className={FIELD_CLS}
                    data-testid={`transition-outcome-${index}`}
                    value={outcome}
                    onChange={(e) =>
                      setTransitionRow(index, e.target.value, target)
                    }
                  />
                </label>
                <label className="grid gap-1">
                  <span className={LABEL_CLS}>{labels.transitionTarget}</span>
                  <input
                    className={FIELD_CLS}
                    data-testid={`transition-target-${index}`}
                    value={target}
                    onChange={(e) =>
                      setTransitionRow(index, outcome, e.target.value)
                    }
                  />
                </label>
                <button
                  className="h-[34px] rounded-md border border-line px-2 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:bg-paper"
                  data-testid={`transition-remove-${index}`}
                  type="button"
                  onClick={() => removeTransitionRow(index)}
                >
                  {labels.removeTransition}
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="grid gap-2">
        <h3 className={SECTION_CLS}>{labels.rework}</h3>
        <TextField
          label={labels.reworkAllowedTargets}
          testid="node-rework-allowed-targets"
          value={joinList(rework.allowedTargets)}
          onChange={(v) =>
            setRework({
              allowedTargets: parseList(v),
              workspacePolicies: (rework.workspacePolicies as
                | string[]
                | undefined) ?? ["keep"],
              maxLoops: (rework.maxLoops as number | undefined) ?? 1,
            })
          }
        />
        <TextField
          label={labels.reworkMaxLoops}
          testid="node-rework-max-loops"
          type="number"
          value={str(rework.maxLoops)}
          onChange={(v) =>
            setRework({ maxLoops: v === "" ? undefined : Number(v) })
          }
        />
        <TextField
          label={labels.reworkWorkspacePolicies}
          testid="node-rework-workspace-policies"
          value={joinList(rework.workspacePolicies)}
          onChange={(v) =>
            setRework({
              workspacePolicies: parseList(v),
              allowedTargets:
                (rework.allowedTargets as string[] | undefined) ?? [],
              maxLoops: (rework.maxLoops as number | undefined) ?? 1,
            })
          }
        />
        <TextField
          label={labels.reworkCommentsVar}
          testid="node-rework-comments-var"
          value={str(rework.commentsVar)}
          onChange={(v) => setRework({ commentsVar: v || undefined })}
        />
      </section>

      <section className="grid gap-2">
        <h3 className={SECTION_CLS}>{labels.output}</h3>
        <TextField
          label={labels.outputSchema}
          testid="node-output-schema"
          value={str(result.schema)}
          onChange={(v) => setResult({ schema: v })}
        />
        <label className="flex items-center gap-2">
          <input
            checked={Boolean(result.required)}
            data-testid="node-output-required"
            type="checkbox"
            onChange={(e) => setResult({ required: e.target.checked })}
          />
          <span className={LABEL_CLS}>{labels.outputRequired}</span>
        </label>
      </section>

      {onPresentationChange ? (
        <section className="grid gap-2" data-testid="node-presentation">
          <h3 className={SECTION_CLS}>{labels.presentation}</h3>
          <div className="grid grid-cols-2 gap-2">
            <TextField
              label={labels.presentationWidth}
              testid="node-presentation-width"
              type="number"
              value={str(presentation?.width)}
              onChange={(v) =>
                onPresentationChange({
                  width: v === "" ? undefined : Number(v),
                })
              }
            />
            <TextField
              label={labels.presentationHeight}
              testid="node-presentation-height"
              type="number"
              value={str(presentation?.height)}
              onChange={(v) =>
                onPresentationChange({
                  height: v === "" ? undefined : Number(v),
                })
              }
            />
          </div>
          <label className="grid gap-1">
            <span className={LABEL_CLS}>{labels.presentationColor}</span>
            <input
              className={FIELD_CLS}
              data-testid="node-presentation-color"
              type="color"
              value={presentation?.color ?? "#000000"}
              onChange={(e) => onPresentationChange({ color: e.target.value })}
            />
          </label>
        </section>
      ) : null}
    </div>
  );
}
