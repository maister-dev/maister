"use client";

import type { ReactElement } from "react";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { readApiError } from "@/lib/api-error";

type PublishOptions = {
  sources: { id: string; url: string }[];
  preselectedSourceId: string | null;
  defaultBranch: string;
};

type PublishResult = {
  branch: string;
  pushed: boolean;
  prUrl: string | null;
  compareUrl: string | null;
  crossRepo: boolean;
};

/**
 * The Stream-B PR-to-source publish dialog (ADR-113), a sibling of
 * `ChangeReviewDialog`. It pushes the package's committed HEAD to a REGISTERED
 * `package_sources` target (allow-list) on a stable `maister/<slug>` branch and
 * opens / updates a PR (or push-only with a compare URL). It deliberately pushes
 * the committed state, so it steers the author to commit pending edits first
 * rather than showing the working-tree diff (which would not be published).
 */
export function PublishDialog({
  packageId,
  onClose,
}: {
  packageId: string;
  onClose: () => void;
}): ReactElement {
  const t = useTranslations("publishDialog");
  const tApiErrors = useTranslations("apiErrors");
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  const [options, setOptions] = useState<PublishOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [branch, setBranch] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onCloseRef.current();
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(
        `/api/studio/local-packages/${packageId}/publish`,
      );

      if (!res.ok) {
        setLoadError(await readApiError(res, tApiErrors));

        return;
      }

      const data = (await res.json()) as PublishOptions;

      setOptions(data);
      setSourceId(data.preselectedSourceId ?? data.sources[0]?.id ?? "");
      setBranch(data.defaultBranch);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [packageId, tApiErrors]);

  useEffect(() => {
    void load();
  }, [load]);

  const crossRepo = Boolean(
    options?.preselectedSourceId &&
      sourceId &&
      sourceId !== options.preselectedSourceId,
  );

  async function publish(): Promise<void> {
    setPublishing(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/studio/local-packages/${packageId}/publish`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetSourceId: sourceId,
            branchName: branch,
          }),
        },
      );

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      setResult((await res.json()) as PublishResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishing(false);
    }
  }

  const noSources = options !== null && options.sources.length === 0;
  const fieldLabel =
    "font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute";

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="publish-dialog"
      role="dialog"
    >
      <div className="flex w-full max-w-[520px] flex-col gap-3 rounded-[16px] border border-line bg-paper p-6 shadow-xl">
        <h3 className="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          {t("title")}
        </h3>

        {loadError ? (
          <p
            className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger"
            role="alert"
          >
            {t("loadError")} — {loadError}
          </p>
        ) : result ? (
          <div
            className="flex flex-col gap-2 rounded-[10px] border border-line bg-ivory/60 p-3"
            data-testid="publish-result"
          >
            {result.prUrl ? (
              <p className="font-mono text-[11px] text-ink">
                {t("resultPr")}{" "}
                <a
                  className="text-amber underline"
                  href={result.prUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {result.prUrl}
                </a>
              </p>
            ) : (
              <>
                <p className="font-mono text-[11px] text-ink">
                  {t("resultPushed", { branch: result.branch })}
                </p>
                {result.compareUrl ? (
                  <p className="font-mono text-[11px] text-ink">
                    {t("resultCompare")}{" "}
                    <a
                      className="text-amber underline"
                      href={result.compareUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {result.compareUrl}
                    </a>
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <>
            <p className="font-mono text-[10px] text-mute">{t("note")}</p>

            {noSources ? (
              <p
                className="rounded-md border border-line bg-paper px-3 py-2 font-mono text-[11px] text-mute"
                data-testid="publish-no-sources"
              >
                {t("noSources")}
              </p>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  <span className={fieldLabel}>{t("sourceLabel")}</span>
                  <select
                    className="h-9 rounded-[10px] border border-line bg-ivory px-2 font-mono text-[11px] text-ink"
                    data-testid="publish-source"
                    value={sourceId}
                    onChange={(event) => setSourceId(event.target.value)}
                  >
                    {(options?.sources ?? []).map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.url}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className={fieldLabel}>{t("branchLabel")}</span>
                  <input
                    className="h-9 rounded-[10px] border border-line bg-ivory px-3 font-mono text-[12px] text-ink outline-none focus:border-ink"
                    data-testid="publish-branch"
                    type="text"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                  />
                </label>

                {crossRepo ? (
                  <p
                    className="rounded-md border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[10px] text-amber"
                    data-testid="publish-cross-repo"
                    role="alert"
                  >
                    {t("crossRepoWarning")}
                  </p>
                ) : null}
              </>
            )}

            {error ? (
              <p
                className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger"
                data-testid="publish-error"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            className="rounded-[10px] border border-line bg-paper px-3 py-2 text-[12px] text-mute hover:text-ink-2"
            data-testid="publish-cancel"
            type="button"
            onClick={onClose}
          >
            {result ? t("done") : t("cancel")}
          </button>
          {result ? null : (
            <button
              className="rounded-[10px] bg-ink px-4 py-2 text-[12px] font-bold uppercase tracking-[0.06em] text-paper hover:bg-ink-2 disabled:opacity-50"
              data-testid="publish-submit"
              disabled={publishing || noSources || !sourceId || !branch}
              type="button"
              onClick={() => void publish()}
            >
              {publishing ? t("publishing") : t("publish")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
