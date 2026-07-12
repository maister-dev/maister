"use client";

import type { ReactElement } from "react";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { readApiError } from "@/lib/api-error";

// ADR-132 §d (T20): the sync UI pair.
// - UpstreamSyncButton lives in the editor's breadcrumb action cluster
//   (beside the divergence entry) and owns the target-picker dialog:
//   installed versions POST /sync directly; a discovered-but-uninstalled
//   tag goes through "install & sync" (normal install path, then sync).
// - UpstreamSyncBanner renders whenever `sync_state` is pending — the
//   crash-window recovery surface: Resolve (optional commit message) or
//   Abort. No sweeper touches a pending sync; recovery is user-driven here.
export type SyncPendingState = {
  targetInstallId: string;
  targetRef: string;
  conflictedFiles: string[];
};

export type SyncOptions = {
  targets: { installId: string; versionLabel: string }[];
  source: { sourceId: string; packageName: string; tags: string[] } | null;
};

type SyncOutcome = {
  outcome: "clean" | "conflicted" | "completed";
  conflictedFiles: string[];
  targetRef: string;
};

async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function UpstreamSyncButton({
  packageId,
  sessionId,
  disabled,
  options,
}: {
  packageId: string;
  sessionId: string;
  disabled: boolean;
  options: SyncOptions;
}): ReactElement {
  const t = useTranslations("studio");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  async function runSync(targetInstallId: string): Promise<void> {
    const res = await postJson(`/api/studio/local-packages/${packageId}/sync`, {
      sessionId,
      targetInstallId,
    });

    if (!res.ok) {
      setError(await readApiError(res, tApiErrors));

      return;
    }
    const result = (await res.json()) as SyncOutcome;

    if (result.outcome === "clean") {
      setNotice(t("sync.cleanDone", { label: result.targetRef }));
    } else {
      setNotice(
        t("sync.conflictsFound", { count: result.conflictedFiles.length }),
      );
    }
    router.refresh();
  }

  async function start(): Promise<void> {
    if (!picked) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (picked.startsWith("install:")) {
        // "install & sync" — the tag lands through the NORMAL install path
        // (content-addressed cache), then the sync targets the fresh install.
        const tag = picked.slice("install:".length);
        const res = await postJson("/api/admin/package-installs", {
          sourceId: options.source!.sourceId,
          name: options.source!.packageName,
          version: tag,
        });

        if (!res.ok) {
          setError(await readApiError(res, tApiErrors));

          return;
        }
        const installed = (await res.json()) as { id: string };

        await runSync(installed.id);
      } else {
        await runSync(picked);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const hasChoices =
    options.targets.length > 0 || (options.source?.tags.length ?? 0) > 0;

  return (
    <>
      <button
        className="inline-flex items-center gap-1.5 rounded-[10px] border border-line bg-ivory px-3 py-1.5 font-mono text-[11px] font-semibold text-ink transition-colors hover:border-amber disabled:opacity-50"
        data-testid="local-editor-sync"
        disabled={disabled}
        title={t("sync.button")}
        type="button"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden>⇣</span>
        <span>{t("sync.button")}</span>
      </button>
      {open ? (
        <div
          aria-labelledby="upstream-sync-title"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
        >
          <div className="flex w-full max-w-[480px] flex-col gap-4 rounded-[16px] border border-line bg-paper p-6 shadow-xl">
            <h3
              className="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute"
              id="upstream-sync-title"
            >
              {t("sync.dialogTitle")}
            </h3>

            {hasChoices ? (
              <>
                <label className="sr-only" htmlFor="sync-target-select">
                  {t("sync.targetPick")}
                </label>
                <select
                  className="h-9 rounded-[8px] border border-line bg-paper px-2 font-mono text-[12px] text-ink"
                  data-testid="sync-target-select"
                  id="sync-target-select"
                  value={picked}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  <option value="">{t("sync.targetPick")}</option>
                  {options.targets.map((target) => (
                    <option key={target.installId} value={target.installId}>
                      {target.versionLabel}
                    </option>
                  ))}
                  {(options.source?.tags ?? []).map((tag) => (
                    <option key={`install:${tag}`} value={`install:${tag}`}>
                      {t("sync.installAndSync", { tag })}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <p className="m-0 text-[12.5px] leading-[1.5] text-mute">
                {t("sync.noTargets")}
              </p>
            )}

            {notice ? (
              <p
                className="m-0 rounded-[8px] border border-line bg-ivory px-3 py-2 text-[12px] text-ink"
                data-testid="sync-notice"
                role="status"
              >
                {notice}
              </p>
            ) : null}
            {error ? (
              <p
                className="m-0 rounded-[8px] border border-danger-line bg-danger-soft px-3 py-2 text-[12px] text-danger"
                role="alert"
              >
                {error}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                className="rounded-[10px] border border-line bg-paper px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2"
                disabled={busy}
                type="button"
                onClick={() => setOpen(false)}
              >
                {t("sync.close")}
              </button>
              <button
                className="rounded-[10px] border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
                data-testid="sync-start"
                disabled={busy || !picked}
                type="button"
                onClick={() => void start()}
              >
                {t("sync.start")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function UpstreamSyncBanner({
  packageId,
  sessionId,
  pending,
  disabled,
}: {
  packageId: string;
  sessionId: string;
  pending: SyncPendingState;
  disabled: boolean;
}): ReactElement {
  const t = useTranslations("studio");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [busy, setBusy] = useState<"resolve" | "abort" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function act(op: "resolve" | "abort"): Promise<void> {
    setBusy(op);
    setError(null);
    try {
      const res = await postJson(
        `/api/studio/local-packages/${packageId}/sync/${op}`,
        op === "resolve"
          ? {
              sessionId,
              ...(message.trim() !== ""
                ? { commitMessage: message.trim() }
                : {}),
            }
          : { sessionId },
      );

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="mb-3 flex flex-col gap-2 rounded-[12px] border border-amber/50 bg-amber/10 px-4 py-3"
      data-testid="sync-banner"
      role="alert"
    >
      <p className="m-0 text-[13px] font-semibold text-ink">
        {t("sync.bannerTitle", { label: pending.targetRef })}
      </p>
      {pending.conflictedFiles.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-[11.5px] text-ink-2">
          {pending.conflictedFiles.map((file) => (
            <li key={file} data-testid="sync-conflicted-file">
              {file}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-[12px] text-mute">{t("sync.bannerNoList")}</p>
      )}
      {error ? (
        <p
          className="m-0 rounded-[8px] border border-danger-line bg-danger-soft px-3 py-2 text-[12px] text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("sync.resolveMessagePlaceholder")}
          className="h-8 min-w-[220px] flex-1 rounded-[8px] border border-line bg-paper px-2 font-mono text-[11.5px] text-ink placeholder:text-mute"
          data-testid="sync-resolve-message"
          disabled={disabled || busy !== null}
          placeholder={t("sync.resolveMessagePlaceholder")}
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button
          className="h-8 rounded-[8px] border border-amber bg-amber px-3 text-[12px] font-semibold text-white hover:bg-amber-2 disabled:opacity-50"
          data-testid="sync-resolve"
          disabled={disabled || busy !== null}
          type="button"
          onClick={() => void act("resolve")}
        >
          {t("sync.resolve")}
        </button>
        <button
          className="h-8 rounded-[8px] border border-danger-line bg-danger-soft px-3 text-[12px] font-semibold text-danger hover:bg-paper disabled:opacity-50"
          data-testid="sync-abort"
          disabled={disabled || busy !== null}
          type="button"
          onClick={() => {
            if (window.confirm(t("sync.abortConfirm"))) void act("abort");
          }}
        >
          {t("sync.abort")}
        </button>
      </div>
    </div>
  );
}
