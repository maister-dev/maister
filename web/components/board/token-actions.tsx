"use client";

import type { TokenLabels } from "@/components/board/panels/integrations-panel";
import type { ReactElement, ReactNode } from "react";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { TOKEN_SCOPE_VALUES, type TokenScope } from "@/types/token-scopes";

const BTN_NEUTRAL =
  "rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2 disabled:opacity-50";
const BTN_PRIMARY =
  "rounded-lg border border-amber bg-amber px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-50";

type TokenKind = "project" | "user";

function useAction(): {
  busy: boolean;
  error: string | null;
  setError: (v: string | null) => void;
  run: (
    path: string,
    init: RequestInit,
  ) => Promise<{ ok: boolean; data: unknown }>;
} {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(
    path: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; data: unknown }> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(path, {
        headers: { "content-type": "application/json" },
        ...init,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        setError(body?.code ?? "CRASH");

        return { ok: false, data: null };
      }

      if (res.status === 204) {
        startTransition(() => router.refresh());

        return { ok: true, data: null };
      }

      const data = (await res.json().catch(() => null)) as unknown;

      return { ok: true, data };
    } catch {
      setError("EXECUTOR_UNAVAILABLE");

      return { ok: false, data: null };
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, setError, run };
}

function AccessibleModal({
  title,
  cancel,
  onClose,
  children,
  footer,
}: {
  title: string;
  cancel: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}): ReactElement {
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

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={cancel}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="token-modal-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[480px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2
            className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
            id="token-modal-title"
          >
            {title}
          </h2>
          <button
            aria-label={cancel}
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

function Field({
  label,
  value,
  type,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  type?: "text" | "datetime-local";
  placeholder?: string;
  onChange: (v: string) => void;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
        {label}
      </span>
      <input
        className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber"
        placeholder={placeholder}
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function KindField({
  label,
  labels,
  value,
  onChange,
}: {
  label: string;
  labels: TokenLabels;
  value: TokenKind;
  onChange: (v: TokenKind) => void;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
        {label}
      </span>
      <select
        className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber"
        value={value}
        onChange={(e) => onChange(e.target.value as TokenKind)}
      >
        <option value="project">{labels.kindProject}</option>
        <option value="user">{labels.kindUser}</option>
      </select>
    </label>
  );
}

function scopeText(labels: TokenLabels, scope: TokenScope): string {
  switch (scope) {
    case "*":
      return labels.scopeAll;
    case "tasks:create":
      return labels.scopeTasksCreate;
    case "tasks:read":
      return labels.scopeTasksRead;
    case "tasks:update":
      return labels.scopeTasksUpdate;
    case "runs:launch":
      return labels.scopeRunsLaunch;
    case "runs:read":
      return labels.scopeRunsRead;
    case "readiness:read":
      return labels.scopeReadinessRead;
    case "gates:report":
      return labels.scopeGatesReport;
    case "hitl:read":
      return labels.scopeHitlRead;
    case "hitl:respond":
      return labels.scopeHitlRespond;
    case "hitl:inbox:read":
      return labels.scopeHitlInboxRead;
    case "hitl:respond:human":
      return labels.scopeHitlRespondHuman;
    case "comments:read":
      return labels.scopeCommentsRead;
    case "comments:create":
      return labels.scopeCommentsCreate;
    case "tasks:triage":
      return labels.scopeTasksTriage;
    case "relations:read":
      return labels.scopeRelationsRead;
    case "relations:create":
      return labels.scopeRelationsCreate;
    case "relations:delete":
      return labels.scopeRelationsDelete;
    case "flows:read":
      return labels.scopeFlowsRead;
    case "runners:read":
      return labels.scopeRunnersRead;
    case "agents:trigger":
      return labels.scopeAgentsTrigger;
    case "runs:delegate":
      return labels.scopeRunsDelegate;
    case "runs:collect":
      return labels.scopeRunsCollect;
    case "runs:cancel":
      return labels.scopeRunsCancel;
    case "runs:promote":
      return labels.scopeRunsPromote;
  }
}

function toggleScope(scopes: TokenScope[], scope: TokenScope): TokenScope[] {
  if (scope === "*") return ["*"];

  const current = scopes.filter((s) => s !== "*");
  const next = current.includes(scope)
    ? current.filter((s) => s !== scope)
    : [...current, scope];

  return next.length > 0 ? next : ["*"];
}

function ScopeField({
  labels,
  value,
  onChange,
}: {
  labels: TokenLabels;
  value: TokenScope[];
  onChange: (v: TokenScope[]) => void;
}): ReactElement {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
        {labels.scopesLabel}
      </legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {TOKEN_SCOPE_VALUES.map((scope) => (
          <label
            key={scope}
            className="flex min-h-9 items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[11px] text-ink-2"
          >
            <input
              checked={value.includes(scope)}
              type="checkbox"
              onChange={() => onChange(toggleScope(value, scope))}
            />
            <span>{scopeText(labels, scope)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ErrorRow({ error }: { error: string | null }): ReactElement | null {
  if (!error) return null;

  return (
    <div
      aria-live="assertive"
      className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
      role="alert"
    >
      {error}
    </div>
  );
}

export interface TokenSecretRevealProps {
  secret: string;
  labels: TokenLabels;
}

export function TokenSecretReveal({
  secret,
  labels,
}: TokenSecretRevealProps): ReactElement {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied — the secret is still selectable in the code block.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        aria-live="assertive"
        className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
        role="alert"
      >
        {labels.secretWarning}
      </div>
      <code className="block break-all rounded-lg border border-line bg-ivory px-3 py-2.5 font-mono text-[12px] text-ink">
        {secret}
      </code>
      <button
        className="self-start rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2"
        type="button"
        onClick={() => void copy()}
      >
        {copied ? labels.copied : labels.copy}
      </button>
    </div>
  );
}

export function CreateTokenModal({
  slug,
  labels,
}: {
  slug: string;
  labels: TokenLabels;
}): ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TokenKind>("project");
  const [scopes, setScopes] = useState<TokenScope[]>(["*"]);
  const [expiresAt, setExpiresAt] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();

  function reset(): void {
    setName("");
    setKind("project");
    setScopes(["*"]);
    setExpiresAt("");
    setSecret(null);
    setError(null);
  }

  function close(): void {
    const hadSecret = secret !== null;

    setOpen(false);
    reset();

    if (hadSecret) router.refresh();
  }

  async function submit(): Promise<void> {
    const { ok, data } = await run(`/api/projects/${slug}/tokens`, {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        kind,
        scopes,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      }),
    });

    if (ok) {
      const token = (data as { token?: string } | null)?.token ?? null;

      setSecret(token);
    }
  }

  return (
    <>
      <button
        className={BTN_PRIMARY}
        type="button"
        onClick={() => setOpen(true)}
      >
        {labels.create}
      </button>
      {open ? (
        <AccessibleModal
          cancel={labels.cancel}
          footer={
            secret !== null ? (
              <button className={BTN_PRIMARY} type="button" onClick={close}>
                {labels.cancel}
              </button>
            ) : (
              <>
                <button className={BTN_NEUTRAL} type="button" onClick={close}>
                  {labels.cancel}
                </button>
                <button
                  className={BTN_PRIMARY}
                  disabled={busy || name.trim() === ""}
                  type="button"
                  onClick={() => void submit()}
                >
                  {labels.confirm}
                </button>
              </>
            )
          }
          title={secret !== null ? labels.secretTitle : labels.createTitle}
          onClose={close}
        >
          {secret !== null ? (
            <TokenSecretReveal labels={labels} secret={secret} />
          ) : (
            <>
              <Field
                label={labels.nameLabel}
                placeholder={labels.namePlaceholder}
                value={name}
                onChange={setName}
              />
              <KindField
                label={labels.kindLabel}
                labels={labels}
                value={kind}
                onChange={setKind}
              />
              <ScopeField labels={labels} value={scopes} onChange={setScopes} />
              <Field
                label={labels.expiresLabel}
                type="datetime-local"
                value={expiresAt}
                onChange={setExpiresAt}
              />
              <ErrorRow error={error ? labels.errorGeneric : null} />
            </>
          )}
        </AccessibleModal>
      ) : null}
    </>
  );
}

export function RevokeTokenButton({
  slug,
  tokenId,
  labels,
}: {
  slug: string;
  tokenId: string;
  labels: TokenLabels;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();

  async function revoke(): Promise<void> {
    const { ok } = await run(`/api/projects/${slug}/tokens/${tokenId}`, {
      method: "DELETE",
    });

    if (ok) setConfirming(false);
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-mute">
          {labels.revokeConfirm}
        </span>
        <button
          className={BTN_PRIMARY}
          disabled={busy}
          type="button"
          onClick={() => void revoke()}
        >
          {labels.revoke}
        </button>
        <button
          className={BTN_NEUTRAL}
          disabled={busy}
          type="button"
          onClick={() => setConfirming(false)}
        >
          {labels.cancel}
        </button>
        {error ? (
          <span className="font-mono text-[10px] font-bold uppercase text-amber">
            {labels.errorGeneric}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <button
      aria-label={labels.revoke}
      className={BTN_NEUTRAL}
      type="button"
      onClick={() => setConfirming(true)}
    >
      {labels.revoke}
    </button>
  );
}
