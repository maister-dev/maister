"use client";

import type { ReactElement, ReactNode } from "react";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { ScratchLauncher } from "@/components/scratch/scratch-launcher";

export interface ScratchLaunchPopoverProps {
  label: string;
  title: string;
  projectId?: string | null;
  variant: "icon" | "primary" | "rail";
  hint?: string;
  disabled?: boolean;
  shortcut?: ReactNode;
}

export function ScratchLaunchPopover({
  label,
  title,
  projectId,
  variant,
  hint,
  disabled = false,
  shortcut,
}: ScratchLaunchPopoverProps): ReactElement {
  const t = useTranslations("scratch");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Global Cmd/Ctrl+K opens the primary (portfolio) launcher. K is reliably
  // overridable where L often is not (FF binds Ctrl/Cmd+L to the address bar).
  // Only the primary instance listens so the per-project icon popovers do not
  // all open at once. Never fires while typing or when another modal is open.
  useEffect(() => {
    if (variant !== "primary") return undefined;

    function onHotkey(event: KeyboardEvent): void {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }
      if (disabled) return;

      const target = event.target as HTMLElement | null;

      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector('[aria-modal="true"]')) return;

      event.preventDefault();
      setOpen(true);
    }

    window.addEventListener("keydown", onHotkey);

    return () => window.removeEventListener("keydown", onHotkey);
  }, [variant, disabled]);

  const buttonClass =
    variant === "primary"
      ? "flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] bg-amber px-3 py-[11px] pl-3.5 font-sans text-[13.5px] font-semibold tracking-[-0.005em] text-white shadow-[0_8px_24px_-10px_var(--amber),0_1px_0_rgba(255,255,255,0.18)_inset] transition-[transform,box-shadow,background] hover:-translate-y-px hover:bg-amber-2"
      : variant === "rail"
        ? "inline-flex h-9 w-9 items-center justify-center rounded-[10px] bg-amber font-mono text-[18px] font-bold leading-none text-white shadow-[0_8px_24px_-12px_var(--amber),0_1px_0_rgba(255,255,255,0.18)_inset] transition-[transform,box-shadow,background] hover:-translate-y-px hover:bg-amber-2"
        : "inline-flex h-5 w-5 items-center justify-center rounded-md text-[13px] font-semibold text-mute hover:bg-ivory hover:text-amber";

  return (
    <>
      <button
        aria-label={title}
        className={clsx(
          buttonClass,
          disabled && "pointer-events-none opacity-60",
        )}
        disabled={disabled}
        title={title}
        type="button"
        onClick={() => setOpen(true)}
      >
        {variant === "primary" ? (
          <>
            <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[7px] bg-white/20 font-mono text-[14px] font-bold leading-none">
              +
            </span>
            <span className="flex-1 text-left">{label}</span>
            {shortcut}
          </>
        ) : (
          "+"
        )}
      </button>

      {open ? (
        <div
          aria-labelledby={titleId}
          aria-modal="true"
          className="fixed inset-0 z-[1000]"
          role="dialog"
        >
          <button
            aria-label={t("close")}
            className="absolute inset-0 cursor-default bg-paper-warm/80 backdrop-blur-[1px]"
            type="button"
            onClick={() => setOpen(false)}
          />
          <section className="absolute left-3 right-3 top-[72px] max-h-[calc(100vh-96px)] overflow-hidden rounded-[20px] border border-line bg-paper-warm shadow-[var(--shadow-lg)] md:left-[276px] md:right-auto md:w-[min(900px,calc(100vw-304px))]">
            <header className="flex items-center justify-between gap-3 border-b border-line bg-[color-mix(in_oklab,var(--paper)_82%,var(--ivory)_18%)] px-4 py-3">
              <div className="min-w-0 space-y-0.5">
                <h2
                  className="m-0 truncate text-[14px] font-semibold text-ink"
                  id={titleId}
                >
                  {title}
                </h2>
                {hint ? (
                  <p className="m-0 truncate text-[11.5px] text-mute">{hint}</p>
                ) : null}
              </div>
              <button
                aria-label={t("close")}
                className="font-mono text-[14px] text-mute hover:text-ink"
                type="button"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </header>
            <div className="max-h-[calc(100vh-153px)] overflow-y-auto p-3">
              <ScratchLauncher
                initialProjectId={projectId ?? null}
                onLaunched={(response) => {
                  setOpen(false);
                  router.push(
                    response.dialogUrl ?? `/scratch-runs/${response.runId}`,
                  );
                  router.refresh();
                }}
              />
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
