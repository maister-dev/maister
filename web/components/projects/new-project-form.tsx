"use client";

import type { ReactElement } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import clsx from "clsx";

type ErrorCode = "CONFLICT" | "CONFIG" | "FLOW_INSTALL" | "UNAUTHORIZED";

const ERROR_KEY: Record<ErrorCode, string> = {
  CONFLICT: "errorConflict",
  CONFIG: "errorConfig",
  FLOW_INSTALL: "errorInstall",
  UNAUTHORIZED: "errorForbidden",
};

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
  "hover:-translate-y-px hover:bg-amber-2 disabled:cursor-wait disabled:opacity-70",
);

export function NewProjectForm(): ReactElement {
  const t = useTranslations("projects");
  const router = useRouter();

  const [dir, setDir] = useState("");
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<ErrorCode | undefined>(undefined);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorCode(undefined);
    setPending(true);

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir }),
      });

      if (res.status === 201) {
        router.push("/");

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

  return (
    <form className="flex flex-col gap-3.5" onSubmit={handleSubmit}>
      <div className="flex flex-col gap-1.5">
        <label className={fieldLabel} htmlFor="np-dir">
          {t("pathLabel")}
        </label>
        <div className={inputWrap}>
          <input
            required
            autoComplete="off"
            className={inputBase}
            id="np-dir"
            name="dir"
            placeholder={t("pathPlaceholder")}
            spellCheck={false}
            type="text"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
          />
        </div>
      </div>

      {errorCode ? (
        <p className="text-[11.5px] leading-[1.5] text-[#d9534f]">
          {t(ERROR_KEY[errorCode])}
        </p>
      ) : null}

      <button className={submitBtn} disabled={pending} type="submit">
        {pending ? t("registering") : t("register")}{" "}
        <span className="font-mono opacity-85">→</span>
      </button>
    </form>
  );
}
