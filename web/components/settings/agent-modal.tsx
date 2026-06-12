"use client";

import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

export type AgentSummaryRow = {
  id: string;
  scope: "platform" | "project";
  projectId: string | null;
  name: string;
  description: string;
  runnerId: string | null;
  workspace: "none" | "repo_read" | "worktree";
  mode: "session" | "subagent";
  triggers: string[];
  riskTier: "read_only" | "standard" | "destructive";
  sourcePath: string;
  enabled: boolean;
  quarantinedAt: string | null;
  quarantineReason: string | null;
};

const TRIGGER_KINDS = [
  "manual",
  "cron",
  "domain_event",
  "webhook",
  "flow",
] as const;

type DefinitionBody = {
  id: string;
  name: string;
  description: string;
  scope: "platform" | "project";
  project?: string;
  runner?: string | null;
  workspace: "none" | "repo_read" | "worktree";
  mode: "session" | "subagent";
  triggers: string[];
  riskTier: "read_only" | "standard" | "destructive";
  prompt: string;
};

async function sendJson(
  url: string,
  method: string,
  body?: unknown,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";
const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

export interface AgentModalProps {
  editingId: string | null;
  runners: Array<{ id: string }>;
  projects: Array<{ id: string; slug: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}

// M34 (ADR-089 D11): one create|edit modal writing the `.md` definition into
// the host catalog through the admin CRUD routes; the modal also owns delete
// (usage-guarded server-side — refused while live runs exist).
export function AgentModal({
  editingId,
  runners,
  projects,
  onClose,
  onSaved,
}: AgentModalProps): ReactElement {
  const t = useTranslations("agents");
  const isEdit = editingId !== null;

  const [loading, setLoading] = useState(isEdit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [id, setId] = useState(editingId ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"platform" | "project">("platform");
  const [projectSlug, setProjectSlug] = useState(projects[0]?.slug ?? "");
  const [runner, setRunner] = useState("");
  const [workspace, setWorkspace] = useState<"none" | "repo_read" | "worktree">(
    "none",
  );
  const [mode, setMode] = useState<"session" | "subagent">("session");
  const [triggers, setTriggers] = useState<string[]>(["manual"]);
  const [riskTier, setRiskTier] = useState<
    "read_only" | "standard" | "destructive"
  >("read_only");
  const [prompt, setPrompt] = useState("");

  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isEdit || editingId === null) return;

    const controller = new AbortController();

    fetch(`/api/admin/agents/${editingId}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));

        return (await res.json()) as {
          agent: AgentSummaryRow;
          prompt: string;
        };
      })
      .then(({ agent, prompt: loadedPrompt }) => {
        setName(agent.name);
        setDescription(agent.description);
        setScope(agent.scope);
        setRunner(agent.runnerId ?? "");
        setWorkspace(agent.workspace);
        setMode(agent.mode);
        setTriggers(agent.triggers);
        setRiskTier(agent.riskTier);
        setPrompt(loadedPrompt);

        const project = projects.find((p) => p.id === agent.projectId);

        if (project) setProjectSlug(project.slug);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(t("loadError"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [editingId, isEdit]);

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

  function toggleTrigger(kind: string): void {
    setTriggers((current) =>
      current.includes(kind)
        ? current.filter((k) => k !== kind)
        : [...current, kind],
    );
  }

  const valid =
    id.trim() !== "" &&
    /^[A-Za-z0-9._-]+$/.test(id.trim()) &&
    name.trim() !== "" &&
    description.trim() !== "" &&
    prompt.trim() !== "" &&
    triggers.length > 0 &&
    (scope === "platform" || projectSlug !== "");

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);

    const definition: DefinitionBody = {
      id: id.trim(),
      name: name.trim(),
      description: description.trim(),
      scope,
      ...(scope === "project" ? { project: projectSlug } : {}),
      runner: runner === "" ? null : runner,
      workspace,
      mode,
      triggers,
      riskTier,
      prompt,
    };

    try {
      const result = isEdit
        ? await sendJson(`/api/admin/agents/${editingId}`, "PATCH", {
            definition,
          })
        : await sendJson("/api/admin/agents", "POST", definition);

      if (!result.ok) {
        setError(result.message ?? "Request failed");

        return;
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (editingId === null) return;

    setBusy(true);
    setError(null);

    try {
      const result = await sendJson(`/api/admin/agents/${editingId}`, "DELETE");

      if (!result.ok) {
        setError(
          result.code === "PRECONDITION"
            ? t("deleteBlocked")
            : (result.message ?? "Request failed"),
        );

        return;
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={t("cancel")}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="agent-modal-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[640px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2
            className="m-0 text-[15px] font-semibold text-ink"
            id="agent-modal-title"
          >
            {isEdit ? `${t("editTitle")} — ${editingId}` : t("createTitle")}
          </h2>
          <button
            aria-label={t("cancel")}
            className="rounded-md border border-line px-2 py-1 text-[12px] text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-3.5 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="m-0 text-[12px] text-mute">{t("loading")}</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>{t("fieldId")}</span>
                  <input
                    className={inputClass}
                    disabled={isEdit}
                    value={id}
                    onChange={(event) => setId(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>{t("fieldName")}</span>
                  <input
                    className={inputClass}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("fieldDescription")}</span>
                <input
                  className={inputClass}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>{t("fieldScope")}</span>
                  <select
                    className={inputClass}
                    value={scope}
                    onChange={(event) =>
                      setScope(event.target.value as "platform" | "project")
                    }
                  >
                    <option value="platform">platform</option>
                    <option value="project">project</option>
                  </select>
                </label>
                {scope === "project" ? (
                  <label className="flex flex-col gap-1.5">
                    <span className={fieldLabel}>{t("fieldProject")}</span>
                    <select
                      className={inputClass}
                      value={projectSlug}
                      onChange={(event) => setProjectSlug(event.target.value)}
                    >
                      {projects.map((project) => (
                        <option key={project.id} value={project.slug}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="flex flex-col gap-1.5">
                    <span className={fieldLabel}>{t("fieldRunner")}</span>
                    <select
                      className={inputClass}
                      value={runner}
                      onChange={(event) => setRunner(event.target.value)}
                    >
                      <option value="">{t("runnerInherit")}</option>
                      {runners.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.id}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {scope === "project" ? (
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>{t("fieldRunner")}</span>
                  <select
                    className={inputClass}
                    value={runner}
                    onChange={(event) => setRunner(event.target.value)}
                  >
                    <option value="">{t("runnerInherit")}</option>
                    {runners.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>{t("fieldWorkspace")}</span>
                  <select
                    className={inputClass}
                    value={workspace}
                    onChange={(event) =>
                      setWorkspace(
                        event.target.value as "none" | "repo_read" | "worktree",
                      )
                    }
                  >
                    <option value="none">none</option>
                    <option value="repo_read">repo_read</option>
                    <option value="worktree">worktree</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>{t("fieldMode")}</span>
                  <select
                    className={inputClass}
                    value={mode}
                    onChange={(event) =>
                      setMode(event.target.value as "session" | "subagent")
                    }
                  >
                    <option value="session">session</option>
                    <option value="subagent">subagent</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>{t("fieldRisk")}</span>
                  <select
                    className={inputClass}
                    value={riskTier}
                    onChange={(event) =>
                      setRiskTier(
                        event.target.value as
                          | "read_only"
                          | "standard"
                          | "destructive",
                      )
                    }
                  >
                    <option value="read_only">read_only</option>
                    <option value="standard">standard</option>
                    <option value="destructive">destructive</option>
                  </select>
                </label>
              </div>
              <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
                <legend className={fieldLabel}>{t("fieldTriggers")}</legend>
                <div className="flex flex-wrap gap-3">
                  {TRIGGER_KINDS.map((kind) => (
                    <label
                      key={kind}
                      className="inline-flex items-center gap-1.5 font-mono text-[12px] text-ink"
                    >
                      <input
                        checked={triggers.includes(kind)}
                        type="checkbox"
                        onChange={() => toggleTrigger(kind)}
                      />
                      {kind}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("fieldPrompt")}</span>
                <textarea
                  className={`${inputClass} min-h-[140px] resize-y py-2`}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>
              {error ? (
                <p
                  aria-live="polite"
                  className="m-0 text-[12px] leading-[1.45] text-red-700"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
            </>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-line px-5 py-4">
          {isEdit ? (
            <button
              className="h-9 rounded-[8px] border border-red-500/40 px-3 text-[12px] font-semibold text-red-700 disabled:opacity-50"
              disabled={busy || loading}
              type="button"
              onClick={() => void remove()}
            >
              {t("delete")}
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              className="h-9 rounded-[8px] border border-line px-4 text-[13px] font-semibold text-ink"
              type="button"
              onClick={onClose}
            >
              {t("cancel")}
            </button>
            <button
              className="h-9 rounded-[8px] border border-amber bg-amber px-4 text-[13px] font-semibold text-white disabled:opacity-50"
              disabled={busy || loading || !valid}
              type="button"
              onClick={() => void save()}
            >
              {t("save")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
