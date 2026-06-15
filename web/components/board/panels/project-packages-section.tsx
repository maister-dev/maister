"use client";

import type {
  AvailablePackageInstallView,
  ProjectPackageAttachmentView,
} from "@/lib/queries/packages";
import type { ReactElement } from "react";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type Props = {
  slug: string;
  isAdmin: boolean;
  // Trust fans out to every project attached to the install — global admin
  // only (the route enforces it; this prop only hides the button).
  canTrust: boolean;
  attachments: ProjectPackageAttachmentView[];
  availableInstalls: AvailablePackageInstallView[];
};

async function call(
  url: string,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<{ ok: boolean; message?: string; writeBack?: string }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await res.json().catch(() => null)) as {
    message?: string;
    code?: string;
    writeBack?: string;
  } | null;

  if (!res.ok) {
    return {
      ok: false,
      message:
        payload?.message ?? payload?.code ?? `Request failed: ${res.status}`,
    };
  }

  return { ok: true, writeBack: payload?.writeBack };
}

// (ADR-088) Whole-package attachments of a project: attach from the platform
// catalog, detach/upgrade/trust per attachment. Sits ABOVE the per-flow M10
// panel on the packages tab.
export function ProjectPackagesSection({
  slug,
  isAdmin,
  canTrust,
  attachments,
  availableInstalls,
}: Props): ReactElement {
  const t = useTranslations("packages");
  const tStudio = useTranslations("studio");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedInstall, setSelectedInstall] = useState("");

  const refresh = (): void => startTransition(() => router.refresh());
  const attachedNames = new Set(attachments.map((a) => a.packageName));
  const attachable = availableInstalls.filter(
    (i) => !attachedNames.has(i.name),
  );

  function surface(result: {
    ok: boolean;
    message?: string;
    writeBack?: string;
  }): void {
    if (!result.ok) setNotice(result.message ?? t("errorGeneric"));
    else if (result.writeBack === "failed")
      setNotice(t("attachWriteBackFailed"));
    else setNotice(null);
    refresh();
  }

  async function attach(): Promise<void> {
    if (!selectedInstall) return;
    setBusy("attach");
    surface(
      await call(`/api/projects/${slug}/packages`, "POST", {
        packageInstallId: selectedInstall,
      }),
    );
    setSelectedInstall("");
    setBusy(null);
  }

  async function detach(attachmentId: string): Promise<void> {
    setBusy(`detach:${attachmentId}`);
    surface(
      await call(`/api/projects/${slug}/packages/${attachmentId}`, "DELETE"),
    );
    setBusy(null);
  }

  async function upgrade(att: ProjectPackageAttachmentView): Promise<void> {
    const target = availableInstalls.find(
      (i) => i.name === att.packageName && i.id !== att.packageInstallId,
    );

    if (!target) return;
    setBusy(`upgrade:${att.id}`);
    surface(
      await call(`/api/projects/${slug}/packages/${att.id}/upgrade`, "POST", {
        packageInstallId: target.id,
      }),
    );
    setBusy(null);
  }

  async function trust(att: ProjectPackageAttachmentView): Promise<void> {
    setBusy(`trust:${att.id}`);
    surface(
      await call(`/api/projects/${slug}/packages/${att.id}/trust`, "POST"),
    );
    setBusy(null);
  }

  return (
    <section className="mb-6 rounded-[16px] border border-line bg-paper p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="m-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("attachmentsTitle")}
        </h3>
        {isAdmin && attachable.length > 0 ? (
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="attach-package-select">
              {t("attachPackage")}
            </label>
            <select
              className="h-9 rounded-[8px] border border-line bg-paper px-2 font-mono text-[12px] text-ink"
              id="attach-package-select"
              value={selectedInstall}
              onChange={(e) => setSelectedInstall(e.target.value)}
            >
              <option value="">{t("attachPick")}</option>
              {attachable.map((install) => (
                <option key={install.id} value={install.id}>
                  {install.name}@{install.versionLabel}
                </option>
              ))}
            </select>
            <button
              className="h-9 rounded-[8px] border border-amber bg-amber px-3 text-[12.5px] font-semibold text-white hover:bg-amber-2 disabled:opacity-50"
              disabled={busy === "attach" || !selectedInstall}
              type="button"
              onClick={attach}
            >
              {t("attachPackage")}
            </button>
          </div>
        ) : null}
      </div>

      {notice ? (
        <p
          className="mb-3 rounded-[8px] border border-amber/40 bg-amber/10 px-3 py-2 text-[12px] text-ink"
          role="alert"
        >
          {notice}
        </p>
      ) : null}

      {attachments.length === 0 ? (
        <p className="m-0 text-[12px] leading-[1.5] text-mute">
          {t("attachmentsEmpty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead className="border-b border-line bg-ivory">
              <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
                <th className="px-4 py-3">{t("attColPackage")}</th>
                <th className="px-4 py-3">{t("versionLabel")}</th>
                <th className="px-4 py-3">{t("attColTrust")}</th>
                <th className="px-4 py-3">{t("attColFlows")}</th>
                <th className="px-4 py-3 text-right">{t("attColActions")}</th>
              </tr>
            </thead>
            <tbody>
              {attachments.map((att) => {
                const upgradeTarget = availableInstalls.find(
                  (i) =>
                    i.name === att.packageName && i.id !== att.packageInstallId,
                );

                return (
                  <tr key={att.id} className="border-b border-line/60">
                    <td className="px-4 py-3 font-mono text-[12.5px] text-ink">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`/projects/${slug}/package-installs/${att.id}`}
                      >
                        {att.packageName}
                      </Link>
                      {att.updateAvailable ? (
                        <span className="ml-2 rounded-full border border-amber-line bg-amber-soft px-2 py-0.5 text-[10px] font-semibold text-amber">
                          {t("updateAvailable")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-ink">
                      {att.versionLabel}
                      <span className="block text-[10.5px] text-mute">
                        {att.resolvedRevision.slice(0, 12)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[12.5px] text-ink">
                      {att.trustStatus}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11.5px] text-mute">
                      {att.flows.join(", ")}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        <Link
                          className="inline-flex h-8 items-center rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink hover:bg-ivory"
                          href={`/studio/packages/${encodeURIComponent(att.packageName)}`}
                        >
                          {tStudio("openInStudio")}
                        </Link>
                        {isAdmin ? (
                          <div className="inline-flex gap-2">
                            {canTrust && att.trustStatus === "untrusted" ? (
                              <button
                                className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink hover:bg-ivory disabled:opacity-50"
                                disabled={busy === `trust:${att.id}`}
                                type="button"
                                onClick={() => trust(att)}
                              >
                                {t("trust")}
                              </button>
                            ) : null}
                            {upgradeTarget ? (
                              <button
                                className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink hover:bg-ivory disabled:opacity-50"
                                disabled={busy === `upgrade:${att.id}`}
                                type="button"
                                onClick={() => upgrade(att)}
                              >
                                {t("upgrade")} → {upgradeTarget.versionLabel}
                              </button>
                            ) : null}
                            <button
                              className="h-8 rounded-[8px] border border-red-500/40 px-3 text-[12px] font-semibold text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                              disabled={busy === `detach:${att.id}`}
                              type="button"
                              onClick={() => detach(att.id)}
                            >
                              {t("detach")}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
