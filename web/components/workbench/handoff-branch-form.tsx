"use client";

import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { isMaisterErrorCode } from "@/lib/errors-core";

// ADR-181 C30: the handoff-branch form, moved UNCHANGED out of the removed
// Export dialog into the git panel's Publish section — handoff (a fresh branch
// cut at HEAD for a local dev) is not the run's publication, so it keeps its
// own metadata read and its own route.

type HandoffMetadata = {
  ok: true;
  runId: string;
  branch: string;
  dirty: boolean;
  remotes: string[];
  defaultRemote: string | null;
  suggestedHandoffBranch: string;
  checkoutCommands: string[];
};

type HandoffResult = {
  ok: true;
  runId: string;
  branch: string;
  handoffBranch: string;
  remote: string;
  pushedRef: string;
  headCommit: string;
  checkoutCommands: string[];
};

type ErrorBody = { code?: string; reason?: string };

const inputClass =
  "min-h-[34px] rounded-md border border-line bg-paper px-2.5 font-mono text-[11px] text-ink outline-none focus:border-amber";

function isValidHandoffBranch(value: string): boolean {
  return (
    /^[A-Za-z0-9_./-]+$/.test(value) &&
    value.length <= 255 &&
    !value.startsWith("-") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

function isValidRemoteName(value: string): boolean {
  return (
    /^[A-Za-z0-9_./-]+$/.test(value) &&
    value.length <= 255 &&
    !value.startsWith("-")
  );
}

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

export function HandoffBranchForm({ runId }: { runId: string }): ReactElement {
  const t = useTranslations("workbenchLifecycle");
  const router = useRouter();
  const [metadata, setMetadata] = useState<HandoffMetadata | null>(null);
  const [remote, setRemote] = useState("origin");
  const [handoffBranch, setHandoffBranch] = useState(
    `maister/handoff/${runId}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [result, setResult] = useState<HandoffResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/handoff-metadata`);
        const body = res.ok ? await readJson<HandoffMetadata>(res) : null;

        if (cancelled) return;
        if (!body) {
          setError((await readJson<ErrorBody>(res)) ?? {});

          return;
        }

        setMetadata(body);
        setRemote(body.defaultRemote ?? "");
        setHandoffBranch(body.suggestedHandoffBranch);
      } catch {
        if (!cancelled) setError({ code: "EXECUTOR_UNAVAILABLE" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runId]);

  async function createHandoffBranch(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/runs/${runId}/handoff-branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remote, handoffBranch }),
      });

      if (!res.ok) {
        setError((await readJson<ErrorBody>(res)) ?? {});

        return;
      }

      const body = await readJson<HandoffResult>(res);

      if (!body) {
        setError({});

        return;
      }

      setResult(body);
      router.refresh();
    } catch {
      setError({ code: "EXECUTOR_UNAVAILABLE" });
    } finally {
      setBusy(false);
    }
  }

  const handoffBranchValid = isValidHandoffBranch(handoffBranch);
  const remoteValid = isValidRemoteName(remote);
  const errorText = error
    ? error.reason === "workspace_git_identity_invalid" ||
      error.reason === "workspace_preservation_failed"
      ? t(`errors.${error.reason}`)
      : error.code &&
          isMaisterErrorCode(error.code) &&
          t.has(`errors.${error.code}`)
        ? t(`errors.${error.code}`)
        : t("error")
    : null;

  return (
    <div
      className="flex flex-col gap-3 text-[12px] leading-[1.45] text-ink-2"
      data-testid="git-panel-handoff"
    >
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
          {t("dialog.remote")}
        </span>
        <select
          className={inputClass}
          value={remote}
          onChange={(event) => {
            setError(null);
            setRemote(event.target.value);
          }}
        >
          {(metadata?.remotes ?? [remote]).map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        {remote && !remoteValid ? (
          <span className="font-mono text-[10px] text-amber">
            {t("dialog.invalidRemote")}
          </span>
        ) : null}
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
          {t("dialog.handoffBranch")}
        </span>
        <input
          className={inputClass}
          value={handoffBranch}
          onChange={(event) => {
            setError(null);
            setHandoffBranch(event.target.value);
          }}
        />
        {handoffBranch && !handoffBranchValid ? (
          <span className="font-mono text-[10px] text-amber">
            {t("dialog.invalidBranch")}
          </span>
        ) : null}
        <span className="font-mono text-[10px] text-mute">
          {t("dialog.handoffHelp")}
        </span>
      </label>
      <div className="flex justify-end">
        <button
          className="rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2 disabled:opacity-60"
          disabled={
            busy ||
            !remoteValid ||
            !handoffBranchValid ||
            metadata === null ||
            metadata.dirty
          }
          type="button"
          onClick={() => void createHandoffBranch()}
        >
          {t("dialog.handoff")}
        </button>
      </div>
      {result ? (
        <div className="rounded-md border border-line bg-ivory p-3">
          <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
            {result.pushedRef}
          </div>
          <div className="flex flex-col gap-1">
            {result.checkoutCommands.map((command) => (
              <div
                key={command}
                className="flex items-center gap-2 rounded-md border border-line bg-paper px-2 py-1"
              >
                <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                  {command}
                </code>
                <button
                  className="font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-amber"
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(command)}
                >
                  {t("dialog.copy")}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {errorText ? (
        <p
          aria-live="assertive"
          className={clsx("font-mono text-[10px] font-semibold text-amber")}
          role="alert"
        >
          {errorText}
        </p>
      ) : null}
    </div>
  );
}
