"use client";

import type { LocalPackageCutCompatibility } from "@/lib/local-packages/cut-compatibility";
import type { ReactElement } from "react";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ArchiveBoxArrowDownIcon,
  ArchiveBoxXMarkIcon,
  PencilSquareIcon,
  ScissorsIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";

import {
  CutVersionDialog,
  type CutAdoptTarget,
} from "@/components/studio/cut-version-dialog";
import {
  buildImportDialogLabels,
  ImportDialog,
} from "@/components/studio/import-dialog";
import { CreateFlowDialog } from "@/components/studio/create-flow-dialog";
import { useNewLocalPackage } from "@/components/studio/use-new-local-package";
import { readApiError } from "@/lib/api-error";
import { readCreateFlowApiError } from "@/lib/local-packages/create-flow-api-error";

// Client-safe local-package list item. `working_dir` and the lock session are
// server-only and intentionally absent (D1/D10); `isDefault`/`status` are flags.
// `adoptTargets` (ADR-132) = projects whose attachment points at a cut of this
// package — the cut dialog's multi-select; repo paths stay server-side.
export type LocalPackageListItem = {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  status: "active" | "archived";
  flowCount?: number;
  recoveryStatus?: "ready" | "recovering" | "recovery_required";
  recoveryKind?: "create_package_with_flow" | "add_flow";
  cutCompatibility: LocalPackageCutCompatibility;
  origin: LocalPackageOrigin;
  adoptTargets: CutAdoptTarget[];
};

export type LocalPackageOrigin =
  | { kind: "forked"; packageName: string; versionLabel: string }
  | { kind: "local" };

const ICON_BTN =
  "shrink-0 rounded-[9px] border border-line bg-ivory p-2 text-ink-2 transition-colors hover:border-amber hover:text-ink disabled:opacity-50";

export function LocalPackagesList({
  packages,
  canManage = true,
}: {
  packages: LocalPackageListItem[];
  canManage?: boolean;
}): ReactElement {
  const t = useTranslations("studio");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  // Create flow shared with the central /studio/packages list; `error`/`setError`
  // double as this list's row-action error channel.
  const { creating, setCreating, busy, error, setError, create } =
    useNewLocalPackage();
  const [notice, setNotice] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [cutDialogId, setCutDialogId] = useState<string | null>(null);

  const archivedCount = useMemo(
    () => packages.filter((pkg) => pkg.status === "archived").length,
    [packages],
  );
  const visible = packages.filter(
    (pkg) => pkg.status === "active" || showArchived,
  );

  // Runs a row-scoped mutating request, surfacing a translated error on failure.
  // Returns true on success so the caller can clear inline state + refresh.
  async function runRow(
    id: string,
    request: () => Promise<Response>,
  ): Promise<boolean> {
    setRowBusyId(id);
    setError(null);
    setNotice(null);

    try {
      const res = await request();

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return false;
      }

      return true;
    } catch {
      setError(tApiErrors("requestFailed"));

      return false;
    } finally {
      setRowBusyId(null);
    }
  }

  async function rename(id: string): Promise<void> {
    const trimmed = renameValue.trim();

    if (trimmed === "") return;

    const ok = await runRow(id, () =>
      fetch(`/api/studio/local-packages/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      }),
    );

    if (ok) {
      setRenamingId(null);
      router.refresh();
    }
  }

  async function setStatus(
    id: string,
    status: "active" | "archived",
  ): Promise<void> {
    const ok = await runRow(id, () =>
      fetch(`/api/studio/local-packages/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      }),
    );

    if (ok) router.refresh();
  }

  async function remove(id: string): Promise<void> {
    const ok = await runRow(id, () =>
      fetch(`/api/studio/local-packages/${id}`, { method: "DELETE" }),
    );

    if (ok) {
      setConfirmDeleteId(null);
      router.refresh();
    }
  }

  async function recoverInitialCreation(id: string): Promise<void> {
    setRowBusyId(id);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch(
        `/api/studio/local-packages/${id}/creation-recovery`,
        { method: "POST" },
      );

      if (!res.ok) {
        setError(
          await readCreateFlowApiError(res, tApiErrors, (key) =>
            t(`local.createFlow.${key}`),
          ),
        );
        return;
      }

      const recovered = (await res.json()) as {
        recoveryStatus: "ready" | "rolled_back";
      };

      if (recovered.recoveryStatus === "rolled_back") {
        router.push("/studio/packages?create=flow&recovery=rolled-back");
        return;
      }

      router.refresh();
    } catch {
      setError(tApiErrors("requestFailed"));
    } finally {
      setRowBusyId(null);
    }
  }

  // ADR-132 (T16): cutting goes through the dialog — it owns the POST and the
  // optional "adopt in attached projects now" multi-select.
  const cuttingPkg =
    cutDialogId === null
      ? null
      : (packages.find((pkg) => pkg.id === cutDialogId) ?? null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {canManage && creating ? (
          <CreateFlowDialog
            busy={busy}
            mode="new-package"
            requestError={error}
            onClose={() => {
              setCreating(false);
              setError(null);
            }}
            onSubmit={async (value) => {
              if (value.mode !== "new-package") return;
              await create({ name: value.name, flow: value.flow });
            }}
          />
        ) : canManage ? (
          <button
            className="rounded-[10px] border border-line bg-ivory px-3 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:border-amber"
            data-testid="local-new"
            type="button"
            onClick={() => setCreating(true)}
          >
            {t("local.newPackage")}
          </button>
        ) : null}
        {archivedCount > 0 ? (
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-[12px] text-ink-2">
            <input
              checked={showArchived}
              data-testid="local-show-archived"
              type="checkbox"
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            {t("local.showArchived").replace("$count", String(archivedCount))}
          </label>
        ) : null}
      </div>

      {error ? (
        <p
          className="rounded-[10px] border border-danger-line bg-danger-soft px-3 py-2 text-[12px] text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          className="rounded-[10px] border border-line bg-ivory px-3 py-2 text-[12px] text-ink-2"
          data-testid="local-notice"
          role="status"
        >
          {notice}
        </p>
      ) : null}

      {visible.length > 0 ? (
        <ul className="flex list-none flex-col gap-2" data-testid="local-list">
          {visible.map((pkg) => (
            <li
              key={pkg.id}
              className="flex items-stretch gap-2 rounded-[14px] border border-line bg-paper transition-colors hover:border-amber"
              data-archived={pkg.status === "archived" ? "true" : undefined}
            >
              {renamingId === pkg.id ? (
                <div className="flex flex-1 items-center gap-2 px-5 py-4">
                  <input
                    aria-label={t("local.rename")}
                    className="min-w-[200px] flex-1 rounded-[10px] border border-line bg-paper px-3 py-1.5 text-[14px] text-ink"
                    data-testid="local-rename-input"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void rename(pkg.id);
                      }
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                  />
                  <button
                    className="rounded-[10px] border border-amber bg-amber px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-amber-2 disabled:opacity-60"
                    data-testid="local-rename-save"
                    disabled={rowBusyId === pkg.id || renameValue.trim() === ""}
                    type="button"
                    onClick={() => void rename(pkg.id)}
                  >
                    {t("local.renameSave")}
                  </button>
                  <button
                    className="rounded-[10px] border border-line bg-paper px-3 py-1.5 text-[12px] text-mute hover:text-ink-2"
                    type="button"
                    onClick={() => setRenamingId(null)}
                  >
                    {t("local.cancel")}
                  </button>
                </div>
              ) : confirmDeleteId === pkg.id ? (
                <div
                  className="flex flex-1 flex-wrap items-center gap-3 px-5 py-4"
                  role="alertdialog"
                >
                  <span className="text-[13px] text-ink">
                    {t("local.deleteConfirm").replace("$name", pkg.name)}
                  </span>
                  <span className="ml-auto flex gap-2">
                    <button
                      className="rounded-[10px] border border-danger-line bg-danger-soft px-3 py-1.5 text-[12px] font-semibold text-danger hover:bg-danger-soft disabled:opacity-60"
                      data-testid="local-delete-confirm"
                      disabled={rowBusyId === pkg.id}
                      type="button"
                      onClick={() => void remove(pkg.id)}
                    >
                      {t("local.deleteConfirmYes")}
                    </button>
                    <button
                      className="rounded-[10px] border border-line bg-paper px-3 py-1.5 text-[12px] text-mute hover:text-ink-2"
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      {t("local.cancel")}
                    </button>
                  </span>
                </div>
              ) : (
                <>
                  <Link
                    className="flex flex-1 flex-col gap-1.5 px-5 py-4"
                    href={`/studio/edit/${pkg.id}`}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[15px] font-semibold text-ink">
                        {pkg.name}
                      </span>
                      {pkg.isDefault ? (
                        <span className="rounded-full border border-amber-line bg-amber-soft px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-amber">
                          {t("local.defaultBadge")}
                        </span>
                      ) : null}
                      {pkg.status === "archived" ? (
                        <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
                          {t("local.archivedBadge")}
                        </span>
                      ) : null}
                      {(pkg.recoveryStatus ?? "ready") !== "ready" ? (
                        <span className="rounded-full border border-danger-line bg-danger-soft px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-danger">
                          {t("local.createFlow.recoveryRequired")}
                        </span>
                      ) : null}
                      <span className="ml-auto truncate font-mono text-[11.5px] text-mute">
                        {pkg.slug}
                      </span>
                    </span>
                    <span className="font-mono text-[11.5px] leading-[1.35] text-mute">
                      {localPackageOriginLabel(pkg.origin, t)}
                    </span>
                    <span className="font-mono text-[11px] leading-[1.35] text-mute">
                      {t("viewer.tabFlows")} · {pkg.flowCount ?? 0}
                    </span>
                    {!pkg.cutCompatibility.compatible ? (
                      <span
                        className="font-mono text-[11px] leading-[1.35] text-danger"
                        data-testid="local-cut-incompatible"
                        id={`local-cut-incompatibility-${pkg.id}`}
                      >
                        {pkg.cutCompatibility.incompatibilityReason}
                      </span>
                    ) : null}
                  </Link>
                  {canManage ? (
                    <div className="flex items-center gap-1.5 px-2 py-2">
                      <button
                        className="rounded-[9px] border border-line bg-ivory px-2.5 py-1.5 text-[12px] font-semibold text-ink transition-colors hover:border-amber"
                        data-testid="local-import"
                        disabled={
                          rowBusyId === pkg.id ||
                          (pkg.recoveryStatus ?? "ready") !== "ready"
                        }
                        type="button"
                        onClick={() => setImportingId(pkg.id)}
                      >
                        ⤓ {t("import.action")}
                      </button>
                      {pkg.recoveryKind === "create_package_with_flow" ? (
                        <button
                          className="rounded-[9px] border border-danger-line bg-danger-soft px-2.5 py-1.5 text-[12px] font-semibold text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
                          data-testid="local-recover-creation"
                          disabled={rowBusyId === pkg.id}
                          type="button"
                          onClick={() => void recoverInitialCreation(pkg.id)}
                        >
                          {t("local.createFlow.recover")}
                        </button>
                      ) : null}
                      <button
                        aria-label={t("local.rename")}
                        className={ICON_BTN}
                        data-testid="local-rename"
                        disabled={
                          rowBusyId === pkg.id ||
                          (pkg.recoveryStatus ?? "ready") !== "ready"
                        }
                        title={t("local.rename")}
                        type="button"
                        onClick={() => {
                          setRenamingId(pkg.id);
                          setRenameValue(pkg.name);
                        }}
                      >
                        <PencilSquareIcon className="h-4 w-4" />
                      </button>
                      <button
                        aria-describedby={
                          pkg.cutCompatibility.compatible
                            ? undefined
                            : `local-cut-incompatibility-${pkg.id}`
                        }
                        aria-label={t("local.cutVersion")}
                        className={ICON_BTN}
                        data-testid="local-cut"
                        disabled={
                          rowBusyId === pkg.id ||
                          !pkg.cutCompatibility.compatible ||
                          (pkg.recoveryStatus ?? "ready") !== "ready"
                        }
                        title={
                          pkg.cutCompatibility.incompatibilityReason ??
                          t("local.cutVersion")
                        }
                        type="button"
                        onClick={() => setCutDialogId(pkg.id)}
                      >
                        <ScissorsIcon className="h-4 w-4" />
                      </button>
                      {pkg.status === "active" ? (
                        <button
                          aria-label={t("local.archive")}
                          className={ICON_BTN}
                          data-testid="local-archive"
                          disabled={
                            rowBusyId === pkg.id ||
                            (pkg.recoveryStatus ?? "ready") !== "ready"
                          }
                          title={t("local.archive")}
                          type="button"
                          onClick={() => void setStatus(pkg.id, "archived")}
                        >
                          <ArchiveBoxArrowDownIcon className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          aria-label={t("local.unarchive")}
                          className={ICON_BTN}
                          data-testid="local-unarchive"
                          disabled={
                            rowBusyId === pkg.id ||
                            (pkg.recoveryStatus ?? "ready") !== "ready"
                          }
                          title={t("local.unarchive")}
                          type="button"
                          onClick={() => void setStatus(pkg.id, "active")}
                        >
                          <ArchiveBoxXMarkIcon className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        aria-label={t("local.delete")}
                        className="shrink-0 rounded-[9px] border border-danger-line bg-ivory p-2 text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
                        data-testid="local-delete"
                        disabled={
                          rowBusyId === pkg.id ||
                          (pkg.recoveryStatus ?? "ready") !== "ready"
                        }
                        title={t("local.delete")}
                        type="button"
                        onClick={() => setConfirmDeleteId(pkg.id)}
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-mute">{t("local.empty")}</p>
      )}

      {importingId ? (
        <ImportDialog
          labels={buildImportDialogLabels(t)}
          packageId={importingId}
          onClose={() => setImportingId(null)}
          onImported={() => router.refresh()}
        />
      ) : null}
      {cuttingPkg ? (
        <CutVersionDialog
          adoptTargets={cuttingPkg.adoptTargets}
          packageId={cuttingPkg.id}
          packageName={cuttingPkg.name}
          onClose={() => {
            setCutDialogId(null);
            router.refresh();
          }}
          onCut={(label) =>
            setNotice(t("local.cutVersionDone").replace("$label", label))
          }
        />
      ) : null}
    </div>
  );
}

function localPackageOriginLabel(
  origin: LocalPackageOrigin,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  if (origin.kind === "forked") {
    return t("local.originForked", {
      name: origin.packageName,
      version: origin.versionLabel,
    });
  }

  return t("local.originLocal");
}
