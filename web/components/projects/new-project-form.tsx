"use client";

import type { ReactElement } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import Link from "next/link";
import clsx from "clsx";

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

type GitStatus = "remote" | "no-remote" | "initialized";

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

export function NewProjectForm(): ReactElement {
  const t = useTranslations("projects");
  const router = useRouter();

  const [repoUrl, setRepoUrl] = useState("");
  const [target, setTarget] = useState("");
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<ErrorCode | undefined>(undefined);
  const [success, setSuccess] = useState<Success | undefined>(undefined);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorCode(undefined);
    setPending(true);

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: repoUrl.trim() || undefined,
          target: target.trim() || undefined,
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
      } | null;
      const code = payload?.code;

      setErrorCode(code && code in ERROR_KEY ? (code as ErrorCode) : "CONFIG");
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
            setRepoUrl("");
            setTarget("");
          }}
        >
          {t("registerAnother")}
        </button>
      </div>
    );
  }

  const bothEmpty = repoUrl.trim() === "" && target.trim() === "";
  // Warn (don't block) when the URL embeds credentials — they'd be stored as
  // entered. Host SSH keys / credential helper are the recommended path.
  const urlHasCreds = /:\/\/[^/@\s]+:[^/@\s]+@/.test(repoUrl);

  return (
    <form className="flex flex-col gap-3.5" onSubmit={handleSubmit}>
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
            onChange={(e) => setRepoUrl(e.target.value)}
          />
        </div>
        {urlHasCreds ? (
          <p className="text-[11.5px] leading-[1.5] text-amber">
            {t("warnUrlCreds")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className={fieldLabel} htmlFor="np-target">
          {t("overrideLabel")}
        </label>
        <div className={inputWrap}>
          <input
            autoComplete="off"
            className={inputBase}
            id="np-target"
            name="target"
            placeholder={t("overridePlaceholder")}
            spellCheck={false}
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
      </div>

      <p className="text-[11.5px] leading-[1.5] text-mute">{t("sourceHint")}</p>

      {errorCode ? (
        <p className="text-[11.5px] leading-[1.5] text-[#d9534f]">
          {t(ERROR_KEY[errorCode])}
        </p>
      ) : null}

      <button
        className={submitBtn}
        disabled={pending || bothEmpty}
        type="submit"
      >
        {pending ? t("registering") : t("register")}{" "}
        <span className="font-mono opacity-85">→</span>
      </button>
    </form>
  );
}
