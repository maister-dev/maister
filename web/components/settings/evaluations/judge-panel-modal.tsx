"use client";

import type { JudgePanelRow, PanelRoleBinding } from "./types";
import type { ReactElement } from "react";

import { PlusIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

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

const DEFAULT_POLICY = {
  attempts: 3,
  maxParallelAttempts: 2,
  quorum: 2,
  timeoutMs: 600_000,
  maxRetries: 1,
  blindLabels: true,
  randomizeOrder: true,
};

export function JudgePanelModal({ mode, panel, onClose }: Props): ReactElement {
  const t = useTranslations("settingsEvaluations");
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

  function setNumeric(field: NumericField, value: string): void {
    setPolicy((p) => ({ ...p, [field]: Number(value) }));
  }

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
      const res =
        mode === "create"
          ? await fetch("/api/admin/evaluations/judge-panels", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          : await fetch(`/api/admin/evaluations/judge-panels/${panel!.id}`, {
              method: "PATCH",
              headers: {
                "content-type": "application/json",
                "if-match": String(panel!.revision),
              },
              body: JSON.stringify(body),
            });

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;

        throw new Error(payload?.message ?? `request failed: ${res.status}`);
      }

      startTransition(() => router.refresh());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      aria-labelledby="judge-panel-modal-title"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      role="dialog"
    >
      <div className="max-h-[90vh] w-full max-w-[620px] overflow-y-auto rounded-[12px] border border-line bg-paper p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2
            className="m-0 text-[15px] font-semibold text-ink"
            id="judge-panel-modal-title"
          >
            {mode === "create" ? t("panelCreate") : t("panelEdit")}
          </h2>
          <button
            aria-label={t("close")}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
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
                  className="h-9 rounded-[8px] border border-line bg-paper px-2.5 text-[12px] text-ink outline-none"
                  min={field === "maxRetries" ? 0 : 1}
                  type="number"
                  value={policy[field]}
                  onChange={(e) => setNumeric(field, e.target.value)}
                />
              </label>
            ))}
          </div>
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
          <p className="mb-3 text-[12px] text-red-700" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            className="h-10 rounded-[8px] border border-line px-4 text-[13px] font-semibold text-ink"
            type="button"
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            className="h-10 rounded-[8px] border border-line bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-50"
            disabled={saving || name.trim().length === 0}
            type="button"
            onClick={() => void save()}
          >
            {t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
