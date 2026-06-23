"use client";

import type {
  AdapterId,
  PermissionPolicy,
  ProviderKind,
  RunnerDraft,
} from "@/lib/acp-runners/runner-form";
import type { ReactElement } from "react";

import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import {
  buildCreateBody,
  buildPatchBody,
  permissionPoliciesForAdapter,
  providerKindsForAdapter,
  validateRunnerDraft,
} from "@/lib/acp-runners/runner-form";
import { adapterSetupHint } from "@/lib/acp-runners/setup-hints";
import { ModelAutocomplete } from "@/components/settings/model-autocomplete";
import { useModelSuggestions } from "@/components/settings/use-model-suggestions";

type Provider = {
  kind: string;
  baseUrl?: string;
  authToken?: string;
  apiKey?: string;
  projectId?: string;
  location?: string;
  wireApi?: "responses";
};

type EnvRow = {
  id: string;
  key: string;
  value: string;
};

export interface RunnerRow {
  id: string;
  adapter: AdapterId;
  capabilityAgent: AdapterId;
  model: string;
  env?: Record<string, string>;
  provider: Provider;
  permissionPolicy: PermissionPolicy;
  sidecarId: string | null;
  readinessStatus: "Unknown" | "Ready" | "NotReady";
  readinessReasons: readonly string[];
  enabled: boolean;
}

export interface PresetRow {
  id: string;
  adapter: AdapterId;
  model: string;
  env?: Record<string, string>;
  provider: Provider;
  permissionPolicy: PermissionPolicy;
  sidecarId?: string | null;
}

export interface AcpRunnerModalProps {
  mode: "create" | "edit";
  runner?: RunnerRow;
  sidecars: { id: string }[];
  presets: PresetRow[];
  initialPresetId?: string;
  unavailableAdapters?: readonly AdapterId[];
  onClose: () => void;
  onSaved: () => void;
}

const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

function draftFromProvider(
  adapter: AdapterId,
  provider: Provider,
  permissionPolicy: PermissionPolicy,
  sidecarId: string | null,
  enabled: boolean,
  id: string,
  model: string,
  env?: Record<string, string>,
): RunnerDraft {
  return {
    id,
    adapter,
    model,
    env,
    providerKind: provider.kind as ProviderKind,
    baseUrl: provider.baseUrl,
    authToken: provider.authToken,
    apiKey: provider.apiKey,
    projectId: provider.projectId,
    location: provider.location,
    wireApi: provider.wireApi === "responses",
    permissionPolicy,
    sidecarId,
    enabled,
  };
}

function seedDraft(mode: "create" | "edit", runner?: RunnerRow): RunnerDraft {
  if (mode === "edit" && runner) {
    return draftFromProvider(
      runner.adapter,
      runner.provider,
      runner.permissionPolicy,
      runner.sidecarId,
      runner.enabled,
      runner.id,
      runner.model,
      runner.env,
    );
  }

  return {
    id: "",
    adapter: "claude",
    model: "",
    providerKind: "anthropic",
    permissionPolicy: "default",
    sidecarId: null,
    enabled: true,
  };
}

function envRowsFrom(env: Record<string, string> | undefined): EnvRow[] {
  return Object.entries(env ?? {}).map(([key, value], index) => ({
    id: `${key}-${index}`,
    key,
    value,
  }));
}

function envFromRows(rows: EnvRow[]): Record<string, string> | undefined {
  const entries = rows
    .map((row) => [row.key.trim(), row.value.trim()] as const)
    .filter(([key, value]) => key.length > 0 || value.length > 0);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function draftWithEnv(draft: RunnerDraft, rows: EnvRow[]): RunnerDraft {
  const env = envFromRows(rows);

  return env ? { ...draft, env } : { ...draft, env: undefined };
}

async function sendJson(
  url: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
    } | null;

    return {
      ok: false,
      code: payload?.code,
      message:
        payload?.message ?? payload?.code ?? `Request failed: ${res.status}`,
    };
  }

  return { ok: true };
}

export function AcpRunnerModal({
  mode,
  runner,
  sidecars,
  presets,
  initialPresetId,
  unavailableAdapters,
  onClose,
  onSaved,
}: AcpRunnerModalProps): ReactElement {
  const t = useTranslations("settings");
  const [draft, setDraft] = useState<RunnerDraft>(() => {
    if (mode === "create" && initialPresetId) {
      const preset = presets.find((item) => item.id === initialPresetId);

      if (preset) {
        const sidecarId =
          preset.sidecarId && sidecars.some((s) => s.id === preset.sidecarId)
            ? preset.sidecarId
            : null;

        return draftFromProvider(
          preset.adapter,
          preset.provider,
          preset.permissionPolicy,
          sidecarId,
          true,
          "",
          preset.model,
          preset.env,
        );
      }
    }

    return seedDraft(mode, runner);
  });
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => {
    if (mode === "create" && initialPresetId) {
      const preset = presets.find((item) => item.id === initialPresetId);

      if (preset) return envRowsFrom(preset.env);
    }

    return envRowsFrom(seedDraft(mode, runner).env);
  });
  const [selectedPresetId, setSelectedPresetId] = useState(
    initialPresetId ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const originalDraft = useRef<RunnerDraft>(seedDraft(mode, runner));
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];

    focusable()[0]?.focus();

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();

        return;
      }

      if (event.key !== "Tab") return;

      const items = focusable();

      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, []);

  const submitDraft = draftWithEnv(draft, envRows);
  const { ok, errors } = validateRunnerDraft(submitDraft);
  const providerKind = draft.providerKind;
  const modelSuggestions = useModelSuggestions(draft, presets);
  const unknownModel =
    draft.model.trim().length > 0 &&
    !modelSuggestions.groups.some((group) =>
      group.models.some((model) => model.id === draft.model),
    );

  function patchDraft(patch: Partial<RunnerDraft>): void {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function changeAdapter(adapter: AdapterId): void {
    patchDraft({
      adapter,
      providerKind: providerKindsForAdapter(adapter)[0],
      permissionPolicy: permissionPoliciesForAdapter(adapter)[0],
    });
  }

  function applyPreset(presetId: string): void {
    const preset = presets.find((p) => p.id === presetId);

    if (!preset) return;

    const sidecarId =
      preset.sidecarId && sidecars.some((s) => s.id === preset.sidecarId)
        ? preset.sidecarId
        : null;

    setDraft((current) =>
      draftFromProvider(
        preset.adapter,
        preset.provider,
        preset.permissionPolicy,
        sidecarId,
        true,
        current.id,
        preset.model,
        preset.env,
      ),
    );
    setEnvRows(envRowsFrom(preset.env));
  }

  function errorFor(field: string): string | undefined {
    if (!errors[field]) return undefined;
    if (field === "id") return t("validId");
    if (field === "baseUrl") return t("validUrl");
    if (field === "authToken" || field === "apiKey") return t("validEnvRef");
    if (field === "env") return t("validEnvMap");

    return errors[field];
  }

  function addEnvRow(): void {
    setEnvRows((current) => [
      ...current,
      { id: `new-${current.length}-${Date.now()}`, key: "", value: "" },
    ]);
  }

  function patchEnvRow(
    rowId: string,
    patch: Partial<Pick<EnvRow, "key" | "value">>,
  ): void {
    setEnvRows((current) =>
      current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
    );
  }

  function removeEnvRow(rowId: string): void {
    setEnvRows((current) => current.filter((row) => row.id !== rowId));
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const result =
        mode === "create"
          ? await sendJson(
              "/api/admin/acp-runners",
              "POST",
              buildCreateBody(submitDraft),
            )
          : await sendJson(
              `/api/admin/acp-runners/${runner?.id ?? ""}`,
              "PATCH",
              buildPatchBody(submitDraft, originalDraft.current),
            );

      if (!result.ok) {
        setError(`${t("saveFailed")}: ${result.message ?? ""}`);

        return;
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(
        `${t("saveFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!confirmingDelete) {
      setConfirmingDelete(true);

      return;
    }

    setBusy(true);
    setError(null);
    setDeleteBlocked(false);

    try {
      const res = await fetch(`/api/admin/acp-runners/${runner?.id ?? ""}`, {
        method: "DELETE",
      });

      if (res.status === 204) {
        onSaved();
        onClose();

        return;
      }

      const payload = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;

      if (payload?.code === "CONFLICT") {
        setDeleteBlocked(true);
        setError(payload.message ?? "");
      } else {
        setError(payload?.message ?? `Request failed: ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label="Close"
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="acp-runner-modal-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2
            className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
            id="acp-runner-modal-title"
          >
            {mode === "create" ? t("createRunnerTitle") : t("editRunnerTitle")}
          </h2>
          <button
            aria-label="Close"
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5">
          {mode === "create" && presets.length > 0 ? (
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("fromPreset")}</span>
              <select
                className={inputClass}
                disabled={busy}
                value={selectedPresetId}
                onChange={(e) => {
                  setSelectedPresetId(e.target.value);
                  applyPreset(e.target.value);
                }}
              >
                <option value="" />
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldId")}</span>
            {mode === "create" ? (
              <input
                autoComplete="off"
                className={inputClass}
                disabled={busy}
                spellCheck={false}
                type="text"
                value={draft.id}
                onChange={(e) => patchDraft({ id: e.target.value })}
              />
            ) : (
              <code className="font-mono text-[12px] text-ink">{draft.id}</code>
            )}
            {errorFor("id") ? (
              <span className="font-mono text-[10.5px] text-[#b5332b]">
                {errorFor("id")}
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("colAdapter")}</span>
            {mode === "create" ? (
              <select
                className={inputClass}
                disabled={busy}
                value={draft.adapter}
                onChange={(e) => changeAdapter(e.target.value as AdapterId)}
              >
                {ADAPTER_IDS.map((adapter) => (
                  <option key={adapter} value={adapter}>
                    {adapter}
                  </option>
                ))}
              </select>
            ) : (
              <code className="font-mono text-[12px] text-ink">
                {draft.adapter}
              </code>
            )}
            {unavailableAdapters?.includes(draft.adapter) ? (
              <span className="rounded-lg border border-amber-line bg-amber-soft px-2.5 py-1.5 text-[11px] leading-[1.45] text-ink-2">
                {t(adapterSetupHint(draft.adapter))}
              </span>
            ) : null}
          </label>

          <div className="flex flex-col gap-1.5">
            <ModelAutocomplete
              error={modelSuggestions.error}
              groups={modelSuggestions.groups}
              label={t("fieldModel")}
              loading={modelSuggestions.loading}
              unknownModel={unknownModel}
              value={draft.model}
              onRefresh={modelSuggestions.refresh}
              onValueChange={(model) => patchDraft({ model })}
            />
            {errorFor("model") ? (
              <span className="font-mono text-[10.5px] text-[#b5332b]">
                {errorFor("model")}
              </span>
            ) : null}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldProviderKind")}</span>
            <select
              className={inputClass}
              disabled={busy}
              value={providerKind}
              onChange={(e) =>
                patchDraft({ providerKind: e.target.value as ProviderKind })
              }
            >
              {providerKindsForAdapter(draft.adapter).map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            {errorFor("providerKind") ? (
              <span className="font-mono text-[10.5px] text-[#b5332b]">
                {errorFor("providerKind")}
              </span>
            ) : null}
          </label>

          {providerKind === "anthropic_compatible" ? (
            <>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("fieldBaseUrl")}</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  spellCheck={false}
                  type="text"
                  value={draft.baseUrl ?? ""}
                  onChange={(e) =>
                    patchDraft({ baseUrl: e.target.value || undefined })
                  }
                />
                {errorFor("baseUrl") ? (
                  <span className="font-mono text-[10.5px] text-[#b5332b]">
                    {errorFor("baseUrl")}
                  </span>
                ) : null}
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("fieldAuthToken")}</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  spellCheck={false}
                  type="text"
                  value={draft.authToken ?? ""}
                  onChange={(e) =>
                    patchDraft({ authToken: e.target.value || undefined })
                  }
                />
                {errorFor("authToken") ? (
                  <span className="font-mono text-[10.5px] text-[#b5332b]">
                    {errorFor("authToken")}
                  </span>
                ) : null}
              </label>
            </>
          ) : null}

          {providerKind === "openai_compatible" ? (
            <>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("fieldBaseUrl")}</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  spellCheck={false}
                  type="text"
                  value={draft.baseUrl ?? ""}
                  onChange={(e) =>
                    patchDraft({ baseUrl: e.target.value || undefined })
                  }
                />
                {errorFor("baseUrl") ? (
                  <span className="font-mono text-[10.5px] text-[#b5332b]">
                    {errorFor("baseUrl")}
                  </span>
                ) : null}
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("fieldApiKey")}</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  spellCheck={false}
                  type="text"
                  value={draft.apiKey ?? ""}
                  onChange={(e) =>
                    patchDraft({ apiKey: e.target.value || undefined })
                  }
                />
                {errorFor("apiKey") ? (
                  <span className="font-mono text-[10.5px] text-[#b5332b]">
                    {errorFor("apiKey")}
                  </span>
                ) : null}
              </label>
              <label className="flex items-center gap-2 text-[12px] text-mute">
                <input
                  checked={draft.wireApi ?? false}
                  disabled={busy}
                  type="checkbox"
                  onChange={(e) => patchDraft({ wireApi: e.target.checked })}
                />
                {t("fieldWireApi")}
              </label>
            </>
          ) : null}

          {providerKind === "google_gateway" ? (
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("fieldBaseUrl")}</span>
              <input
                autoComplete="off"
                className={inputClass}
                disabled={busy}
                spellCheck={false}
                type="text"
                value={draft.baseUrl ?? ""}
                onChange={(e) =>
                  patchDraft({ baseUrl: e.target.value || undefined })
                }
              />
              {errorFor("baseUrl") ? (
                <span className="font-mono text-[10.5px] text-[#b5332b]">
                  {errorFor("baseUrl")}
                </span>
              ) : null}
            </label>
          ) : null}

          {providerKind === "google_vertex" ? (
            <>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("fieldProjectId")}</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  spellCheck={false}
                  type="text"
                  value={draft.projectId ?? ""}
                  onChange={(e) =>
                    patchDraft({ projectId: e.target.value || undefined })
                  }
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("fieldLocation")}</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  spellCheck={false}
                  type="text"
                  value={draft.location ?? ""}
                  onChange={(e) =>
                    patchDraft({ location: e.target.value || undefined })
                  }
                />
              </label>
            </>
          ) : null}

          {providerKind === "google_gemini" ||
          providerKind === "google_vertex" ||
          providerKind === "google_gateway" ? (
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("fieldApiKey")}</span>
              <input
                autoComplete="off"
                className={inputClass}
                disabled={busy}
                spellCheck={false}
                type="text"
                value={draft.apiKey ?? ""}
                onChange={(e) =>
                  patchDraft({ apiKey: e.target.value || undefined })
                }
              />
              {errorFor("apiKey") ? (
                <span className="font-mono text-[10.5px] text-[#b5332b]">
                  {errorFor("apiKey")}
                </span>
              ) : null}
            </label>
          ) : null}

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className={fieldLabel}>{t("fieldEnv")}</span>
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-line px-2.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink hover:border-mute disabled:opacity-50"
                disabled={busy}
                type="button"
                onClick={addEnvRow}
              >
                <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
                {t("addEnv")}
              </button>
            </div>
            <span className="font-mono text-[10.5px] leading-4 text-mute">
              {t("fieldEnvHint")}
            </span>
            {envRows.length > 0 ? (
              <div className="flex flex-col gap-2">
                {envRows.map((row) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_36px]"
                  >
                    <input
                      aria-label={t("fieldEnvKey")}
                      autoComplete="off"
                      className={inputClass}
                      disabled={busy}
                      spellCheck={false}
                      type="text"
                      value={row.key}
                      onChange={(e) =>
                        patchEnvRow(row.id, { key: e.target.value })
                      }
                    />
                    <input
                      aria-label={t("fieldEnvValue")}
                      autoComplete="off"
                      className={inputClass}
                      disabled={busy}
                      spellCheck={false}
                      type="text"
                      value={row.value}
                      onChange={(e) =>
                        patchEnvRow(row.id, { value: e.target.value })
                      }
                    />
                    <button
                      aria-label={t("removeEnv")}
                      className="grid h-9 w-9 place-items-center rounded-[8px] border border-line text-mute hover:border-mute hover:text-ink disabled:opacity-50"
                      disabled={busy}
                      title={t("removeEnv")}
                      type="button"
                      onClick={() => removeEnvRow(row.id)}
                    >
                      <TrashIcon aria-hidden="true" className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {errorFor("env") ? (
              <span className="font-mono text-[10.5px] text-[#b5332b]">
                {errorFor("env")}
              </span>
            ) : null}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldPermissionPolicy")}</span>
            <select
              className={inputClass}
              disabled={busy}
              value={draft.permissionPolicy}
              onChange={(e) =>
                patchDraft({
                  permissionPolicy: e.target.value as PermissionPolicy,
                })
              }
            >
              {permissionPoliciesForAdapter(draft.adapter).map((policy) => (
                <option key={policy} value={policy}>
                  {policy === "default"
                    ? t("policyDefault")
                    : t("policyDangerous")}
                </option>
              ))}
            </select>
            {errorFor("permissionPolicy") ? (
              <span className="font-mono text-[10.5px] text-[#b5332b]">
                {errorFor("permissionPolicy")}
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldSidecar")}</span>
            <select
              className={inputClass}
              disabled={busy}
              value={draft.sidecarId ?? ""}
              onChange={(e) =>
                patchDraft({ sidecarId: e.target.value || null })
              }
            >
              <option value="">{t("sidecarNone")}</option>
              {sidecars.map((sidecar) => (
                <option key={sidecar.id} value={sidecar.id}>
                  {sidecar.id}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-[12px] text-mute">
            <input
              checked={draft.enabled}
              disabled={busy}
              type="checkbox"
              onChange={(e) => patchDraft({ enabled: e.target.checked })}
            />
            {t("fieldEnabled")}
          </label>

          {error ? (
            <div
              aria-live="assertive"
              className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
              role="alert"
            >
              {deleteBlocked ? (
                <div className="mb-1.5 flex flex-col gap-1">
                  <span>{t("deleteBlockedTitle")}</span>
                  <span className="font-normal">{t("deleteBlockedIntro")}</span>
                </div>
              ) : null}
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-4">
          <div>
            {mode === "edit" ? (
              <button
                className="touch-manipulation rounded-lg border border-[#b5332b]/40 bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-[#b5332b] hover:border-[#b5332b] hover:bg-[#b5332b]/5"
                disabled={busy}
                title={confirmingDelete ? t("deleteConfirm") : undefined}
                type="button"
                onClick={() => void remove()}
              >
                {confirmingDelete ? t("deleteConfirm") : t("deleteRunner")}
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="touch-manipulation rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
              disabled={busy}
              type="button"
              onClick={onClose}
            >
              {t("cancel")}
            </button>
            <button
              className={clsx(
                "touch-manipulation rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2",
                (busy || !ok) && "opacity-60",
              )}
              disabled={busy || !ok}
              type="button"
              onClick={() => void submit()}
            >
              {busy ? t("saving") : t("save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
