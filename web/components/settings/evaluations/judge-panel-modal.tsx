"use client";

import type { JudgePanelRow, PanelRoleBinding } from "./types";
import type { ReactElement } from "react";

import { PlusIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  evalErrorKey,
  evalRequest,
} from "@/components/evaluations/api-error";
import { useFeedback } from "@/components/feedback/feedback-provider";
import { useModalFocusTrap } from "@/components/feedback/use-modal-focus-trap";

type Props = {
  mode: "create" | "edit";
  panel?: JudgePanelRow;
  onClose: () => void;
};

const NUMERIC_FIELDS = [
  "attempts",
  "maxParallelAttempts",
  "quorum",
  "timeoutMs",
  "maxRetries",
] as const;

type NumericField = (typeof NUMERIC_FIELDS)[number];

// Client mirror of the server contract (lib/evaluations/config-schemas.ts
// panelPolicySchema): ints within these bounds, plus quorum <= attempts.
const NUMERIC_BOUNDS: Record<NumericField, { min: number; max: number }> = {
  attempts: { min: 1, max: 64 },
  maxParallelAttempts: { min: 1, max: 64 },
  quorum: { min: 1, max: 64 },
  timeoutMs: { min: 1, max: 3_600_000 },
  maxRetries: { min: 0, max: 16 },
};

const DEFAULT_POLICY = {
  attempts: 3,
  maxParallelAttempts: 2,
  quorum: 2,
  timeoutMs: 600_000,
  maxRetries: 1,
  blindLabels: true,
  randomizeOrder: true,
};

export function JudgePanelModal({ mode, panel, onClose }: Props): ReactElement | null {
  const t = useTranslations("settingsEvaluations");
  const tErr = useTranslations("evaluationsErrors");
  const feedback = useFeedback();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [name, setName] = useState(panel?.name ?? "");
  const [roles, setRoles] = useState<PanelRoleBinding[]>(
    panel?.roleBindings.length
      ? panel.roleBindings.map((r) => ({ role: r.role, agentId: r.agentId }))
      : [{ role: "reviewer", agentId: "" }],
  );
  const [policy, setPolicy] = useState({
    ...DEFAULT_POLICY,
    ...(panel?.policy ?? {}),
  });
  const [allowedMcps, setAllowedMcps] = useState(
    (panel?.policy.allowedMcps ?? []).join(", "),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  function requestClose(): void {
    if (!saving) onClose();
  }

  useModalFocusTrap(dialogRef, requestClose);

  function setNumeric(field: NumericField, value: string): void {
    setPolicy((p) => ({
      ...p,
      [field]: value === "" ? Number.NaN : Number(value),
    }));
  }

  function fieldInvalid(field: NumericField): boolean {
    const value = policy[field];
    const bounds = NUMERIC_BOUNDS[field];

    return (
      !Number.isInteger(value) || value < bounds.min || value > bounds.max
    );
  }

  const boundsInvalid = NUMERIC_FIELDS.some(fieldInvalid);
  const quorumExceedsAttempts =
    !boundsInvalid && policy.quorum > policy.attempts;
  const policyInvalid = boundsInvalid || quorumExceedsAttempts;

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      roleBindings: roles.map((r) => ({
        role: r.role.trim(),
        agentId: r.agentId.trim(),
      })),
      policy: {
        attempts: policy.attempts,
        maxParallelAttempts: policy.maxParallelAttempts,
        quorum: policy.quorum,
        timeoutMs: policy.timeoutMs,
        maxRetries: policy.maxRetries,
        blindLabels: policy.blindLabels,
        randomizeOrder: policy.randomizeOrder,
        allowedMcps: allowedMcps
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      },
    };

    try {
      if (mode === "create") {
        await evalRequest("/api/admin/evaluations/judge-panels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        await evalRequest(
          `/api/admin/evaluations/judge-panels/${panel!.id}`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "if-match": String(panel!.revision),
            },
            body: JSON.stringify(body),
          },
        );
      }

      feedback.success({
        mutationId: `eval-panel:${mode}:${panel?.id ?? "new"}:${Date.now()}`,
        message: t("toastSaved"),
      });
      startTransition(() => router.refresh());
      onClose();
    } catch (err) {
      setError(tErr(evalErrorKey(err)));
    } finally {
      setSaving(false);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button
        aria-label={t("close")}
        className="absolute inset-0 cursor-default bg-black/40"
        disabled={saving}
        tabIndex={-1}
        type="button"
        onClick={requestClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="judge-panel-modal-title"
        aria-modal="true"
        className="relative max-h-[90vh] w-full max-w-[620px] overflow-y-auto rounded-[12px] border border-line bg-paper p-6 shadow-xl"
        role="dialog"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2
            className="m-0 text-[15px] font-semibold text-ink"
            id="judge-panel-modal-title"
          >
            {mode === "create" ? t("panelCreate") : t("panelEdit")}
          </h2>
          <button
            aria-label={t("close")}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-mute hover:text-ink disabled:opacity-50"
            disabled={saving}
            type="button"
            onClick={requestClose}
          >
            <XMarkIcon aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>

        <label className="mb-4 flex flex-col gap-1.5">
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {t("panelName")}
          </span>
          <input
            className="h-10 rounded-[8px] border border-line bg-paper px-3 text-[13px] text-ink outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <fieldset className="mb-4 border-0 p-0">
          <legend className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {t("panelRoles")}
          </legend>
          <div className="flex flex-col gap-2">
            {roles.map((role, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  aria-label={t("panelRole")}
                  className="h-9 w-[34%] rounded-[8px] border border-line bg-paper px-2.5 text-[12px] text-ink outline-none"
                  placeholder={t("panelRole")}
                  value={role.role}
                  onChange={(e) =>
                    setRoles((rs) =>
                      rs.map((r, i) =>
                        i === index ? { ...r, role: e.target.value } : r,
                      ),
                    )
                  }
                />
                <input
                  aria-label={t("panelAgentId")}
                  className="h-9 flex-1 rounded-[8px] border border-line bg-paper px-2.5 font-mono text-[12px] text-ink outline-none"
                  placeholder="package:agent"
                  value={role.agentId}
                  onChange={(e) =>
                    setRoles((rs) =>
                      rs.map((r, i) =>
                        i === index ? { ...r, agentId: e.target.value } : r,
                      ),
                    )
                  }
                />
                <button
                  aria-label={t("panelRoleRemove")}
                  className="grid h-9 w-9 place-items-center rounded-[8px] border border-[#b5332b]/40 text-[#b5332b] disabled:opacity-40"
                  disabled={roles.length === 1}
                  type="button"
                  onClick={() =>
                    setRoles((rs) => rs.filter((_, i) => i !== index))
                  }
                >
                  <TrashIcon aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              className="inline-flex h-9 w-fit items-center gap-1.5 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink hover:border-mute"
              type="button"
              onClick={() =>
                setRoles((rs) => [...rs, { role: "", agentId: "" }])
              }
            >
              <PlusIcon aria-hidden="true" className="h-4 w-4" />
              {t("panelRoleAdd")}
            </button>
          </div>
        </fieldset>

        <fieldset className="mb-4 border-0 p-0">
          <legend className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {t("panelPolicy")}
          </legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {NUMERIC_FIELDS.map((field) => (
              <label key={field} className="flex flex-col gap-1">
                <span className="text-[11px] text-mute">{t(field)}</span>
                <input
                  aria-invalid={fieldInvalid(field) || undefined}
                  className="h-9 rounded-[8px] border border-line bg-paper px-2.5 text-[12px] text-ink outline-none aria-[invalid]:border-danger"
                  max={NUMERIC_BOUNDS[field].max}
                  min={NUMERIC_BOUNDS[field].min}
                  type="number"
                  value={Number.isFinite(policy[field]) ? policy[field] : ""}
                  onChange={(e) => setNumeric(field, e.target.value)}
                />
              </label>
            ))}
          </div>
          {policyInvalid ? (
            <p className="mt-2 text-[12px] text-danger" role="alert">
              {quorumExceedsAttempts ? t("quorumBound") : t("policyBounds")}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-[12px] text-ink">
              <input
                checked={policy.blindLabels}
                type="checkbox"
                onChange={(e) =>
                  setPolicy((p) => ({ ...p, blindLabels: e.target.checked }))
                }
              />
              {t("blindLabels")}
            </label>
            <label className="flex items-center gap-2 text-[12px] text-ink">
              <input
                checked={policy.randomizeOrder}
                type="checkbox"
                onChange={(e) =>
                  setPolicy((p) => ({ ...p, randomizeOrder: e.target.checked }))
                }
              />
              {t("randomizeOrder")}
            </label>
          </div>
          <label className="mt-3 flex flex-col gap-1">
            <span className="text-[11px] text-mute">{t("allowedMcps")}</span>
            <input
              className="h-9 rounded-[8px] border border-line bg-paper px-2.5 font-mono text-[12px] text-ink outline-none"
              placeholder="mcp-a, mcp-b"
              value={allowedMcps}
              onChange={(e) => setAllowedMcps(e.target.value)}
            />
          </label>
        </fieldset>

        {error ? (
          <p className="mb-3 text-[12px] text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            className="h-10 rounded-[8px] border border-line px-4 text-[13px] font-semibold text-ink disabled:opacity-50"
            disabled={saving}
            type="button"
            onClick={requestClose}
          >
            {t("cancel")}
          </button>
          <button
            className="h-10 rounded-[8px] border border-line bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-50"
            disabled={saving || name.trim().length === 0 || policyInvalid}
            type="button"
            onClick={() => void save()}
          >
            {t("save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
