"use client";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { ProjectCapabilityCatalogEntry } from "@/lib/capabilities/project-catalog";
import type { LaunchStage } from "@/lib/runs/launch-progress";
import type { ReactElement } from "react";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";

import { CapabilityComposer } from "@/components/capabilities/capability-composer";
import { readLaunchStream } from "@/lib/runs/launch-progress";

type AttachmentKind = "issue_url" | "file_path" | "text_note";
type WorkMode = "auto" | "plan_first" | "manual_approval";
type ReasoningEffort = "low" | "high" | "extra" | "ultra";

type ProjectOption = {
  id: string;
  slug: string;
  name: string;
  mainBranch: string;
};

type RunnerOption = {
  id: string;
  displayLabel: string;
  adapter: string;
  capabilityAgent: AdapterId;
  model: string | null;
  providerKind: string;
  permissionPolicy: string;
  sidecarId: string | null;
  enabled: boolean;
  ready: boolean;
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
  machine: {
    id: string;
    label: string;
    readOnly: true;
  };
  projects: ProjectOption[];
  selectedProjectId: string | null;
  defaultBaseBranch?: string;
  defaultScratchBranch?: string;
  defaultRunnerId?: string | null;
  branches: string[];
  runners: RunnerOption[];
  workModes: Array<{
    id: WorkMode;
    label: string;
    selectedByDefault: boolean;
  }>;
  reasoningEfforts: Array<{
    id: ReasoningEffort;
    label: string;
    selectedByDefault: boolean;
  }>;
  capabilities: {
    mcps: CapabilityOption[];
    skills: CapabilityOption[];
    rules: CapabilityOption[];
    agentDefinitions: CapabilityOption[];
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

type ScratchLaunchResponse = {
  runId: string;
  dialogUrl?: string;
};

export type ScratchLauncherProps = {
  initialProjectId?: string | null;
  onLaunched?: (response: ScratchLaunchResponse) => void;
};

const commandShell =
  "overflow-hidden rounded-[18px] border border-line bg-paper shadow-[0_24px_70px_-48px_var(--ink)]";
const commandBand = "bg-[color-mix(in_oklab,var(--ivory)_55%,var(--paper))]";
const detailShell =
  "rounded-lg border border-line-soft bg-[color-mix(in_oklab,var(--ivory)_34%,var(--paper))]";
const iconButton =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-ivory text-mute shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset] transition hover:border-amber hover:bg-paper hover:text-amber";
const contextPill =
  "inline-flex h-8 min-w-0 items-center gap-2 rounded-full border border-transparent bg-transparent px-2.5 text-[13px] font-medium text-mute transition hover:border-line-soft hover:bg-paper hover:text-ink";
const invisibleSelect =
  "absolute inset-0 h-full w-full cursor-pointer opacity-0";
const checkboxLine =
  "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-[12px] text-ink-2 hover:bg-paper";
const summaryButton =
  "flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2 transition hover:bg-ivory hover:text-amber [&::-webkit-details-marker]:hidden";

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

function selectedCount(...lists: readonly string[][]): number {
  return lists.reduce((sum, list) => sum + list.length, 0);
}

function iconLabel(label: string): string {
  return label.trim().length > 0 ? label : "untitled";
}

function bytesSummary(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;

  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;

  const mib = kib / 1024;

  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

function PaperclipIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-[18px] w-[18px]"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <path d="m21.4 11.4-9.7 9.7a5.8 5.8 0 0 1-8.2-8.2l10.4-10.4a3.9 3.9 0 0 1 5.5 5.5L9.7 17.7a2 2 0 1 1-2.8-2.8l8.9-8.9" />
    </svg>
  );
}

function ArrowUpIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

function BranchIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      <path d="M6 3v12" />
      <path d="M18 9a3 3 0 1 0-3-3" />
      <path d="M6 15a3 3 0 1 0 3 3" />
      <path d="M18 9c0 3.5-2.7 5-6 5H9" />
    </svg>
  );
}

function ProjectIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
    </svg>
  );
}

function MachineIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      <rect height="12" rx="2" width="18" x="3" y="4" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </svg>
  );
}

function AgentMark({
  agent,
}: {
  agent: RunnerOption["capabilityAgent"];
}): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        "inline-flex h-5 w-5 items-center justify-center rounded-full font-mono text-[11px] font-semibold",
        agent === "claude"
          ? "bg-[#f27f4c]/15 text-[#f27f4c]"
          : "bg-amber-soft text-amber",
      )}
    >
      {agent === "claude" ? "*" : "C"}
    </span>
  );
}

function CapabilityGroup({
  label,
  options,
  selectedIds,
  onToggle,
  readOnly,
  note,
}: {
  label: string;
  options: CapabilityOption[];
  selectedIds?: string[];
  onToggle?: (id: string) => void;
  // readOnly: the selection is not user-controlled (scratch skills are always
  // broad, FR-C3) — every option is shown as included and cannot be toggled.
  readOnly?: boolean;
  note?: string;
}): ReactElement | null {
  if (options.length === 0) return null;

  return (
    <details className="rounded-lg border border-line bg-paper">
      <summary className={summaryButton}>
        <span>{label}</span>
        <span className="rounded-full bg-ivory px-2 py-0.5 text-[10px] text-mute">
          {readOnly
            ? options.length
            : `${selectedIds?.length ?? 0}/${options.length}`}
        </span>
      </summary>
      <div className="border-t border-line-soft p-1.5">
        {note ? (
          <p className="px-1.5 pb-1 font-mono text-[10px] leading-snug text-mute">
            {note}
          </p>
        ) : null}
        {options.map((option) => (
          <label key={option.id} className={checkboxLine}>
            <input
              aria-label={option.label}
              checked={
                readOnly ? true : (selectedIds?.includes(option.id) ?? false)
              }
              className="mt-0.5 accent-amber"
              disabled={readOnly}
              type="checkbox"
              onChange={() => onToggle?.(option.id)}
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

export function ScratchLauncher({
  initialProjectId,
  onLaunched,
}: ScratchLauncherProps = {}): ReactElement {
  const t = useTranslations("scratch");
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeProjectId = searchParams.get("projectId");
  const requestedProjectId = initialProjectId ?? routeProjectId ?? "";

  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(requestedProjectId);
  const [workspaceName, setWorkspaceName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branchName, setBranchName] = useState("");
  const [runnerId, setRunnerId] = useState("");
  const [workMode, setWorkMode] = useState<WorkMode>("auto");
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("high");
  const [linkedIssueUrl, setLinkedIssueUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<AttachmentInput[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [filePreviews, setFilePreviews] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [ruleIds, setRuleIds] = useState<string[]>([]);
  const [agentDefinitionIds, setAgentDefinitionIds] = useState<string[]>([]);
  const [restrictionIds, setRestrictionIds] = useState<string[]>([]);
  const [launchStage, setLaunchStage] = useState<LaunchStage | null>(null);
  const launchAbortRef = useRef<AbortController | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
        setBranchName("");
        setRunnerId(payload.defaultRunnerId ?? payload.runners[0]?.id ?? "");
        setWorkMode(
          payload.workModes.find((option) => option.selectedByDefault)?.id ??
            "auto",
        );
        setReasoningEffort(
          payload.reasoningEfforts.find((option) => option.selectedByDefault)
            ?.id ?? "high",
        );
        setMcpIds(
          payload.capabilities.defaultSelectedMcpIds.length > 0
            ? payload.capabilities.defaultSelectedMcpIds
            : selectedDefaults(payload.capabilities.mcps),
        );
        setRuleIds(selectedDefaults(payload.capabilities.rules));
        setAgentDefinitionIds(
          selectedDefaults(payload.capabilities.agentDefinitions),
        );
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

  useEffect(() => {
    const previews = new Map<string, string>();

    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;

      previews.set(file.name, URL.createObjectURL(file));
    }

    setFilePreviews(previews);

    return () => {
      for (const url of previews.values()) URL.revokeObjectURL(url);
    };
  }, [files]);

  const selectedProject = useMemo(
    () => options?.projects.find((project) => project.id === projectId) ?? null,
    [options?.projects, projectId],
  );
  const selectedRunner = useMemo(
    () => options?.runners.find((runner) => runner.id === runnerId) ?? null,
    [options?.runners, runnerId],
  );
  // FR-D: static capability catalog for the composer's autocomplete, per the
  // selected runner (re-fetched on project/runner switch — FR-D10).
  const composerAgent: AdapterId = selectedRunner?.capabilityAgent ?? "claude";
  const [capabilityCatalog, setCapabilityCatalog] = useState<
    ProjectCapabilityCatalogEntry[]
  >([]);

  useEffect(() => {
    const slug = selectedProject?.slug;

    if (!slug) {
      setCapabilityCatalog([]);

      return;
    }
    const ctrl = new AbortController();

    fetch(
      `/api/projects/${encodeURIComponent(slug)}/capability-catalog?agent=${encodeURIComponent(composerAgent)}`,
      { signal: ctrl.signal },
    )
      .then((res) => (res.ok ? res.json() : { capabilities: [] }))
      .then((payload: { capabilities?: ProjectCapabilityCatalogEntry[] }) =>
        setCapabilityCatalog(payload.capabilities ?? []),
      )
      .catch(() => {
        if (!ctrl.signal.aborted) setCapabilityCatalog([]);
      });

    return () => ctrl.abort();
  }, [selectedProject?.slug, composerAgent]);
  const contextCount =
    files.length + attachments.length + (linkedIssueUrl.trim() ? 1 : 0);
  // skills are excluded: scratch always materializes all of them (broad,
  // FR-C3), so they are not a user-selected capability to count here.
  const capabilityCount = selectedCount(
    mcpIds,
    ruleIds,
    agentDefinitionIds,
    restrictionIds,
  );
  const canSubmit =
    !!projectId &&
    !!baseBranch &&
    !!runnerId &&
    Boolean(selectedRunner?.enabled && selectedRunner.ready) &&
    !pending;

  useEffect(() => {
    setProjectId(requestedProjectId);
  }, [requestedProjectId]);

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

  function removeFile(index: number): void {
    setFiles((current) =>
      current.filter((_, itemIndex) => itemIndex !== index),
    );
    if (fileInputRef.current) fileInputRef.current.value = "";
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
      const launchPayload = {
        projectId,
        baseBranch,
        branchName: branchName.trim() || undefined,
        name: workspaceName.trim() || undefined,
        runnerId,
        workMode,
        reasoningEffort,
        linkedIssueUrl: linkedIssueUrl.trim() || undefined,
        prompt: prompt.trim(),
        attachments: cleanedAttachments,
        capabilities: {
          // skillIds omitted: scratch materializes ALL project skills (broad,
          // FR-C3); a submitted selection is ignored, so we do not send one.
          mcpIds,
          ruleIds,
          agentDefinitionIds,
          restrictionIds,
        },
      };
      const requestInit: RequestInit =
        files.length > 0
          ? (() => {
              const formData = new FormData();

              formData.set("payload", JSON.stringify(launchPayload));
              for (const file of files) formData.append("files", file);

              return { method: "POST", body: formData };
            })()
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(launchPayload),
            };
      const controller = new AbortController();

      launchAbortRef.current = controller;
      setLaunchStage("precondition");

      const response = await fetch("/api/scratch-runs", {
        ...requestInit,
        signal: controller.signal,
      });

      // A pre-stream precondition failure short-circuits to a JSON error with
      // its HTTP status; only the staged launch is `text/event-stream`.
      if (
        !(response.headers.get("content-type") ?? "").includes(
          "text/event-stream",
        )
      ) {
        setError(errorText(await response.json().catch(() => null)));

        return;
      }

      const streamed = await readLaunchStream<ScratchLaunchResponse>(
        response,
        setLaunchStage,
      );

      if (streamed.error) {
        setError(errorText(streamed.error));

        return;
      }
      if (!streamed.result) {
        setError(t("launchInterrupted"));

        return;
      }

      if (onLaunched) {
        onLaunched(streamed.result);
      } else {
        router.push(
          streamed.result.dialogUrl ?? `/scratch-runs/${streamed.result.runId}`,
        );
      }
      router.refresh();
    } catch (err) {
      // A user cancel (abort) GCs server-side; surface nothing.
      if (!launchAbortRef.current?.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      launchAbortRef.current = null;
      setLaunchStage(null);
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
    <form ref={formRef} className="flex flex-col gap-3" onSubmit={handleSubmit}>
      <section className={commandShell}>
        <div
          className={clsx(
            commandBand,
            "flex flex-col gap-3 p-4 pb-3 md:flex-row md:items-center",
          )}
        >
          <input
            aria-label={t("workspaceName")}
            className="min-w-0 flex-1 bg-transparent text-[24px] font-semibold leading-none text-ink outline-none placeholder:text-mute"
            placeholder={t("workspaceNamePlaceholder")}
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
          />
          <input
            aria-label={t("branchName")}
            className="min-w-0 bg-transparent font-mono text-[19px] leading-none text-ink outline-none placeholder:text-mute md:w-[280px] md:text-right"
            placeholder={
              selectedProject ? t("branchNamePlaceholder") : t("optional")
            }
            spellCheck={false}
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
          />
        </div>

        <div className="mx-4 flex min-h-[280px] flex-col rounded-[18px] border border-line-soft bg-paper-warm p-3">
          {files.length > 0 ||
          attachments.length > 0 ||
          linkedIssueUrl.trim() ? (
            <div className="mb-3 flex max-h-[118px] flex-col gap-2 overflow-y-auto pr-1">
              {files.length > 0 ? (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {files.map((file, index) => {
                    const preview = filePreviews.get(file.name) ?? null;

                    return (
                      <div
                        key={`${file.name}-${index}`}
                        className="group relative flex min-w-[160px] max-w-[220px] items-center gap-2 rounded-lg border border-line-soft bg-paper p-2"
                      >
                        {preview ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            alt=""
                            className="h-10 w-10 rounded-md object-cover"
                            src={preview}
                          />
                        ) : (
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-ivory font-mono text-[10px] text-mute">
                            FILE
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-semibold text-ink">
                            {iconLabel(file.name)}
                          </span>
                          <span className="block font-mono text-[10.5px] text-mute">
                            {bytesSummary(file.size)}
                          </span>
                        </span>
                        <button
                          aria-label={t("remove")}
                          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-ink/70 font-mono text-[11px] text-white opacity-0 transition group-hover:opacity-100"
                          type="button"
                          onClick={() => removeFile(index)}
                        >
                          x
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {linkedIssueUrl.trim() ? (
                <div className="grid gap-2 rounded-lg border border-line-soft bg-paper p-2 md:grid-cols-[120px_1fr_auto]">
                  <span className="self-center rounded-full bg-ivory px-2 py-1 font-mono text-[10.5px] font-semibold text-mute">
                    {t("linkedIssue")}
                  </span>
                  <input
                    aria-label={t("linkedIssue")}
                    className="min-w-0 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-mute"
                    placeholder="https://github.com/org/repo/issues/123"
                    type="url"
                    value={linkedIssueUrl}
                    onChange={(event) => setLinkedIssueUrl(event.target.value)}
                  />
                  <button
                    className="rounded-md px-2 font-mono text-[11px] text-mute hover:bg-ivory hover:text-amber"
                    type="button"
                    onClick={() => setLinkedIssueUrl("")}
                  >
                    {t("remove")}
                  </button>
                </div>
              ) : null}

              {attachments.map((attachment, index) => (
                <div
                  key={`${attachment.kind}-${index}`}
                  className="grid gap-2 rounded-lg border border-line-soft bg-paper p-2 md:grid-cols-[112px_1fr_1.4fr_auto]"
                >
                  <select
                    aria-label={t("attachment")}
                    className="min-w-0 rounded-md bg-ivory px-2 py-1 font-mono text-[11px] text-ink outline-none"
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
                    aria-label={t("attachmentLabel")}
                    className="min-w-0 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-mute"
                    placeholder={t("attachmentLabel")}
                    value={attachment.label}
                    onChange={(event) =>
                      updateAttachment(index, { label: event.target.value })
                    }
                  />
                  <input
                    aria-label={t("attachmentValue")}
                    className="min-w-0 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-mute"
                    placeholder={t("attachmentValue")}
                    value={attachment.value}
                    onChange={(event) =>
                      updateAttachment(index, { value: event.target.value })
                    }
                  />
                  <button
                    className="rounded-md px-2 font-mono text-[11px] text-mute hover:bg-ivory hover:text-amber"
                    type="button"
                    onClick={() => removeAttachment(index)}
                  >
                    {t("remove")}
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <CapabilityComposer
            agent={composerAgent}
            ariaLabel={t("prompt")}
            catalog={capabilityCatalog}
            className="min-h-[180px] flex-1 text-[20px] leading-[1.45] text-ink"
            labels={{
              placeholder: t("promptPlaceholder"),
              unsupportedBadge: t("composerUnsupported"),
            }}
            testId="scratch-composer"
            value={prompt}
            onChange={setPrompt}
            onSubmitShortcut={() => {
              if (canSubmit) formRef.current?.requestSubmit();
            }}
          />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <label className="relative inline-flex h-9 min-w-[134px] max-w-[260px] items-center gap-2 rounded-full border border-line bg-ivory px-3 text-[13px] font-semibold text-ink shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset] transition hover:bg-paper">
                {selectedRunner ? (
                  <AgentMark agent={selectedRunner.capabilityAgent} />
                ) : null}
                <span className="min-w-0 truncate">
                  {selectedRunner?.displayLabel ?? t("runner")}
                </span>
                <span aria-hidden="true" className="text-mute">
                  v
                </span>
                <select
                  aria-label={t("runner")}
                  className={invisibleSelect}
                  value={runnerId}
                  onChange={(event) => setRunnerId(event.target.value)}
                >
                  {options?.runners.map((runner) => (
                    <option
                      key={runner.id}
                      disabled={!runner.enabled || !runner.ready}
                      value={runner.id}
                    >
                      {runner.displayLabel}
                      {runner.ready ? "" : " / NotReady"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="relative inline-flex h-9 min-w-[120px] items-center justify-center rounded-full border border-line bg-ivory px-3 font-mono text-[12px] font-semibold text-mute shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset] transition hover:bg-paper">
                <span className="truncate">{workMode}</span>
                <select
                  aria-label={t("workMode")}
                  className={invisibleSelect}
                  value={workMode}
                  onChange={(event) =>
                    setWorkMode(event.target.value as WorkMode)
                  }
                >
                  {options?.workModes.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {mode.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                multiple
                aria-label={t("files")}
                className="sr-only"
                type="file"
                onChange={(event) =>
                  setFiles(Array.from(event.currentTarget.files ?? []))
                }
              />
              <button
                aria-label={t("attachment")}
                className={iconButton}
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                <PaperclipIcon />
              </button>
              <button
                aria-label={t("linkedIssue")}
                className={iconButton}
                type="button"
                onClick={() =>
                  setLinkedIssueUrl((current) =>
                    current.trim() ? current : "https://",
                  )
                }
              >
                #
              </button>
              <button
                aria-label={t("attachmentKind.text_note")}
                className={iconButton}
                type="button"
                onClick={() => addAttachment("text_note")}
              >
                +
              </button>
              <label className="relative inline-flex h-9 min-w-[84px] items-center justify-center rounded-full border border-line bg-ivory px-3 font-mono text-[13px] font-semibold text-ink shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset] transition hover:bg-paper">
                <span>{reasoningEffort}</span>
                <select
                  aria-label={t("reasoningEffort")}
                  className={invisibleSelect}
                  value={reasoningEffort}
                  onChange={(event) =>
                    setReasoningEffort(event.target.value as ReasoningEffort)
                  }
                >
                  {options?.reasoningEfforts.map((effort) => (
                    <option key={effort.id} value={effort.id}>
                      {effort.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                aria-label={t("launch")}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-amber text-white shadow-[0_8px_24px_-10px_var(--amber)] transition-[transform,background] hover:-translate-y-px hover:bg-amber-2 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!canSubmit}
                type="submit"
              >
                <ArrowUpIcon />
              </button>
            </div>
          </div>
        </div>

        <div
          className={clsx(
            commandBand,
            "flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3",
          )}
        >
          <span className={contextPill}>
            <MachineIcon />
            <span>{options?.machine.label ?? t("localMachine")}</span>
          </span>
          <label className={clsx(contextPill, "relative")}>
            <ProjectIcon />
            <span className="min-w-0 truncate">
              {selectedProject?.name ?? t("project")}
            </span>
            <span aria-hidden="true">v</span>
            <select
              aria-label={t("project")}
              className={invisibleSelect}
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
          <label className={clsx(contextPill, "relative")}>
            <BranchIcon />
            <span className="min-w-0 truncate">{baseBranch}</span>
            <span aria-hidden="true">v</span>
            <select
              aria-label={t("baseBranch")}
              className={invisibleSelect}
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
          <span className={contextPill}>
            <span className="font-mono text-[13px]">o</span>
            <span>{capabilityCount}</span>
          </span>
          {contextCount > 0 ? (
            <span className={contextPill}>
              <PaperclipIcon />
              <span>{contextCount}</span>
            </span>
          ) : null}
        </div>
      </section>

      <details className={detailShell}>
        <summary className={summaryButton}>
          <span>{t("capabilities")}</span>
          <span className="rounded-full bg-paper px-2 py-0.5 text-[10px] text-mute">
            {capabilityCount} · {t("capabilitiesHint")}
          </span>
        </summary>
        <div className="grid gap-2 border-t border-line-soft p-3 md:grid-cols-2 xl:grid-cols-5">
          <CapabilityGroup
            label={t("mcps")}
            options={options?.capabilities.mcps ?? []}
            selectedIds={mcpIds}
            onToggle={(id) => setMcpIds((current) => toggleId(current, id))}
          />
          <CapabilityGroup
            readOnly
            label={t("skills")}
            note={t("skillsAllIncluded")}
            options={options?.capabilities.skills ?? []}
          />
          <CapabilityGroup
            label={t("rules")}
            options={options?.capabilities.rules ?? []}
            selectedIds={ruleIds}
            onToggle={(id) => setRuleIds((current) => toggleId(current, id))}
          />
          <CapabilityGroup
            label={t("agentPacks")}
            options={options?.capabilities.agentDefinitions ?? []}
            selectedIds={agentDefinitionIds}
            onToggle={(id) =>
              setAgentDefinitionIds((current) => toggleId(current, id))
            }
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
      </details>

      {launchStage ? (
        <div
          aria-live="polite"
          className="flex items-center justify-between gap-3 rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink-2"
          role="status"
        >
          <span>
            {
              {
                precondition: t("launchStage.precondition"),
                worktree_created: t("launchStage.worktree_created"),
                materializing: t("launchStage.materializing"),
                spawning: t("launchStage.spawning"),
                session_ready: t("launchStage.session_ready"),
              }[launchStage]
            }
          </span>
          <button
            className="rounded-full border border-line bg-ivory px-3 py-1 text-[11px] font-semibold text-mute transition hover:border-amber hover:text-amber"
            type="button"
            onClick={() => launchAbortRef.current?.abort()}
          >
            {t("cancel")}
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-[#d9534f]/40 bg-[#d9534f]/10 px-3 py-2 text-[12px] leading-[1.5] text-[#d9534f]">
          {error}
        </div>
      ) : null}
    </form>
  );
}
