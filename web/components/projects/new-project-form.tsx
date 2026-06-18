"use client";

import type { ReactElement } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import Link from "next/link";
import clsx from "clsx";

import { deriveRepoNameSafe } from "@/lib/repo-name";
import { deriveTaskKey, TASK_KEY_REGEX } from "@/lib/social/task-key";

type ErrorCode =
  | "CONFLICT"
  | "CONFIG"
  | "FLOW_INSTALL"
  | "UNAUTHORIZED"
  | "PRECONDITION";

const ERROR_KEY: Record<ErrorCode, string> = {
  CONFLICT: "errorConflict",
  CONFIG: "errorConfig",
  FLOW_INSTALL: "errorInstall",
  UNAUTHORIZED: "errorForbidden",
  PRECONDITION: "errorClone",
};

// ADR-093: a clone PRECONDITION carries an advisory `reason` → a specific
// remediation key. UNKNOWN (and any unmapped reason) falls back to errorClone.
const REASON_KEY: Record<string, string> = {
  SSH_AUTH: "errorSshAuth",
  SSH_HOSTKEY: "errorSshHostkey",
  HTTPS_AUTH: "errorHttpsAuth",
  NOT_FOUND: "errorNotFound",
  NETWORK: "errorNetwork",
  UNKNOWN: "errorClone",
};

type GitStatus = "remote" | "no-remote" | "initialized";
type Mode = "clone" | "existing" | "new";

interface Success {
  slug: string;
  gitStatus: GitStatus;
}

const fieldLabel =
  "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute";
const inputWrap = clsx(
  "relative flex items-center rounded-lg border border-line bg-paper transition-all",
  "focus-within:border-amber focus-within:shadow-[0_0_0_3px_var(--amber-soft)]",
);
const inputBase =
  "w-full flex-1 bg-transparent py-3 pl-4 pr-4 font-mono text-sm leading-[1.4] text-ink outline-none placeholder:text-mute placeholder:opacity-70";
const submitBtn = clsx(
  "mt-2 flex w-full items-center justify-center gap-2.5 rounded-full border-0 bg-amber px-5 py-3.5",
  "font-sans text-sm font-semibold tracking-[-0.005em] text-white transition-all",
  "shadow-[0_8px_24px_-8px_var(--amber),0_2px_6px_-2px_rgba(0,0,0,0.08),0_1px_0_rgba(255,255,255,0.15)_inset]",
  "hover:-translate-y-px hover:bg-amber-2 disabled:cursor-not-allowed disabled:opacity-70",
);
const modeBtn = (active: boolean) =>
  clsx(
    "flex-1 rounded-md px-3 py-2 font-sans text-[12px] font-semibold transition-all",
    active
      ? "bg-amber text-white shadow-[0_2px_6px_-2px_var(--amber)]"
      : "bg-transparent text-mute hover:text-ink",
  );

// Mirror the server's task-key derivation (deriveTaskKey) for the live preview,
// emitting "" for empty input so we never prefill a key with nothing to derive.
function previewKey(source: string): string {
  const trimmed = source.trim();

  if (!trimmed) return "";

  const key = deriveTaskKey(trimmed);

  return TASK_KEY_REGEX.test(key) ? key : "";
}

// ADR-093: the registration error surface. A clone PRECONDITION renders its
// advisory `reason` as a specific remediation + a collapsible (redacted) git
// output; a github.com HTTPS_AUTH adds the `gh` hint. Extracted as a pure
// component so each reason branch is unit-testable (the form sets the state via
// an async submit that renderToStaticMarkup cannot drive).
export function CloneErrorBlock({
  errorCode,
  cloneReason,
  cloneDetail,
  repoUrl,
}: {
  errorCode: ErrorCode | undefined;
  cloneReason: string | undefined;
  cloneDetail: string | undefined;
  repoUrl: string;
}): ReactElement | null {
  const t = useTranslations("projects");

  if (!errorCode) return null;

  return (
    <div className="flex flex-col gap-1.5" role="alert">
      <p className="text-[11.5px] leading-[1.5] text-[#d9534f]">
        {errorCode === "PRECONDITION" && cloneReason
          ? t(REASON_KEY[cloneReason] ?? "errorClone")
          : t(ERROR_KEY[errorCode])}
      </p>
      {errorCode === "PRECONDITION" &&
      cloneReason === "HTTPS_AUTH" &&
      /github\.com/i.test(repoUrl) ? (
        <p className="text-[11.5px] leading-[1.5] text-mute">
          {t("ghLoginHint")}
        </p>
      ) : null}
      {cloneDetail ? (
        <details className="text-[11.5px] leading-[1.5] text-mute">
          <summary className="cursor-pointer">{t("errorCloneDetail")}</summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md border border-line bg-paper p-2 font-mono text-[10.5px] text-ink-2">
            {cloneDetail}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export function NewProjectForm(): ReactElement {
  const t = useTranslations("projects");
  const router = useRouter();

  const [mode, setMode] = useState<Mode>("clone");
  const [repoUrl, setRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [taskKey, setTaskKey] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [taskKeyDirty, setTaskKeyDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<ErrorCode | undefined>(undefined);
  const [cloneReason, setCloneReason] = useState<string | undefined>(undefined);
  const [cloneDetail, setCloneDetail] = useState<string | undefined>(undefined);
  const [success, setSuccess] = useState<Success | undefined>(undefined);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorCode(undefined);
    setCloneReason(undefined);
    setCloneDetail(undefined);
    setPending(true);

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          repoUrl: repoUrl.trim() || undefined,
          name: name.trim() || undefined,
          target: target.trim() || undefined,
          taskKey: taskKey.trim() || undefined,
        }),
      });

      if (res.status === 201) {
        const payload = (await res.json().catch(() => null)) as {
          slug: string;
          gitStatus: GitStatus;
        } | null;

        if (payload?.gitStatus === "remote") {
          router.push("/");

          return;
        }

        if (payload) {
          setSuccess({ slug: payload.slug, gitStatus: payload.gitStatus });
        }

        return;
      }

      const payload = (await res.json().catch(() => null)) as {
        code?: string;
        reason?: string;
        detail?: string;
      } | null;
      const code = payload?.code;

      setErrorCode(code && code in ERROR_KEY ? (code as ErrorCode) : "CONFIG");
      setCloneReason(payload?.reason);
      setCloneDetail(payload?.detail);
    } catch {
      setErrorCode("CONFIG");
    } finally {
      setPending(false);
    }
  };

  if (success) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-amber-line bg-amber-soft px-3 py-2 text-amber">
        <p className="text-[13px] font-semibold leading-[1.4]">
          {t("successTitle")}
        </p>
        <p className="text-[11.5px] leading-[1.5]">
          {success.gitStatus === "initialized"
            ? t("warnInitialized")
            : t("warnNotGit")}
        </p>
        <Link
          className="text-[11.5px] font-semibold leading-[1.5] underline"
          href={`/projects/${success.slug}`}
        >
          {t("goToProject")}
        </Link>
        <button
          className="text-left text-[11.5px] font-semibold leading-[1.5] text-mute underline"
          type="button"
          onClick={() => {
            setSuccess(undefined);
            setMode("clone");
            setRepoUrl("");
            setName("");
            setTarget("");
            setTaskKey("");
            setNameDirty(false);
            setTaskKeyDirty(false);
          }}
        >
          {t("registerAnother")}
        </button>
      </div>
    );
  }

  const canSubmit =
    mode === "clone" ? repoUrl.trim() !== "" : target.trim() !== "";
  // Warn (don't block) when the URL embeds credentials — they'd be stored as
  // entered. Host SSH keys / credential helper are the recommended path.
  const urlHasCreds = /:\/\/[^/@\s]+:[^/@\s]+@/.test(repoUrl);

  return (
    <form className="flex flex-col gap-3.5" onSubmit={handleSubmit}>
      <div
        aria-label={t("modeLabel")}
        className="flex gap-1 rounded-lg border border-line bg-paper p-1"
        role="radiogroup"
      >
        {(["clone", "existing", "new"] as const).map((m) => (
          <button
            key={m}
            aria-checked={mode === m}
            className={modeBtn(mode === m)}
            role="radio"
            type="button"
            onClick={() => setMode(m)}
          >
            {t(
              m === "clone"
                ? "modeClone"
                : m === "existing"
                  ? "modeExisting"
                  : "modeNew",
            )}
          </button>
        ))}
      </div>

      {mode === "clone" ? (
        <div className="flex flex-col gap-1.5">
          <label className={fieldLabel} htmlFor="np-url">
            {t("urlLabel")}
          </label>
          <div className={inputWrap}>
            <input
              autoComplete="off"
              className={inputBase}
              id="np-url"
              name="repoUrl"
              placeholder={t("urlPlaceholder")}
              spellCheck={false}
              type="text"
              value={repoUrl}
              onChange={(e) => {
                const url = e.target.value;

                setRepoUrl(url);

                const derived = deriveRepoNameSafe(url) ?? "";
                const effectiveName = nameDirty ? name : derived;

                if (!nameDirty) setName(derived);
                if (!taskKeyDirty) setTaskKey(previewKey(effectiveName));
              }}
            />
          </div>
          {urlHasCreds ? (
            <p className="text-[11.5px] leading-[1.5] text-amber">
              {t("warnUrlCreds")}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label className={fieldLabel} htmlFor="np-name">
          {t("nameLabel")}
        </label>
        <div className={inputWrap}>
          <input
            autoComplete="off"
            className={inputBase}
            id="np-name"
            name="name"
            placeholder={t("namePlaceholder")}
            spellCheck={false}
            type="text"
            value={name}
            onChange={(e) => {
              const v = e.target.value;

              setName(v);
              setNameDirty(true);
              if (!taskKeyDirty) setTaskKey(previewKey(v));
            }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className={fieldLabel} htmlFor="np-target">
          {t("locationLabel")}
        </label>
        <div className={inputWrap}>
          <input
            autoComplete="off"
            className={inputBase}
            id="np-target"
            name="target"
            placeholder={t("locationPlaceholder")}
            spellCheck={false}
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className={fieldLabel} htmlFor="np-task-key">
          {t("taskKeyLabel")}
        </label>
        <div className={inputWrap}>
          <input
            autoComplete="off"
            className={inputBase}
            id="np-task-key"
            name="taskKey"
            placeholder={t("taskKeyPlaceholder")}
            spellCheck={false}
            type="text"
            value={taskKey}
            onChange={(e) => {
              setTaskKeyDirty(true);
              setTaskKey(
                e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
              );
            }}
          />
        </div>
        {taskKey.length > 0 && !/^[A-Z][A-Z0-9]{1,9}$/.test(taskKey) ? (
          <p className="text-[11.5px] leading-[1.5] text-amber">
            {t("taskKeyFormatHint")}
          </p>
        ) : null}
      </div>

      <p className="text-[11.5px] leading-[1.5] text-mute">{t("sourceHint")}</p>

      <CloneErrorBlock
        cloneDetail={cloneDetail}
        cloneReason={cloneReason}
        errorCode={errorCode}
        repoUrl={repoUrl}
      />

      <button
        className={submitBtn}
        disabled={pending || !canSubmit}
        type="submit"
      >
        {pending ? t("registering") : t("register")}{" "}
        <span className="font-mono opacity-85">→</span>
      </button>
    </form>
  );
}
