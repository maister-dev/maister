"use client";

import type { GateKind } from "@/lib/flows/editor/editor-state";
import type { ReactElement } from "react";

export type GateDraft = {
  id: string;
  kind: GateKind;
  mode?: "blocking" | "advisory";
  command?: string;
  prompt?: string;
  skill?: string;
  calibration?: { confidence_min?: number; allow_missing_confidence?: boolean };
  external?: { description?: string; staleOnNewCommit?: boolean };
};

export type GateFormLabels = {
  mode: string;
  modeBlocking: string;
  modeAdvisory: string;
  command: string;
  prompt: string;
  skill: string;
  confidenceMin: string;
  externalDescription: string;
  staleOnNewCommit: string;
  remove: string;
  kind: Record<GateKind, string>;
};

const FIELD_CLS =
  "rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-amber";
const LABEL_CLS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute";

function showsCalibration(kind: GateKind): boolean {
  return kind === "ai_judgment" || kind === "skill_check";
}

export function GateForm({
  gate,
  labels,
  onChange,
  onRemove,
}: {
  gate: GateDraft;
  labels: GateFormLabels;
  onChange: (next: GateDraft) => void;
  onRemove: () => void;
}): ReactElement {
  const patch = (next: Partial<GateDraft>): void =>
    onChange({ ...gate, ...next });

  return (
    <div
      className="grid gap-2 rounded-lg border border-line bg-ivory p-3"
      data-testid={`gate-form-${gate.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-bold text-ink">
          {gate.id} · {labels.kind[gate.kind]}
        </span>
        <button
          className="rounded-md border border-line px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:bg-paper"
          data-testid="gate-remove"
          type="button"
          onClick={onRemove}
        >
          {labels.remove}
        </button>
      </div>

      <label className="grid gap-1">
        <span className={LABEL_CLS}>{labels.mode}</span>
        <select
          className={FIELD_CLS}
          data-testid="gate-mode"
          value={gate.mode ?? "blocking"}
          onChange={(e) => patch({ mode: e.target.value as GateDraft["mode"] })}
        >
          <option value="blocking">{labels.modeBlocking}</option>
          <option value="advisory">{labels.modeAdvisory}</option>
        </select>
      </label>

      {gate.kind === "command_check" || gate.kind === "external_check" ? (
        <label className="grid gap-1">
          <span className={LABEL_CLS}>{labels.command}</span>
          <input
            className={FIELD_CLS}
            data-testid="gate-command"
            value={gate.command ?? ""}
            onChange={(e) => patch({ command: e.target.value })}
          />
        </label>
      ) : null}

      {gate.kind === "skill_check" ? (
        <label className="grid gap-1">
          <span className={LABEL_CLS}>{labels.skill}</span>
          <input
            className={FIELD_CLS}
            data-testid="gate-skill"
            value={gate.skill ?? ""}
            onChange={(e) => patch({ skill: e.target.value })}
          />
        </label>
      ) : null}

      {gate.kind === "ai_judgment" ? (
        <label className="grid gap-1">
          <span className={LABEL_CLS}>{labels.prompt}</span>
          <input
            className={FIELD_CLS}
            data-testid="gate-prompt"
            value={gate.prompt ?? ""}
            onChange={(e) => patch({ prompt: e.target.value })}
          />
        </label>
      ) : null}

      {showsCalibration(gate.kind) ? (
        <label className="grid gap-1">
          <span className={LABEL_CLS}>{labels.confidenceMin}</span>
          <input
            className={FIELD_CLS}
            data-testid="gate-confidence-min"
            max={1}
            min={0}
            step={0.05}
            type="number"
            value={gate.calibration?.confidence_min ?? ""}
            onChange={(e) =>
              patch({
                calibration: {
                  ...gate.calibration,
                  confidence_min:
                    e.target.value === "" ? undefined : Number(e.target.value),
                },
              })
            }
          />
        </label>
      ) : null}

      {gate.kind === "external_check" ? (
        <div className="grid gap-2">
          <label className="flex items-center gap-2">
            <input
              checked={gate.external?.staleOnNewCommit ?? true}
              data-testid="gate-stale-on-new-commit"
              type="checkbox"
              onChange={(e) =>
                patch({
                  external: {
                    ...gate.external,
                    staleOnNewCommit: e.target.checked,
                  },
                })
              }
            />
            <span className={LABEL_CLS}>{labels.staleOnNewCommit}</span>
          </label>
          <label className="grid gap-1">
            <span className={LABEL_CLS}>{labels.externalDescription}</span>
            <input
              className={FIELD_CLS}
              data-testid="gate-external-description"
              value={gate.external?.description ?? ""}
              onChange={(e) =>
                patch({
                  external: { ...gate.external, description: e.target.value },
                })
              }
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
