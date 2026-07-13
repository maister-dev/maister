"use client";

import type {
  AvailablePackageInstallView,
  ProjectPackageAttachmentView,
} from "@/lib/queries/packages";
import type { ReactElement } from "react";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";

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
): Promise<{ ok: boolean; writeBack?: string }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await res.json().catch(() => null)) as {
    writeBack?: string;
  } | null;

  if (!res.ok) {
    return { ok: false };
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
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedInstall, setSelectedInstall] = useState("");
  const [trustingAttachment, setTrustingAttachment] =
    useState<ProjectPackageAttachmentView | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);

  const refresh = (): void => startTransition(() => router.refresh());
  const attachedNames = new Set(attachments.map((a) => a.packageName));
  const attachedInstallIds = new Set(
    attachments.map((a) => a.packageInstallId),
  );
  // ADR-132 §c: a local cut stays offered on a name collision (the explainer
  // below handles it); an upstream sibling of an attached name stays hidden —
  // that's the upgrade path, not the attach path.
  const attachable = availableInstalls.filter((i) =>
    i.sourceLocalPackageId
      ? !attachedInstallIds.has(i.id)
      : !attachedNames.has(i.name),
  );
  const selected = attachable.find((i) => i.id === selectedInstall);
  const nameCollision =
    selected !== undefined && attachedNames.has(selected.name);

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  function surface(result: { ok: boolean; writeBack?: string }): void {
    if (!result.ok) setNotice(t("errorGeneric"));
    else if (result.writeBack === "failed")
      setNotice(t("attachWriteBackFailed"));
    else setNotice(null);
    if (result.ok) refresh();
  }

  async function attach(): Promise<void> {
    if (!selectedInstall || nameCollision) return;
    setBusy("attach");
    try {
      const result = await call(`/api/projects/${slug}/packages`, "POST", {
        packageInstallId: selectedInstall,
      });

      surface(result);
      if (result.ok) setSelectedInstall("");
    } catch {
      surface({ ok: false });
    } finally {
      setBusy(null);
    }
  }

  async function detach(attachmentId: string): Promise<void> {
    setBusy(`detach:${attachmentId}`);
    try {
      surface(
        await call(`/api/projects/${slug}/packages/${attachmentId}`, "DELETE"),
      );
    } catch {
      surface({ ok: false });
    } finally {
      setBusy(null);
    }
  }

  // Both upgrade and downgrade flip the attachment pointer through the same
  // endpoint; the direction is decided server-side (att.upgradeTarget /
  // att.downgradeTargets), never by picking an arbitrary other install.
  async function switchVersion(
    att: ProjectPackageAttachmentView,
    targetInstallId: string,
  ): Promise<void> {
    if (!targetInstallId) return;
    setBusy(`switch:${att.id}`);
    try {
      surface(
        await call(`/api/projects/${slug}/packages/${att.id}/upgrade`, "POST", {
          packageInstallId: targetInstallId,
        }),
      );
    } catch {
      surface({ ok: false });
    } finally {
      setBusy(null);
    }
  }

  async function trust(att: ProjectPackageAttachmentView): Promise<void> {
    setBusy(`trust:${att.id}`);
    try {
      const result = await call(
        `/api/projects/${slug}/packages/${att.id}/trust`,
        "POST",
      );

      surface(result);
      if (result.ok) setTrustingAttachment(null);
    } catch {
      surface({ ok: false });
    } finally {
      setBusy(null);
    }
  }

  function confirmTrust(): void {
    if (trustingAttachment) void trust(trustingAttachment);
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
              aria-describedby="attach-package-compatibility"
              className="h-9 rounded-[8px] border border-line bg-paper px-2 font-mono text-[12px] text-ink"
              id="attach-package-select"
              value={selectedInstall}
              onChange={(e) => setSelectedInstall(e.target.value)}
            >
              <option value="">{t("attachPick")}</option>
              {attachable.map((install) => (
                <option
                  key={install.id}
                  disabled={!install.compatible}
                  value={install.id}
                >
                  {install.name}@{install.versionLabel}
                  {install.sourceLocalPackageId
                    ? ` · ${t("attachLocalCutBadge")}`
                    : ""}
                </option>
              ))}
            </select>
            <button
              className="h-9 rounded-[8px] border border-amber bg-amber px-3 text-[12.5px] font-semibold text-white hover:bg-amber-2 disabled:opacity-50"
              disabled={
                busy === "attach" ||
                !selectedInstall ||
                !selected?.compatible ||
                nameCollision
              }
              type="button"
              onClick={attach}
            >
              {t("attachPackage")}
            </button>
            <span className="sr-only" id="attach-package-compatibility">
              {attachable
                .filter((install) => !install.compatible)
                .map(
                  (install) =>
                    `${install.name}@${install.versionLabel}: ${install.incompatibilityReason}`,
                )
                .join("; ")}
            </span>
          </div>
        ) : null}
      </div>

      {nameCollision && selected ? (
        <p
          className="mb-3 rounded-[8px] border border-amber/40 bg-amber/10 px-3 py-2 text-[12px] text-ink"
          role="alert"
        >
          {t("attachNameTakenExplainer", { name: selected.name })}{" "}
          {selected.sourceLocalPackageId ? (
            <Link
              className="font-semibold underline underline-offset-2"
              href={`/studio/edit/${selected.sourceLocalPackageId}`}
            >
              {t("attachNameTakenEditorLink")}
            </Link>
          ) : null}
        </p>
      ) : null}

      {notice ? (
        <p
          ref={noticeRef}
          className="mb-3 rounded-[8px] border border-amber/40 bg-amber/10 px-3 py-2 text-[12px] text-ink"
          role="alert"
          tabIndex={-1}
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
                const upgradeTarget = att.upgradeTarget;

                return (
                  <tr key={att.id} className="border-b border-line/60">
                    <td className="px-4 py-3 font-mono text-[12.5px] text-ink">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`/studio/packages/${encodeURIComponent(att.packageName)}`}
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
                        {isAdmin ? (
                          <div className="inline-flex gap-2">
                            {canTrust && att.trustStatus === "untrusted" ? (
                              <button
                                className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink hover:bg-ivory disabled:opacity-50"
                                disabled={busy === `trust:${att.id}`}
                                type="button"
                                onClick={() => setTrustingAttachment(att)}
                              >
                                {t("trust")}
                              </button>
                            ) : null}
                            {upgradeTarget ? (
                              <button
                                className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink hover:bg-ivory disabled:opacity-50"
                                disabled={
                                  busy === `switch:${att.id}` ||
                                  !upgradeTarget.compatible
                                }
                                title={
                                  upgradeTarget.incompatibilityReason ??
                                  undefined
                                }
                                type="button"
                                onClick={() =>
                                  switchVersion(att, upgradeTarget.installId)
                                }
                              >
                                {t("upgrade")} → {upgradeTarget.versionLabel}
                              </button>
                            ) : null}
                            {att.downgradeTargets.length > 0 ? (
                              <select
                                aria-label={t("downgrade")}
                                className="h-8 rounded-[8px] border border-line bg-paper px-2 font-mono text-[12px] text-ink disabled:opacity-50"
                                disabled={busy === `switch:${att.id}`}
                                value=""
                                onChange={(e) =>
                                  switchVersion(att, e.target.value)
                                }
                              >
                                <option value="">{t("downgradePick")}</option>
                                {att.downgradeTargets.map((tgt) => (
                                  <option
                                    key={tgt.installId}
                                    disabled={!tgt.compatible}
                                    title={
                                      tgt.incompatibilityReason ?? undefined
                                    }
                                    value={tgt.installId}
                                  >
                                    {tgt.versionLabel}
                                  </option>
                                ))}
                              </select>
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
      {trustingAttachment ? (
        <ConfirmDialog
          body={t("trustConfirmBody", {
            count: trustingAttachment.affectedProjectCount ?? 0,
          })}
          busy={busy === `trust:${trustingAttachment.id}`}
          cancelLabel={t("trustCancel")}
          testId="package-trust-confirm"
          title={t("trustConfirmTitle")}
          titleId="package-trust-confirm-title"
          onClose={() => setTrustingAttachment(null)}
        >
          <div className="flex justify-end gap-2">
            <button
              className="h-8 rounded-[8px] border border-line px-3 text-[12px] text-mute hover:bg-ivory disabled:opacity-50"
              disabled={busy === `trust:${trustingAttachment.id}`}
              type="button"
              onClick={() => setTrustingAttachment(null)}
            >
              {t("trustCancel")}
            </button>
            <button
              className="h-8 rounded-[8px] border border-amber bg-amber px-3 text-[12px] font-semibold text-white disabled:opacity-50"
              data-testid="package-trust-confirm-submit"
              disabled={busy === `trust:${trustingAttachment.id}`}
              type="button"
              onClick={confirmTrust}
            >
              {t("trust")}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
