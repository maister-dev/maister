"use client";

import type { ReactElement } from "react";

import { useActionState, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { authenticate, register } from "@/app/(auth)/actions";

type Mode = "login" | "register";

function strengthOf(v: string): number {
  let s = 0;

  if (v.length >= 8) s = 1;
  if (v.length >= 12) s = 2;
  if (v.length >= 12 && /[A-Z]/.test(v) && /\d/.test(v)) s = 3;
  if (
    v.length >= 14 &&
    /[A-Z]/.test(v) &&
    /\d/.test(v) &&
    /[^A-Za-z0-9]/.test(v)
  )
    s = 4;

  return s;
}

const STRENGTH_TONE = [
  "bg-line",
  "bg-[#d9534f]",
  "bg-amber",
  "bg-accent-4",
  "bg-good",
] as const;

const inputWrap = clsx(
  "relative flex items-center rounded-lg border border-line bg-paper transition-all",
  "focus-within:border-amber focus-within:shadow-[0_0_0_3px_var(--amber-soft)]",
);
const inputBase =
  "w-full flex-1 bg-transparent py-3 pl-10 pr-4 font-sans text-sm leading-[1.4] text-ink outline-none placeholder:text-mute placeholder:opacity-70";
const fieldLabel =
  "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute";
const inputIco =
  "pointer-events-none absolute left-3.5 flex items-center justify-center text-mute";
const submitBtn = clsx(
  "mt-2 flex w-full items-center justify-center gap-2.5 rounded-full border-0 bg-amber px-5 py-3.5",
  "font-sans text-sm font-semibold tracking-[-0.005em] text-white transition-all",
  "shadow-[0_8px_24px_-8px_var(--amber),0_2px_6px_-2px_rgba(0,0,0,0.08),0_1px_0_rgba(255,255,255,0.15)_inset]",
  "hover:-translate-y-px hover:bg-amber-2 disabled:cursor-wait disabled:opacity-70",
);

function EyeIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      viewBox="0 0 16 16"
    >
      <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z" />
      {open ? (
        <line x1="2" x2="14" y1="14" y2="2" />
      ) : (
        <circle cx="8" cy="8" r="2" />
      )}
    </svg>
  );
}

export interface AuthCardProps {
  redirectTo: string;
}

export function AuthCard({ redirectTo }: AuthCardProps): ReactElement {
  const t = useTranslations("auth");

  const [mode, setMode] = useState<Mode>("login");
  const [showLoginPwd, setShowLoginPwd] = useState(false);
  const [showRegPwd, setShowRegPwd] = useState(false);
  const [pwdValue, setPwdValue] = useState("");
  const [forgotOpen, setForgotOpen] = useState(false);
  const [regError, setRegError] = useState<
    "duplicate" | "weak" | "invalid" | "generic" | undefined
  >(undefined);
  const [regPending, setRegPending] = useState(false);

  const [loginState, loginAction, loginPending] = useActionState(
    authenticate,
    undefined,
  );
  const fallbackSignInRef = useRef<HTMLFormElement>(null);
  const fallbackEmailRef = useRef<HTMLInputElement>(null);
  const fallbackPwdRef = useRef<HTMLInputElement>(null);

  const strength = strengthOf(pwdValue);
  const isLogin = mode === "login";

  const errorKey = (
    code: "invalid" | "weak" | "duplicate" | "generic",
  ): string => {
    const map = {
      invalid: "errorInvalid",
      weak: "errorWeak",
      duplicate: "errorDuplicate",
      generic: "errorGeneric",
    } as const;

    return t(map[code]);
  };

  const handleRegisterSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    setRegError(undefined);
    setRegPending(true);

    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "");
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");

    const result = await register({ name, email, password });

    if (!result.ok) {
      setRegError(result.error);
      setRegPending(false);

      return;
    }

    if (fallbackEmailRef.current && fallbackPwdRef.current) {
      fallbackEmailRef.current.value = email;
      fallbackPwdRef.current.value = password;
      fallbackSignInRef.current?.requestSubmit();
    }
  };

  return (
    <div className="relative z-[2] w-full max-w-[420px] rounded-[20px] border border-line bg-paper p-9 pb-7 shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset,0_32px_64px_-32px_rgba(0,0,0,0.25),0_12px_32px_-16px_rgba(0,0,0,0.12)] [isolation:isolate]">
      <div className="mb-6 flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-ink">
          <svg
            aria-hidden="true"
            className="h-[18px] w-[18px] text-amber"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            viewBox="0 0 28 24"
          >
            <path d="M22 12 a8 8 0 1 1 -2.34 -5.66" />
            <polyline points="22 5 22 9 18 9" />
            <line x1="14" x2="14" y1="2" y2="4.5" />
            <circle cx="14" cy="1.6" fill="currentColor" r="1" stroke="none" />
            <circle cx="11" cy="12" fill="currentColor" r="1.2" stroke="none" />
            <circle cx="16" cy="12" fill="currentColor" r="1.2" stroke="none" />
          </svg>
          <span className="text-sm font-semibold tracking-[-0.01em]">
            m<strong className="font-extrabold not-italic">ai</strong>ster
          </span>
        </span>
        <span className="font-mono text-[10.5px] tracking-[0.04em] text-mute">
          {t("host")}
        </span>
      </div>

      <div className="mb-3.5 inline-flex items-center gap-2 rounded-full bg-ivory py-[5px] pl-4 pr-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-2">
        <span className="-mr-1 h-[5px] w-[5px] rounded-full bg-amber" />
        {isLogin ? t("eyebrowLogin") : t("eyebrowRegister")}
      </div>

      <h1 className="m-0 mb-1.5 text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">
        {isLogin ? t("titleLogin") : t("titleRegister")}
      </h1>
      <p className="m-0 mb-[22px] text-[13.5px] leading-[1.55] text-mute">
        {isLogin ? t("subLogin") : t("subRegister")}
      </p>

      <div
        className="mb-[22px] flex gap-1 rounded-full border border-line bg-ivory p-1"
        role="tablist"
      >
        <button
          aria-selected={isLogin}
          className={clsx(
            "flex-1 cursor-pointer rounded-full border-0 bg-transparent px-3.5 py-[9px] font-sans text-[13px] font-medium leading-none text-mute transition-all hover:text-ink",
            isLogin &&
              "bg-paper font-semibold text-ink shadow-[0_1px_0_rgba(0,0,0,0.04),0_2px_6px_-2px_rgba(0,0,0,0.08)]",
          )}
          role="tab"
          type="button"
          onClick={() => setMode("login")}
        >
          {t("tabLogin")}
        </button>
        <button
          aria-selected={!isLogin}
          className={clsx(
            "flex-1 cursor-pointer rounded-full border-0 bg-transparent px-3.5 py-[9px] font-sans text-[13px] font-medium leading-none text-mute transition-all hover:text-ink",
            !isLogin &&
              "bg-paper font-semibold text-ink shadow-[0_1px_0_rgba(0,0,0,0.04),0_2px_6px_-2px_rgba(0,0,0,0.08)]",
          )}
          role="tab"
          type="button"
          onClick={() => setMode("register")}
        >
          {t("tabRegister")}
        </button>
      </div>

      {isLogin ? (
        <form
          ref={fallbackSignInRef}
          action={loginAction}
          className="flex flex-col gap-3.5"
        >
          <input name="redirectTo" type="hidden" value={redirectTo} />

          <div className="flex flex-col gap-1.5">
            <label className={fieldLabel} htmlFor="li-email">
              {t("email")}
            </label>
            <div className={inputWrap}>
              <span className={inputIco}>
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  viewBox="0 0 16 16"
                >
                  <rect height="10" rx="2" width="12" x="2" y="3" />
                  <path d="M2 5l6 4 6-4" />
                </svg>
              </span>
              <input
                ref={fallbackEmailRef}
                required
                autoComplete="email"
                className={inputBase}
                id="li-email"
                name="email"
                placeholder="you@instance.local"
                type="email"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <label className={fieldLabel} htmlFor="li-pwd">
                {t("password")}
              </label>
              <button
                className="relative cursor-pointer font-sans text-xs font-medium text-amber hover:text-amber-2"
                type="button"
                onClick={() => setForgotOpen((v) => !v)}
              >
                {t("forgot")}
              </button>
            </div>
            <div className={inputWrap}>
              <span className={inputIco}>
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  viewBox="0 0 16 16"
                >
                  <rect height="7" rx="1.5" width="10" x="3" y="7" />
                  <path d="M5 7V5a3 3 0 0 1 6 0v2" />
                </svg>
              </span>
              <input
                ref={fallbackPwdRef}
                required
                autoComplete="current-password"
                className={inputBase}
                id="li-pwd"
                name="password"
                placeholder="••••••••••••"
                type={showLoginPwd ? "text" : "password"}
              />
              <button
                aria-label={
                  showLoginPwd ? t("hidePassword") : t("showPassword")
                }
                className="absolute right-2.5 flex items-center justify-center rounded-md border-0 bg-transparent p-1.5 text-mute hover:bg-ivory hover:text-ink"
                type="button"
                onClick={() => setShowLoginPwd((v) => !v)}
              >
                <EyeIcon open={showLoginPwd} />
              </button>
            </div>
            {forgotOpen ? (
              <span className="mt-0.5 text-[11.5px] leading-[1.5] text-mute">
                {t("forgotPlaceholder")}
              </span>
            ) : null}
          </div>

          <label className="mt-1 flex cursor-pointer items-start gap-2.5 text-[12.5px] leading-[1.5] text-ink-2">
            <input
              defaultChecked
              className="peer hidden"
              name="remember"
              type="checkbox"
            />
            <span className="mt-0.5 flex h-4 w-4 flex-[0_0_16px] items-center justify-center rounded border-[1.5px] border-line bg-paper transition-all peer-checked:border-amber peer-checked:bg-amber peer-checked:after:block peer-checked:after:h-[5px] peer-checked:after:w-2 peer-checked:after:-translate-y-px peer-checked:after:translate-x-px peer-checked:after:-rotate-45 peer-checked:after:border-[2px] peer-checked:after:border-r-0 peer-checked:after:border-t-0 peer-checked:after:border-paper peer-checked:after:content-['']" />
            <span>{t("remember")}</span>
          </label>

          {loginState?.error ? (
            <p className="text-[11.5px] leading-[1.5] text-[#d9534f]">
              {errorKey(loginState.error)}
            </p>
          ) : null}

          <button className={submitBtn} disabled={loginPending} type="submit">
            {t("submitLogin")} <span className="font-mono opacity-85">→</span>
          </button>
        </form>
      ) : (
        <form className="flex flex-col gap-3.5" onSubmit={handleRegisterSubmit}>
          <div className="flex flex-col gap-1.5">
            <label className={fieldLabel} htmlFor="rg-name">
              {t("fullName")}
            </label>
            <div className={inputWrap}>
              <span className={inputIco}>
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  viewBox="0 0 16 16"
                >
                  <circle cx="8" cy="5" r="2.6" />
                  <path d="M2.4 14c0-3 2.5-5.4 5.6-5.4S13.6 11 13.6 14" />
                </svg>
              </span>
              <input
                required
                autoComplete="name"
                className={inputBase}
                id="rg-name"
                name="name"
                placeholder="Alex Maister"
                type="text"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className={fieldLabel} htmlFor="rg-email">
              {t("email")}
            </label>
            <div className={inputWrap}>
              <span className={inputIco}>
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  viewBox="0 0 16 16"
                >
                  <rect height="10" rx="2" width="12" x="2" y="3" />
                  <path d="M2 5l6 4 6-4" />
                </svg>
              </span>
              <input
                required
                autoComplete="email"
                className={inputBase}
                id="rg-email"
                name="email"
                placeholder="you@instance.local"
                type="email"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className={fieldLabel} htmlFor="rg-pwd">
              {t("password")}
            </label>
            <div className={inputWrap}>
              <span className={inputIco}>
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  viewBox="0 0 16 16"
                >
                  <rect height="7" rx="1.5" width="10" x="3" y="7" />
                  <path d="M5 7V5a3 3 0 0 1 6 0v2" />
                </svg>
              </span>
              <input
                required
                autoComplete="new-password"
                className={inputBase}
                id="rg-pwd"
                name="password"
                placeholder="At least 12 characters"
                type={showRegPwd ? "text" : "password"}
                value={pwdValue}
                onChange={(e) => setPwdValue(e.target.value)}
              />
              <button
                aria-label={showRegPwd ? t("hidePassword") : t("showPassword")}
                className="absolute right-2.5 flex items-center justify-center rounded-md border-0 bg-transparent p-1.5 text-mute hover:bg-ivory hover:text-ink"
                type="button"
                onClick={() => setShowRegPwd((v) => !v)}
              >
                <EyeIcon open={showRegPwd} />
              </button>
            </div>
            <div className="mt-1.5 flex gap-[3px]">
              {[1, 2, 3, 4].map((seg) => (
                <span
                  key={seg}
                  className={clsx(
                    "h-[3px] flex-1 rounded-sm transition-colors",
                    seg <= strength ? STRENGTH_TONE[strength] : "bg-line",
                  )}
                />
              ))}
            </div>
            <span
              className={clsx(
                "mt-0.5 text-[11.5px] leading-[1.5]",
                strength >= 3
                  ? "text-good"
                  : strength === 1
                    ? "text-[#d9534f]"
                    : "text-mute",
              )}
            >
              {t(`strength${strength}` as `strength${0 | 1 | 2 | 3 | 4}`)}
            </span>
          </div>

          <label className="mt-1 flex cursor-pointer items-start gap-2.5 text-[12.5px] leading-[1.5] text-ink-2">
            <input required className="peer hidden" type="checkbox" />
            <span className="mt-0.5 flex h-4 w-4 flex-[0_0_16px] items-center justify-center rounded border-[1.5px] border-line bg-paper transition-all peer-checked:border-amber peer-checked:bg-amber peer-checked:after:block peer-checked:after:h-[5px] peer-checked:after:w-2 peer-checked:after:-translate-y-px peer-checked:after:translate-x-px peer-checked:after:-rotate-45 peer-checked:after:border-[2px] peer-checked:after:border-r-0 peer-checked:after:border-t-0 peer-checked:after:border-paper peer-checked:after:content-['']" />
            <span>{t("terms")}</span>
          </label>

          {regError ? (
            <p className="text-[11.5px] leading-[1.5] text-[#d9534f]">
              {errorKey(regError)}
            </p>
          ) : null}

          <button className={submitBtn} disabled={regPending} type="submit">
            {t("submitRegister")}{" "}
            <span className="font-mono opacity-85">→</span>
          </button>
        </form>
      )}

      <div className="-mx-9 mt-6 border-t border-line-soft px-9 pt-[18px] text-center text-[13px] text-mute">
        <span>{isLogin ? t("swapToRegister") : t("swapToLogin")}</span>
        <button
          className="group relative ml-1 inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent font-semibold text-amber hover:text-amber-2"
          type="button"
          onClick={() => setMode(isLogin ? "register" : "login")}
        >
          <span>{isLogin ? t("swapSignup") : t("swapSignin")}</span>
          <span className="font-mono font-normal transition-transform group-hover:translate-x-1">
            →
          </span>
        </button>
      </div>
    </div>
  );
}
