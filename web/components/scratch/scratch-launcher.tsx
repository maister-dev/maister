"use client";

import type { ReactElement } from "react";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";

type AttachmentKind = "issue_url" | "file_path" | "text_note";

type ProjectOption = {
  id: string;
  slug: string;
  name: string;
  mainBranch: string;
};

type ExecutorOption = {
  id: string;
  executorRefId: string;
  agent: "claude" | "codex";
  model: string | null;
  router: string | null;
};

type CapabilityOption = {
  id: string;
  recordId: string;
  kind: string;
  label: string;
  source: string;
  enforceability: string;
  selectedByDefault: boolean;
  agents: unknown;
};

type LaunchOptions = {
  projects: ProjectOption[];
  selectedProjectId: string | null;
  defaultBaseBranch?: string;
  defaultScratchBranch?: string;
  branches: string[];
  executors: ExecutorOption[];
  capabilities: {
    mcps: CapabilityOption[];
    skills: CapabilityOption[];
    rules: CapabilityOption[];
    restrictions: CapabilityOption[];
    defaultSelectedMcpIds: string[];
  };
};

type AttachmentInput = {
  kind: AttachmentKind;
  label: string;
  value: string;
};

type ApiError = {
  code?: string;
  message?: string;
};

const fieldLabel =
  "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute";
const inputBase =
  "w-full rounded-lg border border-line bg-paper px-3.5 py-3 font-mono text-[13px] leading-[1.35] text-ink outline-none transition focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)] placeholder:text-mute";
const sectionShell =
  "rounded-lg border border-line-soft bg-[color-mix(in_oklab,var(--ivory)_35%,var(--paper))] p-3";
const checkboxLine =
  "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-[12px] text-ink-2 hover:bg-paper";

function selectedDefaults(options: readonly CapabilityOption[]): string[] {
  return options
    .filter((option) => option.selectedByDefault)
    .map((option) => option.id);
}

function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

function errorText(payload: ApiError | null): string {
  if (!payload) return "Request failed.";
  if (payload.message) return payload.message;
  if (payload.code) return payload.code;

  return "Request failed.";
}

function CapabilityGroup({
  label,
  options,
  selectedIds,
  onToggle,
}: {
  label: string;
  options: CapabilityOption[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}): ReactElement | null {
  if (options.length === 0) return null;

  return (
    <details open className="rounded-lg border border-line bg-paper">
      <summary className="cursor-pointer px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute">
        {label} · {selectedIds.length}/{options.length}
      </summary>
      <div className="border-t border-line-soft p-1.5">
        {options.map((option) => (
          <label key={option.id} className={checkboxLine}>
            <input
              aria-label={option.label}
              checked={selectedIds.includes(option.id)}
              className="mt-0.5 accent-amber"
              type="checkbox"
              onChange={() => onToggle(option.id)}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-ink">
                {option.label}
              </span>
              <span className="block truncate font-mono text-[10.5px] text-mute">
                {option.source} · {option.enforceability}
              </span>
            </span>
          </label>
        ))}
      </div>
    </details>
  );
}

export function ScratchLauncher(): ReactElement {
  const t = useTranslations("scratch");
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialProjectId = searchParams.get("projectId");

  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [workspaceName, setWorkspaceName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branchName, setBranchName] = useState("");
  const [executorId, setExecutorId] = useState("");
  const [planMode, setPlanMode] = useState(false);
  const [linkedIssueUrl, setLinkedIssueUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<AttachmentInput[]>([]);
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [ruleIds, setRuleIds] = useState<string[]>([]);
  const [restrictionIds, setRestrictionIds] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    const query = projectId
      ? `?projectId=${encodeURIComponent(projectId)}`
      : "";

    setLoading(true);
    setError(null);

    fetch(`/api/scratch-runs/launch-options${query}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(errorText(await response.json().catch(() => null)));
        }

        return (await response.json()) as LaunchOptions;
      })
      .then((payload) => {
        setOptions(payload);
        setProjectId(payload.selectedProjectId ?? "");
        setBaseBranch(payload.defaultBaseBranch ?? payload.branches[0] ?? "");
        setBranchName(payload.defaultScratchBranch ?? "");
        setExecutorId(payload.executors[0]?.id ?? "");
        setMcpIds(
          payload.capabilities.defaultSelectedMcpIds.length > 0
            ? payload.capabilities.defaultSelectedMcpIds
            : selectedDefaults(payload.capabilities.mcps),
        );
        setSkillIds(selectedDefaults(payload.capabilities.skills));
        setRuleIds(selectedDefaults(payload.capabilities.rules));
        setRestrictionIds(selectedDefaults(payload.capabilities.restrictions));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [projectId]);

  const selectedProject = useMemo(
    () => options?.projects.find((project) => project.id === projectId) ?? null,
    [options?.projects, projectId],
  );
  const canSubmit =
    !!projectId &&
    !!baseBranch &&
    !!branchName.trim() &&
    !!executorId &&
    !!prompt.trim() &&
    !pending;

  function addAttachment(kind: AttachmentKind): void {
    setAttachments((current) => [...current, { kind, label: "", value: "" }]);
  }

  function updateAttachment(
    index: number,
    patch: Partial<AttachmentInput>,
  ): void {
    setAttachments((current) =>
      current.map((attachment, itemIndex) =>
        itemIndex === index ? { ...attachment, ...patch } : attachment,
      ),
    );
  }

  function removeAttachment(index: number): void {
    setAttachments((current) =>
      current.filter((_, itemIndex) => itemIndex !== index),
    );
  }

  async function handleSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);

    const cleanedAttachments = attachments
      .map((attachment) => ({
        kind: attachment.kind,
        label: attachment.label.trim() || undefined,
        value: attachment.value.trim(),
      }))
      .filter((attachment) => attachment.value.length > 0);

    try {
      const response = await fetch("/api/scratch-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          baseBranch,
          branchName: branchName.trim(),
          name: workspaceName.trim() || undefined,
          executorId,
          planMode: planMode ? "plan-first" : "off",
          linkedIssueUrl: linkedIssueUrl.trim() || undefined,
          prompt: prompt.trim(),
          attachments: cleanedAttachments,
          capabilities: {
            mcpIds,
            skillIds,
            ruleIds,
            restrictionIds,
          },
        }),
      });

      if (response.status !== 201 && response.status !== 202) {
        setError(errorText(await response.json().catch(() => null)));

        return;
      }

      const payload = (await response.json()) as { runId: string };

      router.push(`/scratch-runs/${payload.runId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  if (loading && !options) {
    return (
      <div className="rounded-lg border border-line bg-paper px-4 py-5 font-mono text-[12px] text-mute">
        {t("loadingOptions")}
      </div>
    );
  }

  return (
    <form
      className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]"
      onSubmit={handleSubmit}
    >
      <section className="flex min-w-0 flex-col gap-4">
        <div className={sectionShell}>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("project")}</span>
              <select
                className={inputBase}
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                {options?.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("executor")}</span>
              <select
                className={inputBase}
                value={executorId}
                onChange={(event) => setExecutorId(event.target.value)}
              >
                {options?.executors.map((executor) => (
                  <option key={executor.id} value={executor.id}>
                    {executor.executorRefId} · {executor.agent}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("workspaceName")}</span>
              <input
                className={inputBase}
                placeholder={t("workspaceNamePlaceholder")}
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("baseBranch")}</span>
              <select
                className={inputBase}
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
              >
                {options?.branches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 md:col-span-2">
              <span className={fieldLabel}>{t("branchName")}</span>
              <input
                className={inputBase}
                placeholder={
                  selectedProject
                    ? `${selectedProject.slug}/scratch/my-change`
                    : "scratch/my-change"
                }
                spellCheck={false}
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
              />
            </label>
          </div>
        </div>

        <div className={sectionShell}>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("prompt")}</span>
            <textarea
              className={clsx(inputBase, "min-h-[220px] resize-y")}
              placeholder={t("promptPlaceholder")}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <label className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2.5 text-[12px] font-medium text-ink-2">
            <input
              checked={planMode}
              className="accent-amber"
              type="checkbox"
              onChange={(event) => setPlanMode(event.target.checked)}
            />
            {t("planMode")}
          </label>
        </div>

        <div className={sectionShell}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className={fieldLabel}>{t("attachments")}</span>
            <div className="flex flex-wrap gap-1.5">
              {(["issue_url", "file_path", "text_note"] as const).map(
                (kind) => (
                  <button
                    key={kind}
                    className="rounded-full border border-line bg-paper px-2.5 py-1 font-mono text-[10.5px] text-ink-2 hover:border-amber hover:text-amber"
                    type="button"
                    onClick={() => addAttachment(kind)}
                  >
                    + {t(`attachmentKind.${kind}`)}
                  </button>
                ),
              )}
            </div>
          </div>
          <label className="mb-3 flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("linkedIssue")}</span>
            <input
              className={inputBase}
              placeholder="https://github.com/org/repo/issues/123"
              type="url"
              value={linkedIssueUrl}
              onChange={(event) => setLinkedIssueUrl(event.target.value)}
            />
          </label>
          {attachments.length === 0 ? (
            <p className="text-[12px] leading-[1.5] text-mute">
              {t("noAttachments")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {attachments.map((attachment, index) => (
                <div
                  key={`${attachment.kind}-${index}`}
                  className="grid gap-2 rounded-lg border border-line bg-paper p-2 md:grid-cols-[120px_1fr_1.5fr_auto]"
                >
                  <select
                    className={inputBase}
                    value={attachment.kind}
                    onChange={(event) =>
                      updateAttachment(index, {
                        kind: event.target.value as AttachmentKind,
                      })
                    }
                  >
                    <option value="issue_url">
                      {t("attachmentKind.issue_url")}
                    </option>
                    <option value="file_path">
                      {t("attachmentKind.file_path")}
                    </option>
                    <option value="text_note">
                      {t("attachmentKind.text_note")}
                    </option>
                  </select>
                  <input
                    className={inputBase}
                    placeholder={t("attachmentLabel")}
                    value={attachment.label}
                    onChange={(event) =>
                      updateAttachment(index, { label: event.target.value })
                    }
                  />
                  <input
                    className={inputBase}
                    placeholder={t("attachmentValue")}
                    value={attachment.value}
                    onChange={(event) =>
                      updateAttachment(index, { value: event.target.value })
                    }
                  />
                  <button
                    className="rounded-lg border border-line px-3 font-mono text-[11px] text-mute hover:border-amber hover:text-amber"
                    type="button"
                    onClick={() => removeAttachment(index)}
                  >
                    {t("remove")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <aside className="flex flex-col gap-4">
        <div className={sectionShell}>
          <div className="mb-3 flex items-center justify-between">
            <span className={fieldLabel}>{t("capabilities")}</span>
            <span className="font-mono text-[10.5px] text-mute">
              {t("capabilitiesHint")}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <CapabilityGroup
              label={t("mcps")}
              options={options?.capabilities.mcps ?? []}
              selectedIds={mcpIds}
              onToggle={(id) => setMcpIds((current) => toggleId(current, id))}
            />
            <CapabilityGroup
              label={t("skills")}
              options={options?.capabilities.skills ?? []}
              selectedIds={skillIds}
              onToggle={(id) => setSkillIds((current) => toggleId(current, id))}
            />
            <CapabilityGroup
              label={t("rules")}
              options={options?.capabilities.rules ?? []}
              selectedIds={ruleIds}
              onToggle={(id) => setRuleIds((current) => toggleId(current, id))}
            />
            <CapabilityGroup
              label={t("restrictions")}
              options={options?.capabilities.restrictions ?? []}
              selectedIds={restrictionIds}
              onToggle={(id) =>
                setRestrictionIds((current) => toggleId(current, id))
              }
            />
          </div>
        </div>

        {error ? (
          <div className="rounded-lg border border-[#d9534f]/40 bg-[#d9534f]/10 px-3 py-2 text-[12px] leading-[1.5] text-[#d9534f]">
            {error}
          </div>
        ) : null}

        <button
          className="flex w-full items-center justify-center gap-2 rounded-full bg-amber px-5 py-3.5 text-sm font-semibold text-white shadow-[0_8px_24px_-10px_var(--amber)] transition-[transform,background] hover:-translate-y-px hover:bg-amber-2 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={!canSubmit}
          type="submit"
        >
          {pending ? t("launching") : t("launch")}
          <span className="font-mono">→</span>
        </button>
      </aside>
    </form>
  );
}
