"use client";

import type { McpBindingView } from "@/components/board/panels/mcp-panel";
import type { ReactElement, ReactNode } from "react";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { useModalFocusTrap } from "@/components/board/panels/use-modal-focus-trap";

// ADR-129 (W-D, T6.2): the write dialogs over the bindings/overlay routes.
// MatchDialog binds a requirement ref to a candidate server (platform/project/
// package); OverlayDialog edits a binding's per-project config overlay (NAMES
// only — env:NAME references, never a raw secret value). Both mirror the sibling
// `ProjectMcpModal` inline-fixed modal frame (this board tab is not a
// hover-transformed surface, so no portal is needed — matching the sibling that
// already works here).

export type MatchCandidate = {
  targetKind: "platform" | "project" | "package";
  targetId: string;
  transport: string;
  trust?: string;
};

type ApiResult = { ok: boolean; message?: string };

async function sendJson(
  url: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<ApiResult> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.ok) return { ok: true };

  const payload = (await res.json().catch(() => null)) as {
    code?: string;
    message?: string;
  } | null;

  return {
    ok: false,
    message:
      payload?.message ?? payload?.code ?? `Request failed: ${res.status}`,
  };
}

const inputClass =
  "min-h-[34px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";
const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

// Shared inline-fixed modal frame: overlay + focus-trap + Escape + scroll-lock,
// mirroring ProjectMcpModal (kept local — surgical, not a refactor of that file).
function ModalFrame({
  titleId,
  title,
  closeLabel,
  onClose,
  children,
  footer,
}: {
  titleId: string;
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);

  useModalFocusTrap(dialogRef, onClose);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={closeLabel}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[520px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2
            className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
            id={titleId}
          >
            {title}
          </h2>
          <button
            aria-label={closeLabel}
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5">
          {children}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          {footer}
        </div>
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }): ReactElement {
  return (
    <div
      aria-live="assertive"
      className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
      role="alert"
    >
      {message}
    </div>
  );
}

export function MatchDialog({
  slug,
  refId,
  candidates,
  recommendedTargetId,
  onClose,
  onDone,
}: {
  slug: string;
  refId: string;
  candidates: MatchCandidate[];
  recommendedTargetId?: string;
  onClose: () => void;
  onDone: () => void;
}): ReactElement {
  const t = useTranslations("mcpPanel");
  const initial =
    candidates.find((c) => c.targetId === recommendedTargetId) ?? candidates[0];
  const [picked, setPicked] = useState<string>(
    initial ? `${initial.targetKind}:${initial.targetId}` : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function bind(): Promise<void> {
    const chosen = candidates.find(
      (c) => `${c.targetKind}:${c.targetId}` === picked,
    );

    if (!chosen) return;
    setBusy(true);
    setError(null);

    const result = await sendJson(
      `/api/projects/${encodeURIComponent(slug)}/mcp/bindings`,
      "POST",
      { refId, targetKind: chosen.targetKind, targetId: chosen.targetId },
    );

    setBusy(false);

    if (!result.ok) {
      setError(`${t("actionFailed")}: ${result.message ?? ""}`);

      return;
    }

    onDone();
    onClose();
  }

  const trustWarn = (trust?: string): boolean =>
    trust !== undefined && trust !== "trusted" && trust !== "trusted_by_policy";

  return (
    <ModalFrame
      closeLabel={t("close")}
      footer={
        <>
          <button
            className="rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold text-mute hover:border-mute hover:text-ink-2"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            className={clsx(
              "rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold text-white hover:bg-amber-2",
              (busy || picked === "") && "opacity-60",
            )}
            data-testid="mcp-match-confirm"
            disabled={busy || picked === ""}
            type="button"
            onClick={() => void bind()}
          >
            {busy ? t("saving") : t("bind")}
          </button>
        </>
      }
      title={t("matchTitle", { ref: refId })}
      titleId="mcp-match-title"
      onClose={onClose}
    >
      <p className="m-0 font-mono text-[11px] leading-relaxed text-mute">
        {t("matchIntro")}
      </p>
      {candidates.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line bg-ivory px-3 py-4 font-mono text-[11px] text-mute">
          {t("matchNoCandidates")}
        </p>
      ) : (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          {candidates.map((candidate) => {
            const value = `${candidate.targetKind}:${candidate.targetId}`;

            return (
              <label
                key={value}
                className="flex items-center gap-3 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] text-ink"
                data-testid={`mcp-match-candidate-${candidate.targetKind}`}
              >
                <input
                  checked={picked === value}
                  name="mcp-match-candidate"
                  type="radio"
                  value={value}
                  onChange={() => setPicked(value)}
                />
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">
                    {candidate.targetKind === "platform"
                      ? t("sourcePlatform")
                      : candidate.targetKind === "project"
                        ? t("sourceProject")
                        : t("sourcePackage")}
                  </span>
                  <span className="font-mono text-[11px] text-mute">
                    {candidate.transport}
                  </span>
                  {trustWarn(candidate.trust) ? (
                    <span className="rounded-full border border-amber/50 px-1.5 py-0.5 text-[9.5px] font-semibold text-amber-2">
                      {t("matchUntrustedWarn")}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      {error ? <ErrorBanner message={error} /> : null}
    </ModalFrame>
  );
}

type RemapRow = { slot: string; value: string };

function toRows(map?: Record<string, string>): RemapRow[] {
  return Object.entries(map ?? {}).map(([slot, value]) => ({ slot, value }));
}

function fromRows(rows: RemapRow[]): Record<string, string> | undefined {
  const entries = rows
    .map((row) => [row.slot.trim(), row.value.trim()] as const)
    .filter(([slot, value]) => slot.length > 0 && value.length > 0);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function tokens(text: string): string[] {
  return text
    .split(/[\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function OverlayDialog({
  slug,
  binding,
  slots,
  onClose,
  onDone,
}: {
  slug: string;
  binding: McpBindingView;
  slots?: { env: string[]; header: string[] };
  onClose: () => void;
  onDone: () => void;
}): ReactElement {
  const t = useTranslations("mcpPanel");
  const overlay = binding.configOverlay ?? {};
  const [envRows, setEnvRows] = useState<RemapRow[]>(() =>
    toRows(overlay.envRemap),
  );
  const [headerRows, setHeaderRows] = useState<RemapRow[]>(() =>
    toRows(overlay.headerRemap),
  );
  const [argsText, setArgsText] = useState(
    (overlay.argsOverride ?? []).join(" "),
  );
  const [urlOverride, setUrlOverride] = useState(overlay.urlOverride ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasSlots =
    (slots?.env.length ?? 0) > 0 || (slots?.header.length ?? 0) > 0;

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);

    const args = tokens(argsText);
    const url = urlOverride.trim();
    // Sparse overlay: omit every empty field (skill-context: sparse payloads).
    const configOverlay = {
      ...(fromRows(envRows) ? { envRemap: fromRows(envRows) } : {}),
      ...(fromRows(headerRows) ? { headerRemap: fromRows(headerRows) } : {}),
      ...(args.length > 0 ? { argsOverride: args } : {}),
      ...(url.length > 0 ? { urlOverride: url } : {}),
    };

    const result = await sendJson(
      `/api/projects/${encodeURIComponent(slug)}/mcp/bindings/${encodeURIComponent(binding.refId)}`,
      "PATCH",
      { configOverlay },
    );

    setBusy(false);

    if (!result.ok) {
      setError(`${t("actionFailed")}: ${result.message ?? ""}`);

      return;
    }

    onDone();
    onClose();
  }

  const remapEditor = (
    rows: RemapRow[],
    setRows: (next: RemapRow[]) => void,
    slotHints: string[],
    listId: string,
  ): ReactElement => (
    <div className="flex flex-col gap-1.5">
      {slotHints.length > 0 ? (
        <datalist id={listId}>
          {slotHints.map((slot) => (
            <option key={slot} value={slot} />
          ))}
        </datalist>
      ) : null}
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            aria-label={t("overlaySlotPlaceholder")}
            className={`${inputClass} flex-1`}
            disabled={busy}
            list={slotHints.length > 0 ? listId : undefined}
            placeholder={t("overlaySlotPlaceholder")}
            spellCheck={false}
            value={row.slot}
            onChange={(e) =>
              setRows(
                rows.map((r, i) =>
                  i === index ? { ...r, slot: e.target.value } : r,
                ),
              )
            }
          />
          <input
            aria-label={t("overlayValuePlaceholder")}
            className={`${inputClass} flex-1`}
            disabled={busy}
            placeholder={t("overlayValuePlaceholder")}
            spellCheck={false}
            value={row.value}
            onChange={(e) =>
              setRows(
                rows.map((r, i) =>
                  i === index ? { ...r, value: e.target.value } : r,
                ),
              )
            }
          />
          <button
            aria-label={t("delete")}
            className="text-mute hover:text-danger"
            disabled={busy}
            type="button"
            onClick={() => setRows(rows.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="self-start rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10.5px] text-ink-2 hover:border-amber hover:text-ink"
        disabled={busy}
        type="button"
        onClick={() => setRows([...rows, { slot: "", value: "" }])}
      >
        {t("overlayAddRow")}
      </button>
    </div>
  );

  const isHttp =
    binding.targetKind === "platform" || binding.targetKind === "package";

  return (
    <ModalFrame
      closeLabel={t("close")}
      footer={
        <>
          <button
            className="rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold text-mute hover:border-mute hover:text-ink-2"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            className={clsx(
              "rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold text-white hover:bg-amber-2",
              busy && "opacity-60",
            )}
            data-testid="mcp-overlay-save"
            disabled={busy}
            type="button"
            onClick={() => void save()}
          >
            {busy ? t("saving") : t("save")}
          </button>
        </>
      }
      title={t("overlayTitle", { ref: binding.refId })}
      titleId="mcp-overlay-title"
      onClose={onClose}
    >
      <p className="m-0 font-mono text-[11px] leading-relaxed text-mute">
        {t("overlayIntro")}
      </p>
      {!hasSlots && slots ? (
        <p className="font-mono text-[10.5px] text-mute">
          {t("overlayNoSlots")}
        </p>
      ) : null}
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>{t("overlayEnvRemap")}</span>
        {remapEditor(
          envRows,
          setEnvRows,
          slots?.env ?? [],
          "mcp-overlay-env-slots",
        )}
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>{t("overlayHeaderRemap")}</span>
        {remapEditor(
          headerRows,
          setHeaderRows,
          slots?.header ?? [],
          "mcp-overlay-header-slots",
        )}
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>{t("overlayArgs")}</span>
        <input
          className={inputClass}
          disabled={busy}
          spellCheck={false}
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
        />
      </label>
      {isHttp ? (
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t("overlayUrl")}</span>
          <input
            className={inputClass}
            disabled={busy}
            placeholder="https://…"
            spellCheck={false}
            value={urlOverride}
            onChange={(e) => setUrlOverride(e.target.value)}
          />
        </label>
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
    </ModalFrame>
  );
}
