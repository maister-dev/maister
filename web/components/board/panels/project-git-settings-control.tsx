"use client";

import type { ReactElement } from "react";

import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { readApiError } from "@/lib/api-error";

export interface RemoteItem {
  name: string;
  url: string;
}

export interface ProjectGitSettingsControlProps {
  projectSlug: string;
  mainBranch: string;
  remotes: RemoteItem[];
  needsPersist: boolean;
}

type Modal = null | { mode: "add" } | { mode: "manage"; remote: RemoteItem };

export function ProjectGitSettingsControl(
  props: ProjectGitSettingsControlProps,
): ReactElement {
  const t = useTranslations("projects");
  const tErr = useTranslations("apiErrors");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const refresh = (): void => startTransition(() => router.refresh());

  const [modal, setModal] = useState<Modal>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [push, setPush] = useState(false);
  const [persistNote, setPersistNote] = useState<string | null>(null);

  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (modal === null) return;
    firstFieldRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setModal(null);
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  function openAdd(): void {
    setName("");
    setUrl("");
    setError(null);
    setModal({ mode: "add" });
  }

  function openManage(remote: RemoteItem): void {
    setName(remote.name);
    setUrl(remote.url);
    setError(null);
    setModal({ mode: "manage", remote });
  }

  // Returns the parsed body on success, or null on a handled error.
  async function callRemotes(
    method: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${props.projectSlug}/remotes`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        setError(await readApiError(res, tErr));
        setPending(false);

        return null;
      }
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      setPending(false);

      return data;
    } catch {
      setError(t("git.error"));
      setPending(false);

      return null;
    }
  }

  async function submitAdd(): Promise<void> {
    if ((await callRemotes("POST", { name, url })) !== null) {
      setModal(null);
      refresh();
    }
  }

  async function submitSetUrl(remote: RemoteItem): Promise<void> {
    if ((await callRemotes("PATCH", { name: remote.name, url })) !== null) {
      setModal(null);
      refresh();
    }
  }

  async function removeRemote(remote: RemoteItem): Promise<void> {
    if ((await callRemotes("DELETE", { name: remote.name })) !== null) {
      setModal(null);
      refresh();
    }
  }

  async function action(
    remote: RemoteItem,
    op: "push" | "fetch",
  ): Promise<void> {
    const data = await callRemotes("POST", {
      op,
      name: remote.name,
      ...(op === "push" ? { branch: props.mainBranch } : {}),
    });

    if (data === null) return;
    // A non-fatal advisory surfaces inline; the action itself succeeded (200).
    if (typeof data.warning === "string") {
      setError(data.warning);
    } else {
      setModal(null);
      refresh();
    }
  }

  async function persist(): Promise<void> {
    setPending(true);
    setPersistNote(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${props.projectSlug}/persist-config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ push }),
        },
      );

      if (!res.ok) {
        setError(await readApiError(res, tErr));
        setPending(false);

        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        usedDefaultAuthor?: boolean;
        pushWarning?: string;
      };
      const notes: string[] = [];

      if (data.usedDefaultAuthor) {
        notes.push(t("persistBanner.usedDefaultAuthor"));
      }
      if (data.pushWarning) {
        notes.push(
          t("persistBanner.pushWarning", { detail: data.pushWarning }),
        );
      }
      setPersistNote(
        notes.length > 0 ? notes.join(" ") : t("persistBanner.doneTitle"),
      );
      setPending(false);
      refresh();
    } catch {
      setError(t("git.error"));
      setPending(false);
    }
  }

  return (
    <div className="mb-5 rounded-xl border border-line bg-paper p-[18px]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="m-0 text-[13px] font-semibold tracking-[-0.005em] text-ink">
            {t("git.remotesTitle")}
          </h3>
          <p className="mt-[3px] font-mono text-[10.5px] tracking-[0.02em] text-mute">
            {t("git.remotesDesc")}
          </p>
        </div>
        <button
          className="rounded-lg bg-amber px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-amber-2"
          type="button"
          onClick={openAdd}
        >
          {t("git.addRemote")}
        </button>
      </div>

      {props.needsPersist ? (
        <div className="mb-3 rounded-lg border border-amber-line bg-amber-soft p-3 text-[12.5px] text-ink">
          <div className="font-semibold">{t("git.persistTitle")}</div>
          <p className="mt-1 text-mute">{t("git.persistDesc")}</p>
          <label className="mt-2 flex items-center gap-2 text-ink-2">
            <input
              checked={push}
              type="checkbox"
              onChange={(e) => setPush(e.target.checked)}
            />
            {t("persistBanner.alsoPush")}
          </label>
          {persistNote ? (
            <p className="mt-2 text-mute" role="status">
              {persistNote}
            </p>
          ) : null}
          <button
            className="mt-2 rounded-lg bg-amber px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-amber-2 disabled:opacity-60"
            disabled={pending}
            type="button"
            onClick={() => void persist()}
          >
            {pending ? t("persistBanner.pending") : t("git.persist")}
          </button>
        </div>
      ) : null}

      {props.remotes.length === 0 ? (
        <p className="font-mono text-[11.5px] text-mute">{t("git.empty")}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-line/40 text-left text-mute">
                <th className="px-3 py-2 font-semibold">{t("git.colName")}</th>
                <th className="px-3 py-2 font-semibold">{t("git.colUrl")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {props.remotes.map((remote) => (
                <tr key={remote.name} className="border-t border-line">
                  <td className="px-3 py-2 font-mono font-semibold text-ink">
                    {remote.name}
                  </td>
                  <td className="break-all px-3 py-2 font-mono text-ink-2">
                    {remote.url}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      className="rounded-md border border-line px-2 py-1 text-[11.5px] font-medium text-ink-2 hover:bg-line/40"
                      type="button"
                      onClick={() => openManage(remote)}
                    >
                      {t("git.manage")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* role="dialog" belongs on the panel, not the backdrop; close via
              Escape (window listener) + Cancel — no backdrop-click handler so
              the overlay stays a11y-clean (no listener on a non-interactive el). */}
          <div
            aria-labelledby="git-remote-modal-title"
            aria-modal="true"
            className="w-full max-w-[480px] rounded-xl border border-line bg-paper p-5 text-[13px] text-ink shadow-xl"
            role="dialog"
          >
            <h4
              className="m-0 mb-3 text-[14px] font-semibold"
              id="git-remote-modal-title"
            >
              {modal.mode === "add" ? t("git.addTitle") : t("git.manageTitle")}
            </h4>

            {modal.mode === "add" ? (
              <label className="mb-3 block">
                <span className="mb-1 block text-[12px] text-ink-2">
                  {t("git.nameLabel")}
                </span>
                <input
                  ref={firstFieldRef}
                  className="w-full rounded-lg border border-line bg-ivory px-3 py-2 font-mono text-[12.5px]"
                  placeholder="origin"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            ) : (
              <div className="mb-3 font-mono text-[12.5px] text-ink-2">
                {modal.remote.name}
              </div>
            )}

            <label className="mb-3 block">
              <span className="mb-1 block text-[12px] text-ink-2">
                {t("git.urlLabel")}
              </span>
              <input
                ref={modal.mode === "add" ? undefined : firstFieldRef}
                className="w-full rounded-lg border border-line bg-ivory px-3 py-2 font-mono text-[12.5px]"
                placeholder="git@github.com:org/app.git"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>

            {error ? (
              <p className="mb-3 text-[12px] text-danger" role="alert">
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2">
                {modal.mode === "add" ? (
                  <button
                    className="rounded-lg bg-amber px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-amber-2 disabled:opacity-60"
                    disabled={pending}
                    type="button"
                    onClick={() => void submitAdd()}
                  >
                    {pending ? t("git.pending") : t("git.addRemote")}
                  </button>
                ) : (
                  <button
                    className="rounded-lg bg-amber px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-amber-2 disabled:opacity-60"
                    disabled={pending}
                    type="button"
                    onClick={() => void submitSetUrl(modal.remote)}
                  >
                    {pending ? t("git.pending") : t("git.save")}
                  </button>
                )}
                <button
                  className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-line/40"
                  type="button"
                  onClick={() => setModal(null)}
                >
                  {t("git.cancel")}
                </button>
              </div>

              {modal.mode === "manage" ? (
                <div className="flex gap-2">
                  <button
                    className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-line/40 disabled:opacity-60"
                    disabled={pending}
                    type="button"
                    onClick={() => void action(modal.remote, "fetch")}
                  >
                    {t("git.fetch")}
                  </button>
                  <button
                    className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-line/40 disabled:opacity-60"
                    disabled={pending}
                    type="button"
                    onClick={() => void action(modal.remote, "push")}
                  >
                    {t("git.push")}
                  </button>
                  <button
                    className="rounded-lg border border-danger/40 px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/10 disabled:opacity-60"
                    disabled={pending}
                    type="button"
                    onClick={() => void removeRemote(modal.remote)}
                  >
                    {t("git.remove")}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
