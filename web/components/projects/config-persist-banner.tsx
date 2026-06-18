"use client";

import type { ReactElement } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { readApiError } from "@/lib/api-error";

// Mirrors the route's hardcoded commit message — shown in the confirm step so
// the operator sees exactly what will land on the main branch.
const COMMIT_MESSAGE = "chore(maister): persist project config";
const DISMISS_PREFIX = "maister.persistBanner.dismissed.";

export interface ConfigPersistBannerProps {
  slug: string;
  projectName: string;
  // ADR-093 invariant D: needsPersist is the derived "config lives only in the
  // DB" signal; canEdit gates the CTA so it is never shown to a viewer who would
  // get a 403 from the route (admin/owner only).
  needsPersist: boolean;
  canEdit: boolean;
  settingsHref: string;
  // Optional context for the confirm step. Omitted on the home (the portfolio
  // DTO never carries the raw repo path — owner 2026-06-17); present on the
  // board where getProjectBySlug exposes the full row.
  mainBranch?: string;
  repoPath?: string;
}

export function ConfigPersistBanner(
  props: ConfigPersistBannerProps,
): ReactElement | null {
  const t = useTranslations("projects");
  const tErr = useTranslations("apiErrors");
  const router = useRouter();

  const dismissKey = `${DISMISS_PREFIX}${props.slug}`;
  // Lazy init: SSR / renderToStaticMarkup has no window → not dismissed (the
  // banner renders); the client reads the persisted choice on first render with
  // no flash.
  const [dismissed, setDismissed] = useState<boolean>(() =>
    typeof window !== "undefined"
      ? window.localStorage.getItem(dismissKey) === "1"
      : false,
  );
  const [confirming, setConfirming] = useState(false);
  const [push, setPush] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ advisory: string | null } | null>(null);

  if (!props.needsPersist || !props.canEdit || dismissed) return null;

  function dismiss(): void {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(dismissKey, "1");
    }
    setDismissed(true);
  }

  async function persist(): Promise<void> {
    setPending(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${props.slug}/persist-config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ push }),
      });

      if (!res.ok) {
        setError(await readApiError(res, tErr));
        setPending(false);

        return;
      }

      const body = (await res.json().catch(() => ({}))) as {
        usedDefaultAuthor?: boolean;
        pushWarning?: string;
      };
      const notes: string[] = [];

      if (body.usedDefaultAuthor)
        notes.push(t("persistBanner.usedDefaultAuthor"));
      if (body.pushWarning) {
        notes.push(
          t("persistBanner.pushWarning", { detail: body.pushWarning }),
        );
      }

      // No global toast system — surface advisories in a success panel the user
      // closes (which then refreshes the server data so the banner is gone).
      setDone({ advisory: notes.length > 0 ? notes.join(" ") : null });
      setPending(false);
    } catch {
      setError(t("persistBanner.error"));
      setPending(false);
    }
  }

  if (done) {
    return (
      <div
        className="mb-5 rounded-xl border border-line bg-paper px-4 py-3 text-[13px] text-ink"
        role="status"
      >
        <div className="font-semibold">{t("persistBanner.doneTitle")}</div>
        {done.advisory ? (
          <p className="mt-1 text-mute">{done.advisory}</p>
        ) : null}
        <button
          className="mt-2 rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-line/40"
          type="button"
          onClick={() => router.refresh()}
        >
          {t("persistBanner.close")}
        </button>
      </div>
    );
  }

  return (
    <div className="mb-5 rounded-xl border border-amber-line bg-amber-soft px-4 py-3 text-[13px] text-ink">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold">
            {t("persistBanner.title", { project: props.projectName })}
          </div>
          <p className="mt-1 max-w-[68ch] text-mute">
            {t("persistBanner.body")}
          </p>
        </div>
        {!confirming ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              className="rounded-lg bg-amber px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-amber-2"
              type="button"
              onClick={() => setConfirming(true)}
            >
              {t("persistBanner.persist")}
            </button>
            <button
              className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-line/40"
              type="button"
              onClick={dismiss}
            >
              {t("persistBanner.dismiss")}
            </button>
          </div>
        ) : null}
      </div>

      {confirming ? (
        <div
          aria-label={t("persistBanner.confirmTitle")}
          className="mt-3 rounded-lg border border-line bg-paper p-3"
          role="group"
        >
          <div className="font-semibold">{t("persistBanner.confirmTitle")}</div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px] text-mute">
            {props.mainBranch ? (
              <>
                <dt className="text-ink-2">{t("persistBanner.branchLabel")}</dt>
                <dd className="font-mono text-ink">{props.mainBranch}</dd>
              </>
            ) : null}
            {props.repoPath ? (
              <>
                <dt className="text-ink-2">{t("persistBanner.pathLabel")}</dt>
                <dd className="break-all font-mono text-ink">
                  {props.repoPath}
                </dd>
              </>
            ) : null}
            <dt className="text-ink-2">{t("persistBanner.commitLabel")}</dt>
            <dd className="font-mono text-ink">{COMMIT_MESSAGE}</dd>
          </dl>

          <label className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-2">
            <input
              checked={push}
              type="checkbox"
              onChange={(e) => setPush(e.target.checked)}
            />
            {t("persistBanner.alsoPush")}
          </label>

          {error ? (
            <p className="mt-2 text-[12.5px] text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-3 flex items-center gap-2">
            <button
              className="rounded-lg bg-amber px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-amber-2 disabled:opacity-60"
              disabled={pending}
              type="button"
              onClick={() => void persist()}
            >
              {pending
                ? t("persistBanner.pending")
                : t("persistBanner.confirm")}
            </button>
            <button
              className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-line/40 disabled:opacity-60"
              disabled={pending}
              type="button"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              {t("persistBanner.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <a
          className="mt-2 inline-block text-[12px] text-ink-2 underline-offset-2 hover:underline"
          href={props.settingsHref}
        >
          {t("persistBanner.settingsLink")}
        </a>
      )}
    </div>
  );
}
