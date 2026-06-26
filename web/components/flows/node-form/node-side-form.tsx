"use client";

import type {
  GateDraft,
  GateFormLabels,
} from "@/components/flows/node-form/gate-form";
import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { ProjectCapabilityCatalogEntry } from "@/lib/capabilities/project-catalog";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type {
  CapabilityOption,
  ReferenceSourceGroup,
  ReferenceSourceKind,
} from "@/lib/flows/editor/reference-sources";
import type { MultiSelectFieldLabels } from "@/components/flows/node-form/multi-select-field";
import type { StringListFieldLabels } from "@/components/flows/node-form/string-list-field";
import type {
  SchemaRefFieldLabels,
  SchemaRefFile,
} from "@/components/flows/node-form/schema-ref-field";
import type { ReactElement } from "react";

import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";

import { CapabilityComposer } from "@/components/capabilities/capability-composer";
import { GateForm } from "@/components/flows/node-form/gate-form";
import { MultiSelectField } from "@/components/flows/node-form/multi-select-field";
import { ReferenceCombobox } from "@/components/flows/node-form/reference-combobox";
import { SchemaRefField } from "@/components/flows/node-form/schema-ref-field";
import { StringListField } from "@/components/flows/node-form/string-list-field";
import { blankDecide } from "@/lib/flows/editor/node-form";
import {
  resolveFreeTextSourceKind,
  sourcePatchFromSelection,
} from "@/lib/flows/editor/reference-sources";

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
  formSchema: string;
  model: string;
  thinkingEffort: string;
  permissionMode: string;
  workspaceAccess: string;
  skills: string;
  restrictions: string;
  mcps: string;
  delegation: string;
  maxFanout: string;
  maxDepth: string;
  enforcement: {
    title: string;
    mcps: string;
    tools: string;
    skills: string;
    restrictions: string;
    permissionMode: string;
    workspaceAccess: string;
    hooks: string;
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
  schemaRef: SchemaRefFieldLabels;
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
  consensus: ConsensusFormLabels;
  decide: DecideFormLabels;
  hooks: HooksFormLabels;
  promptComposer: { placeholder: string; unsupported: string };
  multiSelect: MultiSelectFieldLabels;
  stringList: StringListFieldLabels;
  gate: GateFormLabels;
};

// ADR-108 (M40) — the `hooks` capability-class editor labels.
export type HooksFormLabels = {
  title: string;
  repetitionMax: string;
  noProgressMaxTurns: string;
  pathGuardAllowedPaths: string;
  disabled: string;
  hint: string;
};

export type DecideFormLabels = {
  title: string;
  source: string;
  sourceNone: string;
  sourceOutput: string;
  sourceVerdict: string;
  path: string;
  when: string;
  target: string;
  default: string;
  addCase: string;
  removeCase: string;
  noCases: string;
  onMismatch: string;
  onMismatchNone: string;
  onMismatchRetry: string;
  hint: string;
};

export type ConsensusFormLabels = {
  participants: string;
  participantId: string;
  participantSource: string;
  addParticipant: string;
  removeParticipant: string;
  materialAxes: string;
  materialAxesHint: string;
  synthesizerSource: string;
  runnersGroup: string;
  agentsGroup: string;
  sourcePlaceholder: string;
  sourceEmptyHint: string;
  asRunner: string;
  asAgent: string;
  roundsMode: string;
  roundsMax: string;
  onNoConsensus: string;
};

const FIELD_CLS =
  "rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-amber";
const LABEL_CLS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute";
const SECTION_CLS =
  "font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-ink";

type Rec = Record<string, unknown>;
type ActorSourceSets = {
  runners: ReadonlySet<string>;
  agents: ReadonlySet<string>;
};

function asRec(value: unknown): Rec {
  return (value && typeof value === "object" ? value : {}) as Rec;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function strList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const WORKSPACE_POLICY_OPTIONS: CapabilityOption[] = [
  { value: "keep", label: "keep" },
  { value: "rewind-to-node-checkpoint", label: "rewind-to-node-checkpoint" },
  { value: "fresh-attempt", label: "fresh-attempt" },
];

function compactRec(value: Rec): Rec {
  const next: Rec = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) next[key] = entry;
  }

  return next;
}

function buildKnownSourceSets(
  groups: readonly ReferenceSourceGroup[],
): ActorSourceSets {
  const runners = new Set<string>();
  const agents = new Set<string>();

  for (const group of groups) {
    const target = group.kind === "agent" ? agents : runners;

    if (!isActorSourceKind(group.kind)) continue;

    for (const option of group.options) {
      target.add(option.value);
    }
  }

  return { runners, agents };
}

function isActorSourceKind(kind: ReferenceSourceKind): kind is ActorSourceKind {
  return kind === "runner" || kind === "agent";
}

function sourceValueFor(source: Rec): string {
  return str(source.runner) || str(source.agent);
}

function sourceDeclaredKindFor(source: Rec): ActorSourceKind | undefined {
  if (str(source.runner)) return "runner";
  if (str(source.agent)) return "agent";

  return undefined;
}

function unknownSourceKindFor(
  value: string,
  declaredKind: ActorSourceKind | undefined,
  known: ActorSourceSets,
): ActorSourceKind | undefined {
  const normalized = value.trim();

  if (normalized.length === 0) return undefined;
  if (known.runners.has(normalized) || known.agents.has(normalized)) {
    return undefined;
  }

  return declaredKind ?? resolveFreeTextSourceKind(normalized, known);
}

function patchSourceSelection(kind: ActorSourceKind, value: string): Rec {
  if (value.trim().length === 0) {
    return { agent: undefined, runner: undefined };
  }

  return sourcePatchFromSelection(kind, value);
}

function TextField({
  testid,
  label,
  value,
  type = "text",
  readOnly = false,
  onChange,
}: {
  testid: string;
  label: string;
  value: string;
  type?: "text" | "number";
  readOnly?: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="grid gap-1">
      <span className={LABEL_CLS}>{label}</span>
      <input
        className={FIELD_CLS}
        data-testid={testid}
        readOnly={readOnly}
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
  readOnly = false,
  onChange,
}: {
  testid: string;
  label: string;
  value: string;
  options: readonly string[];
  readOnly?: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="grid gap-1">
      <span className={LABEL_CLS}>{label}</span>
      <select
        className={FIELD_CLS}
        data-testid={testid}
        disabled={readOnly}
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

type ActorSourceKind = Exclude<ReferenceSourceKind, "schema">;

export function NodeSideForm({
  node,
  labels,
  participantSources = [],
  schemaFiles,
  promptCatalog,
  promptAdapter,
  skillOptions,
  mcpOptions,
  presentation,
  readOnly = false,
  onChange,
  onWriteSchemaFile,
  onPresentationChange,
}: {
  node: NodeDef | null;
  labels: NodeSideFormLabels;
  participantSources?: ReferenceSourceGroup[];
  schemaFiles?: SchemaRefFile[];
  // The `/`-autosuggest capability catalog for the action.prompt composer
  // (editor mount). Absent → the read-only viewer degrades to a plain textarea.
  promptCatalog?: ProjectCapabilityCatalogEntry[];
  promptAdapter?: AdapterId;
  // Catalog options for the `skills` / `mcps` multiselects (free-add allowed);
  // absent → empty catalog (free-add still works in the editor).
  skillOptions?: CapabilityOption[];
  mcpOptions?: CapabilityOption[];
  presentation?: NodePresentationStyle;
  // Read-only (package viewer T1.4): every field renders as a disabled/read-only
  // value, add/remove controls are dropped, and edits are no-ops. DEFAULTS to
  // false so the live Flow Studio editor render + behavior is byte-identical.
  readOnly?: boolean;
  onChange: (next: NodeDef) => void;
  onWriteSchemaFile?: (path: string, content: string) => void;
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

  // In read-only mode every setter is a no-op (defense in depth — the inputs are
  // already disabled/read-only, but a synthetic change must not mutate either).
  const emit = (next: Rec): void => {
    if (readOnly) return;
    onChange(next as unknown as NodeDef);
  };
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
  // ADR-108 (M40) — the `hooks` block is sparse: its presence is derived from
  // content (any populated sub-field) rather than a separate enable toggle, so
  // clearing every field removes `settings.hooks` entirely. Cross-node concerns
  // (engine_min >= 1.8.0 when `hooks` is declared) stay in compile, never here.
  const hooks = asRec(settings.hooks);
  const setHooks = (patch: Rec): void => {
    const next: Rec = { ...hooks, ...patch };

    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key];
    }
    setSetting("hooks", Object.keys(next).length ? next : undefined);
  };
  // Orchestrator-only (M37/ADR-098): settings.delegation bounds the run-tree.
  // Sparse like hooks — clearing both fields removes the block entirely.
  const delegation = asRec(settings.delegation);
  const setDelegation = (patch: Rec): void => {
    const next: Rec = { ...delegation, ...patch };

    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key];
    }
    setSetting("delegation", Object.keys(next).length ? next : undefined);
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

  const participants = Array.isArray(n.participants)
    ? (n.participants as Rec[])
    : [];
  const setParticipant = (index: number, patch: Rec): void => {
    const next = participants.map((participant, i) =>
      i === index ? compactRec({ ...participant, ...patch }) : participant,
    );

    emit({ ...n, participants: next });
  };
  const addParticipant = (): void => {
    let index = participants.length + 1;
    const existing = new Set(participants.map((p) => str(p.id)));

    while (existing.has(`participant_${index}`)) index += 1;

    emit({
      ...n,
      participants: [
        ...participants,
        { id: `participant_${index}`, runner: "" },
      ],
    });
  };
  const removeParticipant = (index: number): void =>
    emit({
      ...n,
      participants: participants.filter((_, i) => i !== index),
    });
  const synthesizer = asRec(n.synthesizer);
  const setSynthesizer = (patch: Rec): void =>
    emit({ ...n, synthesizer: compactRec(patch) });
  const sourceSets = buildKnownSourceSets(participantSources);
  const setParticipantSource = (
    index: number,
    kind: ActorSourceKind,
    value: string,
  ): void => {
    setParticipant(index, patchSourceSelection(kind, value));
  };
  const setSynthesizerSource = (kind: ActorSourceKind, value: string): void => {
    setSynthesizer(patchSourceSelection(kind, value));
  };

  const isPromptType =
    type === "ai_coding" || type === "judge" || type === "orchestrator";
  const isConsensusType = type === "consensus";
  const isCommandType = type === "cli" || type === "check";

  // M38 (ADR-103) — Routing (`decide`) sub-panel. Offered when the node can
  // produce a routable signal: it declares `output.result` (→ from: output) OR
  // carries a verdict-producing gate (ai_judgment / skill_check → from: verdict).
  const hasOutputResult = typeof result.schema === "string";
  const hasVerdictGate = gates.some(
    (g) => g.kind === "ai_judgment" || g.kind === "skill_check",
  );
  const decide = asRec(n.decide);
  const hasDecide = n.decide !== undefined && n.decide !== null;
  // Always offer the panel for a routable node; also keep it visible when a
  // `decide` already exists so a misconfigured table stays editable/removable.
  const showRouting = hasOutputResult || hasVerdictGate || hasDecide;

  const decideFrom = str(decide.from);
  const decideSource: "" | "output" | "verdict" =
    decideFrom === "verdict"
      ? "verdict"
      : decideFrom.startsWith("output.")
        ? "output"
        : "";
  const decideCases = Array.isArray(decide.cases)
    ? (decide.cases as Rec[])
    : [];
  const whenCases = decideCases
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => typeof c.when === "string");
  const defaultCase = decideCases.find((c) => c.default === true);

  const setDecide = (next: Rec | undefined): void => {
    if (next === undefined) {
      const rest = { ...n };

      delete rest.decide;
      emit(rest);

      return;
    }

    emit({ ...n, decide: next });
  };
  const setDecideSource = (source: "" | "output" | "verdict"): void => {
    if (source === "") {
      setDecide(undefined);
    } else {
      setDecide(blankDecide(source) as Rec);
    }
  };
  const writeDecideCases = (cases: Rec[]): void =>
    setDecide({ from: "verdict", cases });
  const setVerdictCase = (
    caseIndex: number,
    when: string,
    target: string,
  ): void => {
    const next = decideCases.map((c, i) =>
      i === caseIndex ? { when, target } : c,
    );

    writeDecideCases(next);
  };
  const removeVerdictCase = (caseIndex: number): void =>
    writeDecideCases(decideCases.filter((_, i) => i !== caseIndex));
  const addVerdictCase = (): void => {
    const idx = defaultCase
      ? decideCases.indexOf(defaultCase)
      : decideCases.length;
    const next = [...decideCases];

    next.splice(idx, 0, { when: "confidence >= 0.8", target: "done" });
    writeDecideCases(next);
  };
  const setDefaultTarget = (target: string): void => {
    const withoutDefault = decideCases.filter((c) => c.default !== true);

    writeDecideCases([...withoutDefault, { default: true, target }]);
  };
  const onMismatch = str(result.on_mismatch);
  const setOnMismatch = (value: string): void => {
    if (value === "") {
      const restResult = { ...result };

      delete restResult.on_mismatch;
      emit({ ...n, output: { ...asRec(n.output), result: restResult } });

      return;
    }

    setResult({ on_mismatch: value });
  };

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
            {promptCatalog ? (
              <CapabilityComposer
                agent={promptAdapter ?? "claude"}
                ariaLabel={labels.prompt}
                catalog={promptCatalog}
                className={`${FIELD_CLS} min-h-[90px] overflow-y-auto`}
                disabled={readOnly}
                labels={{
                  placeholder: labels.promptComposer.placeholder,
                  unsupportedBadge: labels.promptComposer.unsupported,
                }}
                testId="node-action-prompt"
                value={str(action.prompt)}
                onChange={(v) => setAction("prompt", v)}
              />
            ) : (
              <textarea
                className={`${FIELD_CLS} min-h-[90px] resize-y`}
                data-testid="node-action-prompt"
                readOnly={readOnly}
                spellCheck={false}
                value={str(action.prompt)}
                onChange={(e) => setAction("prompt", e.target.value)}
              />
            )}
          </label>
        ) : null}
        {isConsensusType ? (
          <label className="grid gap-1">
            <span className={LABEL_CLS}>{labels.prompt}</span>
            <textarea
              className={`${FIELD_CLS} min-h-[90px] resize-y`}
              data-testid="node-consensus-prompt"
              readOnly={readOnly}
              spellCheck={false}
              value={str(n.prompt)}
              onChange={(e) => emit({ ...n, prompt: e.target.value })}
            />
          </label>
        ) : null}
        {isCommandType ? (
          <TextField
            label={labels.command}
            readOnly={readOnly}
            testid="node-action-command"
            value={str(action.command)}
            onChange={(v) => setAction("command", v)}
          />
        ) : null}
      </section>

      <section className="grid gap-2">
        <h3 className={SECTION_CLS}>{labels.settings}</h3>
        {type === "ai_coding" || type === "judge" || type === "orchestrator" ? (
          <>
            <TextField
              label={labels.model}
              readOnly={readOnly}
              testid="node-model"
              value={str(settings.model)}
              onChange={(v) => setSetting("model", v || undefined)}
            />
            <SelectField
              label={labels.thinkingEffort}
              options={["low", "medium", "high"]}
              readOnly={readOnly}
              testid="node-thinking-effort"
              value={str(settings.thinkingEffort)}
              onChange={(v) => setSetting("thinkingEffort", v || undefined)}
            />
            <SelectField
              label={labels.permissionMode}
              options={["ask", "allow", "deny"]}
              readOnly={readOnly}
              testid="node-permission-mode"
              value={str(settings.permissionMode)}
              onChange={(v) => setSetting("permissionMode", v || undefined)}
            />
            <MultiSelectField
              label={labels.skills}
              labels={labels.multiSelect}
              mode="catalog"
              options={skillOptions ?? []}
              readOnly={readOnly}
              testid="node-skills"
              values={strList(settings.skills)}
              onChange={(next) =>
                setSetting("skills", next.length ? next : undefined)
              }
            />
            <StringListField
              label={labels.restrictions}
              labels={labels.stringList}
              readOnly={readOnly}
              testid="node-restrictions"
              values={strList(settings.restrictions)}
              onChange={(next) =>
                setSetting("restrictions", next.length ? next : undefined)
              }
            />
            <MultiSelectField
              label={labels.mcps}
              labels={labels.multiSelect}
              mode="catalog"
              options={mcpOptions ?? []}
              readOnly={readOnly}
              testid="node-mcps"
              values={strList(settings.mcps)}
              onChange={(next) =>
                setSetting("mcps", next.length ? next : undefined)
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
                  "hooks",
                ] as const
              ).map((cls) => (
                <SelectField
                  key={cls}
                  label={labels.enforcement[cls]}
                  options={["strict", "instruct", "off"]}
                  readOnly={readOnly}
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
            <div className="grid gap-2" data-testid="node-hooks">
              <h4 className={SECTION_CLS}>{labels.hooks.title}</h4>
              <TextField
                label={labels.hooks.repetitionMax}
                readOnly={readOnly}
                testid="node-hooks-repetition-max"
                type="number"
                value={str(asRec(hooks.repetition).max)}
                onChange={(v) =>
                  setHooks({
                    repetition: v === "" ? undefined : { max: Number(v) },
                  })
                }
              />
              <TextField
                label={labels.hooks.noProgressMaxTurns}
                readOnly={readOnly}
                testid="node-hooks-no-progress-max-turns"
                type="number"
                value={str(asRec(hooks.noProgress).maxTurns)}
                onChange={(v) =>
                  setHooks({
                    noProgress: v === "" ? undefined : { maxTurns: Number(v) },
                  })
                }
              />
              <StringListField
                label={labels.hooks.pathGuardAllowedPaths}
                labels={labels.stringList}
                readOnly={readOnly}
                testid="node-hooks-path-guard-allowed-paths"
                values={strList(asRec(hooks.pathGuard).allowedPaths)}
                onChange={(next) =>
                  setHooks({
                    pathGuard: next.length ? { allowedPaths: next } : undefined,
                  })
                }
              />
              <label className="flex items-center gap-2">
                <input
                  checked={Boolean(hooks.disabled)}
                  data-testid="node-hooks-disabled"
                  disabled={readOnly}
                  type="checkbox"
                  onChange={(e) =>
                    setHooks({
                      disabled: e.target.checked ? true : undefined,
                    })
                  }
                />
                <span className={LABEL_CLS}>{labels.hooks.disabled}</span>
              </label>
              <p className="font-mono text-[10px] text-mute">
                {labels.hooks.hint}
              </p>
            </div>
          </>
        ) : null}
        {type === "ai_coding" || type === "orchestrator" ? (
          <SelectField
            label={labels.workspaceAccess}
            options={["read", "write", "none"]}
            readOnly={readOnly}
            testid="node-workspace-access"
            value={str(settings.workspaceAccess)}
            onChange={(v) => setSetting("workspaceAccess", v || undefined)}
          />
        ) : null}
        {type === "orchestrator" ? (
          <div className="grid gap-2" data-testid="node-delegation">
            <h4 className={SECTION_CLS}>{labels.delegation}</h4>
            <TextField
              label={labels.maxFanout}
              readOnly={readOnly}
              testid="node-delegation-max-fanout"
              type="number"
              value={str(delegation.max_fanout)}
              onChange={(v) =>
                setDelegation({ max_fanout: v === "" ? undefined : Number(v) })
              }
            />
            <TextField
              label={labels.maxDepth}
              readOnly={readOnly}
              testid="node-delegation-max-depth"
              type="number"
              value={str(delegation.max_depth)}
              onChange={(v) =>
                setDelegation({ max_depth: v === "" ? undefined : Number(v) })
              }
            />
          </div>
        ) : null}
        {type === "form" ? (
          <SchemaRefField
            label={labels.formSchema}
            labels={labels.schemaRef}
            readOnly={readOnly}
            schemaFiles={schemaFiles}
            testid="node-form-schema"
            value={str(settings.form_schema)}
            onChange={(v) => setSetting("form_schema", v)}
            onWriteSchemaFile={onWriteSchemaFile}
          />
        ) : null}
        {isCommandType ? (
          <>
            <TextField
              label={labels.timeoutMs}
              readOnly={readOnly}
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
              readOnly={readOnly}
              testid="node-environment-policy"
              value={str(settings.environmentPolicy)}
              onChange={(v) => setSetting("environmentPolicy", v || undefined)}
            />
            <SelectField
              label={labels.failureClass}
              options={["blocking", "advisory", "retryable"]}
              readOnly={readOnly}
              testid="node-failure-class"
              value={str(settings.failureClass)}
              onChange={(v) => setSetting("failureClass", v || undefined)}
            />
          </>
        ) : null}
        {isConsensusType ? (
          <div className="grid gap-3" data-testid="node-consensus-settings">
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className={SECTION_CLS}>
                  {labels.consensus.participants}
                </span>
                {readOnly ? null : (
                  <button
                    aria-label={labels.consensus.addParticipant}
                    className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:bg-paper"
                    data-testid="node-consensus-add-participant"
                    type="button"
                    onClick={addParticipant}
                  >
                    <PlusIcon aria-hidden="true" className="h-3 w-3" />
                    {labels.consensus.addParticipant}
                  </button>
                )}
              </div>
              {participants.map((participant, index) => (
                <div
                  key={`${index}:${str(participant.id)}`}
                  className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)_auto]"
                  data-testid={`node-consensus-participant-${index}`}
                >
                  <TextField
                    label={labels.consensus.participantId}
                    readOnly={readOnly}
                    testid={`node-consensus-participant-id-${index}`}
                    value={str(participant.id)}
                    onChange={(v) => setParticipant(index, { id: v })}
                  />
                  <ReferenceCombobox
                    asAgentLabel={labels.consensus.asAgent}
                    asRunnerLabel={labels.consensus.asRunner}
                    emptyHint={labels.consensus.sourceEmptyHint}
                    groups={participantSources}
                    label={labels.consensus.participantSource}
                    placeholder={labels.consensus.sourcePlaceholder}
                    readOnly={readOnly}
                    testid={`node-consensus-participant-source-${index}`}
                    unknownKind={unknownSourceKindFor(
                      sourceValueFor(participant),
                      sourceDeclaredKindFor(participant),
                      sourceSets,
                    )}
                    value={sourceValueFor(participant)}
                    onInputValue={(value) =>
                      setParticipantSource(
                        index,
                        resolveFreeTextSourceKind(value, sourceSets),
                        value,
                      )
                    }
                    onSelect={(value, kind) => {
                      if (!isActorSourceKind(kind)) return;
                      setParticipantSource(index, kind, value);
                    }}
                    onUnknownKindChange={(kind) =>
                      setParticipantSource(
                        index,
                        kind,
                        sourceValueFor(participant),
                      )
                    }
                  />
                  {readOnly ? null : (
                    <button
                      aria-label={labels.consensus.removeParticipant}
                      className="inline-flex h-[34px] items-center self-end rounded-md border border-danger-line px-2 text-danger hover:bg-danger-soft"
                      data-testid={`node-consensus-remove-participant-${index}`}
                      type="button"
                      onClick={() => removeParticipant(index)}
                    >
                      <TrashIcon aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="grid gap-1">
              <StringListField
                label={labels.consensus.materialAxes}
                labels={labels.stringList}
                readOnly={readOnly}
                testid="node-consensus-material-axes"
                values={strList(n.material_axes)}
                onChange={(next) => emit({ ...n, material_axes: next })}
              />
              <p className="font-mono text-[10px] text-mute">
                {labels.consensus.materialAxesHint}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2">
              <ReferenceCombobox
                asAgentLabel={labels.consensus.asAgent}
                asRunnerLabel={labels.consensus.asRunner}
                emptyHint={labels.consensus.sourceEmptyHint}
                groups={participantSources}
                label={labels.consensus.synthesizerSource}
                placeholder={labels.consensus.sourcePlaceholder}
                readOnly={readOnly}
                testid="node-consensus-synthesizer-source"
                unknownKind={unknownSourceKindFor(
                  sourceValueFor(synthesizer),
                  sourceDeclaredKindFor(synthesizer),
                  sourceSets,
                )}
                value={sourceValueFor(synthesizer)}
                onInputValue={(value) =>
                  setSynthesizerSource(
                    resolveFreeTextSourceKind(value, sourceSets),
                    value,
                  )
                }
                onSelect={(value, kind) => {
                  if (!isActorSourceKind(kind)) return;
                  setSynthesizerSource(kind, value);
                }}
                onUnknownKindChange={(kind) =>
                  setSynthesizerSource(kind, sourceValueFor(synthesizer))
                }
              />
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              <SelectField
                label={labels.consensus.roundsMode}
                options={["single_pass", "iterate"]}
                readOnly={readOnly}
                testid="node-consensus-rounds-mode"
                value={str(asRec(n.rounds).mode)}
                onChange={(v) =>
                  emit({
                    ...n,
                    rounds: { ...asRec(n.rounds), mode: v || "single_pass" },
                  })
                }
              />
              <TextField
                label={labels.consensus.roundsMax}
                readOnly={readOnly}
                testid="node-consensus-rounds-max"
                type="number"
                value={str(asRec(n.rounds).max)}
                onChange={(v) =>
                  emit({
                    ...n,
                    rounds: {
                      ...asRec(n.rounds),
                      max: v === "" ? 1 : Number(v),
                    },
                  })
                }
              />
              <SelectField
                label={labels.consensus.onNoConsensus}
                options={["escalate"]}
                readOnly={readOnly}
                testid="node-consensus-on-no-consensus"
                value={str(n.on_no_consensus)}
                onChange={(v) =>
                  emit({ ...n, on_no_consensus: v || "escalate" })
                }
              />
            </div>
          </div>
        ) : null}
        {type === "human" ? (
          <>
            <StringListField
              label={labels.decisions}
              labels={labels.stringList}
              readOnly={readOnly}
              testid="node-decisions"
              values={strList(settings.decisions)}
              onChange={(next) =>
                setSetting("decisions", next.length ? next : undefined)
              }
            />
            <SelectField
              label={labels.criticality}
              options={["low", "medium", "high", "critical"]}
              readOnly={readOnly}
              testid="node-criticality"
              value={str(settings.criticality)}
              onChange={(v) => setSetting("criticality", v || undefined)}
            />
            <StringListField
              label={labels.roles}
              labels={labels.stringList}
              readOnly={readOnly}
              testid="node-roles"
              values={strList(settings.roles)}
              onChange={(next) =>
                setSetting("roles", next.length ? next : undefined)
              }
            />
            <StringListField
              label={labels.assignees}
              labels={labels.stringList}
              readOnly={readOnly}
              testid="node-assignees"
              values={strList(settings.assignees)}
              onChange={(next) =>
                setSetting("assignees", next.length ? next : undefined)
              }
            />
            <label className="flex items-center gap-2">
              <input
                checked={Boolean(settings.allowTakeover)}
                data-testid="node-allow-takeover"
                disabled={readOnly}
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
              readOnly={readOnly}
              onChange={(next) => setGate(index, next)}
              onRemove={() => removeGateAt(index)}
            />
          ))
        )}
      </section>

      {showRouting ? (
        <section className="grid gap-2" data-testid="node-decide">
          <h3 className={SECTION_CLS}>{labels.decide.title}</h3>
          <label className="grid gap-1">
            <span className={LABEL_CLS}>{labels.decide.source}</span>
            <select
              className={FIELD_CLS}
              data-testid="node-decide-source"
              disabled={readOnly}
              value={decideSource}
              onChange={(e) =>
                setDecideSource(e.target.value as "" | "output" | "verdict")
              }
            >
              <option value="">{labels.decide.sourceNone}</option>
              <option value="output">{labels.decide.sourceOutput}</option>
              <option value="verdict">{labels.decide.sourceVerdict}</option>
            </select>
          </label>
          {decideSource === "output" ? (
            <TextField
              label={labels.decide.path}
              readOnly={readOnly}
              testid="node-decide-path"
              value={decideFrom}
              onChange={(v) => setDecide({ from: v })}
            />
          ) : null}
          {decideSource === "verdict" ? (
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <span className={LABEL_CLS}>{labels.decide.title}</span>
                {readOnly ? null : (
                  <button
                    aria-label={labels.decide.addCase}
                    className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:bg-paper"
                    data-testid="node-decide-add-case"
                    type="button"
                    onClick={addVerdictCase}
                  >
                    <PlusIcon aria-hidden="true" className="h-3 w-3" />
                    {labels.decide.addCase}
                  </button>
                )}
              </div>
              {whenCases.length === 0 ? (
                <p className="font-mono text-[10px] text-mute">
                  {labels.decide.noCases}
                </p>
              ) : (
                whenCases.map(({ c, i }, row) => (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"
                    data-testid={`node-decide-case-${row}`}
                  >
                    <label className="grid gap-1">
                      <span className={LABEL_CLS}>{labels.decide.when}</span>
                      <input
                        className={FIELD_CLS}
                        data-testid={`node-decide-when-${row}`}
                        readOnly={readOnly}
                        value={str(c.when)}
                        onChange={(e) =>
                          setVerdictCase(i, e.target.value, str(c.target))
                        }
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className={LABEL_CLS}>{labels.decide.target}</span>
                      <input
                        className={FIELD_CLS}
                        data-testid={`node-decide-case-target-${row}`}
                        readOnly={readOnly}
                        value={str(c.target)}
                        onChange={(e) =>
                          setVerdictCase(i, str(c.when), e.target.value)
                        }
                      />
                    </label>
                    {readOnly ? null : (
                      <button
                        aria-label={labels.decide.removeCase}
                        className="inline-flex h-[34px] items-center rounded-md border border-danger-line px-2 text-danger hover:bg-danger-soft"
                        data-testid={`node-decide-remove-case-${row}`}
                        type="button"
                        onClick={() => removeVerdictCase(i)}
                      >
                        <TrashIcon aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))
              )}
              <TextField
                label={labels.decide.default}
                readOnly={readOnly}
                testid="node-decide-default"
                value={str(defaultCase?.target)}
                onChange={(v) => setDefaultTarget(v)}
              />
            </div>
          ) : null}
          {hasOutputResult ? (
            <>
              <label className="grid gap-1">
                <span className={LABEL_CLS}>{labels.decide.onMismatch}</span>
                <select
                  className={FIELD_CLS}
                  data-testid="node-decide-onmismatch"
                  disabled={readOnly}
                  value={onMismatch}
                  onChange={(e) => setOnMismatch(e.target.value)}
                >
                  <option value="">{labels.decide.onMismatchNone}</option>
                  <option value="retry">{labels.decide.onMismatchRetry}</option>
                  {Object.keys(transitions).map((outcome) => (
                    <option key={outcome} value={outcome}>
                      {outcome}
                    </option>
                  ))}
                </select>
              </label>
              <p className="font-mono text-[10px] text-mute">
                {labels.decide.hint}
              </p>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="grid gap-2">
        <div className="flex items-center justify-between">
          <h3 className={SECTION_CLS}>{labels.transitions}</h3>
          {readOnly ? null : (
            <button
              className="rounded-md border border-line px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:bg-paper"
              data-testid="add-transition"
              type="button"
              onClick={addTransitionRow}
            >
              {labels.addTransition}
            </button>
          )}
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
                    readOnly={readOnly}
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
                    readOnly={readOnly}
                    value={target}
                    onChange={(e) =>
                      setTransitionRow(index, outcome, e.target.value)
                    }
                  />
                </label>
                {readOnly ? null : (
                  <button
                    className="h-[34px] rounded-md border border-line px-2 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:bg-paper"
                    data-testid={`transition-remove-${index}`}
                    type="button"
                    onClick={() => removeTransitionRow(index)}
                  >
                    {labels.removeTransition}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="grid gap-2">
        <h3 className={SECTION_CLS}>{labels.rework}</h3>
        <StringListField
          label={labels.reworkAllowedTargets}
          labels={labels.stringList}
          readOnly={readOnly}
          testid="node-rework-allowed-targets"
          values={strList(rework.allowedTargets)}
          onChange={(next) =>
            setRework({
              allowedTargets: next,
              workspacePolicies: (rework.workspacePolicies as
                | string[]
                | undefined) ?? ["keep"],
              maxLoops: (rework.maxLoops as number | undefined) ?? 1,
            })
          }
        />
        <TextField
          label={labels.reworkMaxLoops}
          readOnly={readOnly}
          testid="node-rework-max-loops"
          type="number"
          value={str(rework.maxLoops)}
          onChange={(v) =>
            setRework({ maxLoops: v === "" ? undefined : Number(v) })
          }
        />
        <MultiSelectField
          label={labels.reworkWorkspacePolicies}
          labels={labels.multiSelect}
          mode="fixed"
          options={WORKSPACE_POLICY_OPTIONS}
          readOnly={readOnly}
          testid="node-rework-workspace-policies"
          values={strList(rework.workspacePolicies)}
          onChange={(next) =>
            setRework({
              workspacePolicies: next,
              allowedTargets:
                (rework.allowedTargets as string[] | undefined) ?? [],
              maxLoops: (rework.maxLoops as number | undefined) ?? 1,
            })
          }
        />
        <TextField
          label={labels.reworkCommentsVar}
          readOnly={readOnly}
          testid="node-rework-comments-var"
          value={str(rework.commentsVar)}
          onChange={(v) => setRework({ commentsVar: v || undefined })}
        />
      </section>

      <section className="grid gap-2">
        <h3 className={SECTION_CLS}>{labels.output}</h3>
        <SchemaRefField
          label={labels.outputSchema}
          labels={labels.schemaRef}
          readOnly={readOnly}
          schemaFiles={schemaFiles}
          testid="node-output-schema"
          value={str(result.schema)}
          onChange={(v) => setResult({ schema: v })}
          onWriteSchemaFile={onWriteSchemaFile}
        />
        <label className="flex items-center gap-2">
          <input
            checked={Boolean(result.required)}
            data-testid="node-output-required"
            disabled={readOnly}
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
