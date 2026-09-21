"use client";

import type {
  McpAgent,
  McpServerDraft,
  McpTransport,
} from "@/lib/mcp/mcp-form";
import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import {
  MCP_AGENTS,
  MCP_TRANSPORTS,
  buildCreateBody,
  buildMcpServerFields,
  validateMcpServerDraft,
} from "@/lib/mcp/mcp-form";
import { secretShapedKey } from "@/lib/mcp/value-grammar";
import {
  KeyValueRows,
  recordFromRows,
  rowsFromRecord,
  type KeyValueRow,
} from "@/components/settings/key-value-rows";

export interface McpServerRow {
  id: string;
  description: string | null;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  bearerTokenEnv: string | null;
  supportedAgents: McpAgent[];
  trustStatus: string;
  readinessStatus: string;
  readinessReasons?: string[];
  enabled: boolean;
  usedByCount?: number;
}

export interface McpServerModalProps {
  mode: "create" | "edit";
  server?: McpServerRow;
  onClose: () => void;
  onSaved: () => void;
}

type FormState = {
  id: string;
  description: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  envRows: KeyValueRow[];
  url: string;
  headerRows: KeyValueRow[];
  bearerTokenEnv: string;
  supportedAgents: McpAgent[];
  enabled: boolean;
};

const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

// Tokenize a free-text list (comma / whitespace / newline separated).
function tokens(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function seedForm(mode: "create" | "edit", server?: McpServerRow): FormState {
  if (mode === "edit" && server) {
    return {
      id: server.id,
      description: server.description ?? "",
      transport: server.transport,
      command: server.command ?? "",
      argsText: server.args.join(" "),
      envRows: rowsFromRecord(server.env),
      url: server.url ?? "",
      headerRows: rowsFromRecord(server.headers),
      bearerTokenEnv: server.bearerTokenEnv ?? "",
      supportedAgents: [...server.supportedAgents],
      enabled: server.enabled,
    };
  }

  return {
    id: "",
    description: "",
    transport: "stdio",
    command: "",
    argsText: "",
    envRows: [],
    url: "",
    headerRows: [],
    bearerTokenEnv: "",
    supportedAgents: [...MCP_AGENTS],
    enabled: true,
  };
}

function toDraft(form: FormState): McpServerDraft {
  return {
    id: form.id,
    description: form.description || null,
    transport: form.transport,
    command: form.command || null,
    args: tokens(form.argsText),
    env: recordFromRows(form.envRows),
    url: form.url || null,
    headers: recordFromRows(form.headerRows),
    bearerTokenEnv: form.bearerTokenEnv || null,
    supportedAgents: form.supportedAgents,
    enabled: form.enabled,
  };
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

export function McpServerModal({
  mode,
  server,
  onClose,
  onSaved,
}: McpServerModalProps): ReactElement {
  const t = useTranslations("settings");
  const [form, setForm] = useState<FormState>(() => seedForm(mode, server));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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

  const draft = toDraft(form);
  const validation = validateMcpServerDraft(draft);
  const isStdio = form.transport === "stdio";
  const errorsByField = new Map(
    validation.ok ? [] : validation.errors.map((e) => [e.field, e.message]),
  );
  const bearerError = errorsByField.get("bearerTokenEnv") ?? null;
  // A required `sse` ref on a codex runner refuses the launch outright, and an
  // additional one is withheld — surface that at CREATE time rather than at the
  // launch that fails (ADR-177).
  const sseOnCodex =
    form.transport === "sse" && form.supportedAgents.includes("codex");

  function rowError(kind: "env" | "headers", row: KeyValueRow): string | null {
    if (row.key.trim() === "" && row.value === "") return null;

    return (
      errorsByField.get(`${kind}.${row.key.trim()}`) ??
      (row.key.trim() === "" ? (errorsByField.get(`${kind}.`) ?? null) : null)
    );
  }

  // D9: the secret guard is a WARNING, never a refusal — the route accepts the
  // value. It fires only for a LITERAL, since a reference carries no secret.
  function rowWarning(
    kind: "env" | "headers",
    row: KeyValueRow,
  ): string | null {
    const key = row.key.trim();

    if (key === "" || row.value.startsWith("env:")) return null;

    return secretShapedKey(kind === "env" ? "env" : "header", key)
      ? t("secretShapedWarning")
      : null;
  }

  function patchForm(patch: Partial<FormState>): void {
    setForm((current) => ({ ...current, ...patch }));
  }

  function toggleAgent(agent: McpAgent): void {
    setForm((current) => {
      const has = current.supportedAgents.includes(agent);

      return {
        ...current,
        supportedAgents: has
          ? current.supportedAgents.filter((a) => a !== agent)
          : [...current.supportedAgents, agent],
      };
    });
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const result =
        mode === "create"
          ? await sendJson(
              "/api/admin/mcp-servers",
              "POST",
              buildCreateBody(draft),
            )
          : await sendJson(
              `/api/admin/mcp-servers/${server?.id ?? ""}`,
              "PATCH",
              buildMcpServerFields(draft),
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
      const res = await fetch(`/api/admin/mcp-servers/${server?.id ?? ""}`, {
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
        aria-labelledby="mcp-server-modal-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2
            className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
            id="mcp-server-modal-title"
          >
            {mode === "create" ? t("createMcpTitle") : t("editMcpTitle")}
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
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldMcpId")}</span>
            {mode === "create" ? (
              <input
                autoComplete="off"
                className={inputClass}
                disabled={busy}
                spellCheck={false}
                type="text"
                value={form.id}
                onChange={(e) => patchForm({ id: e.target.value })}
              />
            ) : (
              <code className="font-mono text-[12px] text-ink">{form.id}</code>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldDescription")}</span>
            <input
              autoComplete="off"
              className={inputClass}
              disabled={busy}
              spellCheck={false}
              type="text"
              value={form.description}
              onChange={(e) => patchForm({ description: e.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldTransport")}</span>
            <select
              className={inputClass}
              disabled={busy}
              value={form.transport}
              onChange={(e) =>
                patchForm({ transport: e.target.value as McpTransport })
              }
            >
              {MCP_TRANSPORTS.map((transport) => (
                <option key={transport} value={transport}>
                  {transport === "sse" ? t("transportSseLegacy") : transport}
                </option>
              ))}
            </select>
            {sseOnCodex ? (
              <span className="font-mono text-[10px] text-amber" role="note">
                {t("sseCodexNotice")}
              </span>
            ) : null}
          </label>

          {isStdio ? (
            <>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("fieldCommand")}</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  spellCheck={false}
                  type="text"
                  value={form.command}
                  onChange={(e) => patchForm({ command: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("fieldArgs")}</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  spellCheck={false}
                  type="text"
                  value={form.argsText}
                  onChange={(e) => patchForm({ argsText: e.target.value })}
                />
              </label>
              <KeyValueRows
                disabled={busy}
                errorFor={(row) => rowError("env", row)}
                labels={{
                  title: t("fieldEnv"),
                  hint: t("valueGrammarHint"),
                  key: t("fieldEnvKey"),
                  value: t("fieldEnvValue"),
                  add: t("addEnv"),
                  remove: t("removeEnv"),
                }}
                rows={form.envRows}
                testId="mcp-env-rows"
                warningFor={(row) => rowWarning("env", row)}
                onChange={(envRows) => patchForm({ envRows })}
              />
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("fieldUrl")}</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  spellCheck={false}
                  type="text"
                  value={form.url}
                  onChange={(e) => patchForm({ url: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("fieldBearerTokenEnv")}</span>
                <input
                  aria-invalid={bearerError ? true : undefined}
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  placeholder="env:MCP_TOKEN"
                  spellCheck={false}
                  type="text"
                  value={form.bearerTokenEnv}
                  onChange={(e) =>
                    patchForm({ bearerTokenEnv: e.target.value })
                  }
                />
                {bearerError ? (
                  <span className="font-mono text-[10px] text-rose-400">
                    {bearerError}
                  </span>
                ) : (
                  <span className="font-mono text-[10px] text-mute">
                    {t("bearerTokenEnvHint")}
                  </span>
                )}
              </label>
              <KeyValueRows
                disabled={busy}
                errorFor={(row) => rowError("headers", row)}
                labels={{
                  title: t("fieldHeaders"),
                  hint: t("valueGrammarHint"),
                  key: t("fieldHeaderName"),
                  value: t("fieldHeaderValue"),
                  add: t("addHeader"),
                  remove: t("removeHeader"),
                }}
                rows={form.headerRows}
                testId="mcp-header-rows"
                warningFor={(row) => rowWarning("headers", row)}
                onChange={(headerRows) => patchForm({ headerRows })}
              />
            </>
          )}

          <fieldset className="flex flex-col gap-1.5 border-0 p-0">
            <span className={fieldLabel}>{t("fieldSupportedAgents")}</span>
            <div className="flex gap-4">
              {MCP_AGENTS.map((agent) => (
                <label
                  key={agent}
                  className="flex items-center gap-2 text-[12px] text-mute"
                >
                  <input
                    checked={form.supportedAgents.includes(agent)}
                    disabled={busy}
                    type="checkbox"
                    onChange={() => toggleAgent(agent)}
                  />
                  {agent}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex items-center gap-2 text-[12px] text-mute">
            <input
              checked={form.enabled}
              disabled={busy}
              type="checkbox"
              onChange={(e) => patchForm({ enabled: e.target.checked })}
            />
            {t("fieldEnabled")}
          </label>

          {!validation.ok && validation.errors.length > 0 ? (
            <ul className="m-0 list-none p-0 font-mono text-[10.5px] text-[#b5332b]">
              {validation.errors.map((err) => (
                <li key={`${err.field}:${err.message}`}>{err.message}</li>
              ))}
            </ul>
          ) : null}

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
                type="button"
                onClick={() => void remove()}
              >
                {confirmingDelete ? t("deleteMcpConfirm") : t("deleteMcp")}
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
                (busy || !validation.ok) && "opacity-60",
              )}
              disabled={busy || !validation.ok}
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
