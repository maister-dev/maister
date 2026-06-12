import type { FlowPackageView } from "@/lib/queries/flow-packages";
import type { ReactElement } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import clsx from "clsx";

import {
  InstallPackageModal,
  PackageActions,
  type PackageLabels,
} from "@/components/board/package-actions";

export interface FlowPackagesPanelProps {
  packages: FlowPackageView[];
  slug: string;
  isAdmin: boolean;
}

function trustTone(trust: string): string {
  if (trust === "untrusted") {
    return "border-amber-line bg-amber-soft text-amber";
  }

  return "border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))] bg-accent-4-soft text-accent-4";
}

export async function FlowPackagesPanel({
  packages,
  slug,
  isAdmin,
}: FlowPackagesPanelProps): Promise<ReactElement> {
  const t = await getTranslations("packages");

  const labels: PackageLabels = {
    install: t("install"),
    enable: t("enable"),
    disable: t("disable"),
    upgrade: t("upgrade"),
    rollback: t("rollback"),
    remove: t("remove"),
    trust: t("trust"),
    review: t("review"),
    cancel: t("cancel"),
    confirm: t("confirm"),
    sourceLabel: t("sourceLabel"),
    versionLabel: t("versionLabel"),
    revisionLabel: t("revisionLabel"),
    flowRefLabel: t("flowRefLabel"),
    installTitle: t("installTitle"),
    upgradeTitle: t("upgradeTitle"),
    previewTitle: t("previewTitle"),
    previewSteps: t("previewSteps"),
    previewGates: t("previewGates"),
    previewArtifacts: t("previewArtifacts"),
    previewCapabilities: t("previewCapabilities"),
    previewExternalOps: t("previewExternalOps"),
    previewSchemaChanged: t("previewSchemaChanged"),
    previewSetupChanged: t("previewSetupChanged"),
    previewAgents: t("previewAgents"),
    previewAgentWillStop: t("previewAgentWillStop"),
    previewAgentChanged: t("previewAgentChanged"),
    previewDroppedTriggers: t("previewDroppedTriggers"),
    added: t("added"),
    removed: t("removed"),
    errorGeneric: t("errorGeneric"),
  };

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {t("title")}
        </h2>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10.5px] tracking-[0.02em] text-mute">
            {t("installedCount", { count: packages.length })}
          </span>
          {isAdmin ? <InstallPackageModal labels={labels} slug={slug} /> : null}
        </div>
      </div>

      {packages.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute">
          {t("empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {packages.map((pkg) => {
            const rollbackTargets = pkg.installedRevisions
              .filter((r) => r.id !== pkg.enabledRevision?.id)
              .map((r) => ({
                id: r.id,
                versionLabel: r.versionLabel,
                resolvedRevision: r.resolvedRevision,
              }));

            return (
              <div
                key={pkg.flowRowId}
                className="relative rounded-xl border border-line bg-paper p-4 transition-[border-color] hover:border-mute"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
                  {/* Link wraps ONLY the ref so its accessible name is just the
                      package id; the stretched ::before still makes the whole
                      card clickable. Status badges are siblings, not part of the
                      link's accessible name (a11y — Reviewer pass). */}
                  <div className="inline-flex flex-wrap items-center gap-2">
                    <Link
                      className="font-mono text-[14px] font-bold text-ink before:absolute before:inset-0 before:rounded-xl before:content-['']"
                      href={`/projects/${slug}/packages/${pkg.ref}`}
                    >
                      {pkg.ref}
                    </Link>
                    <span
                      className={clsx(
                        "rounded-full border px-[7px] py-[3px] font-mono text-[9px] font-bold uppercase tracking-[0.08em]",
                        pkg.enablementState === "Disabled" ||
                          pkg.enablementState === "Failed"
                          ? "border-line bg-paper text-mute"
                          : "border-amber-line bg-amber-soft text-amber",
                      )}
                    >
                      {pkg.enablementState}
                    </span>
                    <span
                      className={clsx(
                        "rounded-full border px-[7px] py-[3px] font-mono text-[9px] font-bold uppercase tracking-[0.08em]",
                        trustTone(pkg.trustStatus),
                      )}
                    >
                      {pkg.trustStatus === "untrusted"
                        ? t("untrusted")
                        : pkg.trustStatus === "trusted_by_policy"
                          ? t("trustedByPolicy")
                          : t("trusted")}
                    </span>
                    {pkg.availableUpdate ? (
                      <span className="rounded-full border border-accent-2 bg-accent-2-soft px-[7px] py-[3px] font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-accent-2">
                        {t("updateAvailable")}{" "}
                        {pkg.availableUpdate.versionLabel}
                      </span>
                    ) : null}
                  </div>
                  {isAdmin ? (
                    <div
                      className="relative z-[1]"
                      data-testid="package-card-actions"
                    >
                      <PackageActions
                        availableUpdateRevisionId={
                          pkg.availableUpdate?.id ?? null
                        }
                        enablementState={pkg.enablementState}
                        flowRef={pkg.ref}
                        labels={labels}
                        rollbackTargets={rollbackTargets}
                        slug={slug}
                        trusted={pkg.trustStatus !== "untrusted"}
                      />
                    </div>
                  ) : null}
                </div>

                <div className="mb-2.5 font-mono text-[11px] leading-[1.5] text-mute">
                  {t("enabledRevision")}:{" "}
                  {pkg.enabledRevision ? (
                    <b className="font-semibold text-ink-2">
                      {pkg.enabledRevision.versionLabel} ·{" "}
                      {pkg.enabledRevision.resolvedRevision.slice(0, 12)}
                    </b>
                  ) : (
                    <span>{t("noEnabled")}</span>
                  )}
                </div>

                {pkg.compatWarning ? (
                  <div className="mb-2.5 rounded-lg border border-amber-line bg-amber-soft px-3 py-1.5 font-mono text-[10.5px] font-semibold text-amber">
                    {t("compatWarning")}: {pkg.compatWarning}
                  </div>
                ) : null}

                <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-dashed border-line-soft pt-2.5 font-mono text-[10px] tracking-[0.02em] text-mute md:grid-cols-3">
                  <span>
                    {t("setupScript")}:{" "}
                    <b className="font-semibold text-ink-2">
                      {pkg.hasSetupScript ? t("setupPresent") : t("setupNone")}
                    </b>
                  </span>
                  <span>
                    {t("capabilities")}:{" "}
                    <b className="font-semibold text-ink-2">
                      {pkg.enabledContract?.capabilities.join(", ") || "—"}
                    </b>
                  </span>
                  <span>
                    {t("artifacts")}:{" "}
                    <b className="font-semibold text-ink-2">
                      {pkg.enabledContract?.artifacts.join(", ") || "—"}
                    </b>
                  </span>
                  <span>
                    {t("installedRevisions")}:{" "}
                    <b className="font-semibold text-ink-2">
                      {pkg.installedRevisions.length}
                    </b>
                  </span>
                  <span>
                    {t("activeOldRuns", { count: pkg.activeRunsOnOldRevision })}
                  </span>
                  <span>
                    {t("projectsUsing", { count: pkg.projectsUsing })}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
