"use client";

import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import clsx from "clsx";

export interface PackageLabels {
  install: string;
  enable: string;
  disable: string;
  upgrade: string;
  rollback: string;
  remove: string;
  trust: string;
  review: string;
  cancel: string;
  confirm: string;
  sourceLabel: string;
  versionLabel: string;
  revisionLabel: string;
  flowRefLabel: string;
  installTitle: string;
  upgradeTitle: string;
  previewTitle: string;
  added: string;
  removed: string;
  errorGeneric: string;
}

export interface RevisionOption {
  id: string;
  versionLabel: string;
  resolvedRevision: string;
}

export interface PackageActionsProps {
  slug: string;
  flowRef: string;
  trusted: boolean;
  enablementState: string;
  availableUpdateRevisionId: string | null;
  rollbackTargets: RevisionOption[];
  labels: PackageLabels;
}

const BTN_NEUTRAL =
  "rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2 disabled:opacity-50";
const BTN_PRIMARY =
  "rounded-lg border border-amber bg-amber px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-50";

function useAction(): {
  busy: boolean;
  error: string | null;
  setError: (v: string | null) => void;
  run: (path: string, init: RequestInit) => Promise<boolean>;
} {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(path: string, init: RequestInit): Promise<boolean> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(path, {
        headers: { "content-type": "application/json" },
        ...init,
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        setError(data?.code ?? "CRASH");

        return false;
      }

      startTransition(() => router.refresh());

      return true;
    } catch {
      setError("EXECUTOR_UNAVAILABLE");

      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, setError, run };
}

function ModalShell({
  title,
  cancel,
  onClose,
  children,
  footer,
}: {
  title: string;
  cancel: string;
  onClose: () => void;
  children: ReactElement;
  footer: ReactElement;
}): ReactElement {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={cancel}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        type="button"
        onClick={onClose}
      />
      <div
        aria-modal="true"
        className="relative w-full max-w-[480px] overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
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
        <div className="flex flex-col gap-4 px-5 py-5">{children}</div>
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
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
        {label}
      </span>
      <input
        className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber"
        placeholder={placeholder}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function ErrorRow({ error }: { error: string | null }): ReactElement | null {
  if (!error) return null;

  return (
    <div className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber">
      {error}
    </div>
  );
}

export function InstallPackageModal({
  slug,
  labels,
}: {
  slug: string;
  labels: PackageLabels;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [flowRefId, setFlowRefId] = useState("");
  const [source, setSource] = useState("");
  const [version, setVersion] = useState("");
  const { busy, error, run } = useAction();

  const disabled =
    busy ||
    flowRefId.trim() === "" ||
    source.trim() === "" ||
    version.trim() === "";

  async function submit(): Promise<void> {
    const ok = await run(`/api/projects/${slug}/flow-packages/install`, {
      method: "POST",
      body: JSON.stringify({ flowRefId, source, version }),
    });

    if (ok) setOpen(false);
  }

  return (
    <>
      <button
        className={BTN_PRIMARY}
        type="button"
        onClick={() => setOpen(true)}
      >
        {labels.install}
      </button>
      {open ? (
        <ModalShell
          cancel={labels.cancel}
          footer={
            <>
              <button
                className={BTN_NEUTRAL}
                type="button"
                onClick={() => setOpen(false)}
              >
                {labels.cancel}
              </button>
              <button
                className={BTN_PRIMARY}
                disabled={disabled}
                type="button"
                onClick={() => void submit()}
              >
                {labels.confirm}
              </button>
            </>
          }
          title={labels.installTitle}
          onClose={() => setOpen(false)}
        >
          <>
            <Field
              label={labels.flowRefLabel}
              placeholder="bugfix"
              value={flowRefId}
              onChange={setFlowRefId}
            />
            <Field
              label={labels.sourceLabel}
              placeholder="github.com/org/maister-flow-bugfix"
              value={source}
              onChange={setSource}
            />
            <Field
              label={labels.versionLabel}
              placeholder="v1.2.3"
              value={version}
              onChange={setVersion}
            />
            <ErrorRow error={error} />
          </>
        </ModalShell>
      ) : null}
    </>
  );
}

export function PackageActions({
  slug,
  flowRef,
  trusted,
  enablementState,
  availableUpdateRevisionId,
  rollbackTargets,
  labels,
}: PackageActionsProps): ReactElement {
  const base = `/api/projects/${slug}/flow-packages/${encodeURIComponent(flowRef)}`;
  const { busy, error, run } = useAction();

  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [source, setSource] = useState("");
  const [version, setVersion] = useState("");
  const [rollbackTarget, setRollbackTarget] = useState(
    rollbackTargets[0]?.id ?? "",
  );

  async function upgrade(): Promise<void> {
    const ok = await run(`${base}/upgrade`, {
      method: "POST",
      body: JSON.stringify({ source, version }),
    });

    if (ok) setUpgradeOpen(false);
  }

  async function rollback(): Promise<void> {
    const ok = await run(`${base}/rollback`, {
      method: "POST",
      body: JSON.stringify({ revisionId: rollbackTarget }),
    });

    if (ok) setRollbackOpen(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!trusted ? (
        <button
          className={BTN_PRIMARY}
          disabled={busy}
          type="button"
          onClick={() =>
            void run(`${base}/trust`, {
              method: "POST",
              body: JSON.stringify({ trusted: true }),
            })
          }
        >
          {labels.trust}
        </button>
      ) : null}

      {availableUpdateRevisionId ? (
        <button
          className={BTN_PRIMARY}
          disabled={busy}
          type="button"
          onClick={() =>
            void run(`${base}/enable`, {
              method: "POST",
              body: JSON.stringify({ revisionId: availableUpdateRevisionId }),
            })
          }
        >
          {labels.enable}
        </button>
      ) : null}

      <button
        className={BTN_NEUTRAL}
        disabled={busy}
        type="button"
        onClick={() => setUpgradeOpen(true)}
      >
        {labels.upgrade}
      </button>

      {rollbackTargets.length > 0 ? (
        <button
          className={BTN_NEUTRAL}
          disabled={busy}
          type="button"
          onClick={() => setRollbackOpen(true)}
        >
          {labels.rollback}
        </button>
      ) : null}

      {enablementState !== "Disabled" ? (
        <button
          className={BTN_NEUTRAL}
          disabled={busy}
          type="button"
          onClick={() => void run(`${base}/disable`, { method: "POST" })}
        >
          {labels.disable}
        </button>
      ) : null}

      {error ? (
        <span className="font-mono text-[10px] font-bold uppercase text-amber">
          {error}
        </span>
      ) : null}

      {upgradeOpen ? (
        <ModalShell
          cancel={labels.cancel}
          footer={
            <>
              <button
                className={BTN_NEUTRAL}
                type="button"
                onClick={() => setUpgradeOpen(false)}
              >
                {labels.cancel}
              </button>
              <button
                className={BTN_PRIMARY}
                disabled={busy || source.trim() === "" || version.trim() === ""}
                type="button"
                onClick={() => void upgrade()}
              >
                {labels.confirm}
              </button>
            </>
          }
          title={`${labels.upgradeTitle} — ${flowRef}`}
          onClose={() => setUpgradeOpen(false)}
        >
          <>
            <Field
              label={labels.sourceLabel}
              placeholder="github.com/org/maister-flow-bugfix"
              value={source}
              onChange={setSource}
            />
            <Field
              label={labels.versionLabel}
              placeholder="v1.3.0"
              value={version}
              onChange={setVersion}
            />
            <ErrorRow error={error} />
          </>
        </ModalShell>
      ) : null}

      {rollbackOpen ? (
        <ModalShell
          cancel={labels.cancel}
          footer={
            <>
              <button
                className={BTN_NEUTRAL}
                type="button"
                onClick={() => setRollbackOpen(false)}
              >
                {labels.cancel}
              </button>
              <button
                className={clsx(BTN_PRIMARY)}
                disabled={busy || rollbackTarget === ""}
                type="button"
                onClick={() => void rollback()}
              >
                {labels.confirm}
              </button>
            </>
          }
          title={`${labels.rollback} — ${flowRef}`}
          onClose={() => setRollbackOpen(false)}
        >
          <>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
                {labels.revisionLabel}
              </span>
              <select
                className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber"
                value={rollbackTarget}
                onChange={(e) => setRollbackTarget(e.target.value)}
              >
                {rollbackTargets.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.versionLabel} · {r.resolvedRevision.slice(0, 12)}
                  </option>
                ))}
              </select>
            </label>
            <ErrorRow error={error} />
          </>
        </ModalShell>
      ) : null}
    </div>
  );
}
