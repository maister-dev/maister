import type { AdapterId, AdapterSupport } from "@/lib/acp-runners/schema";
import type { ReactElement } from "react";
import type { SupervisorDiagnosticsStatus } from "@/lib/supervisor-client";

import { getTranslations } from "next-intl/server";

import { PanelSection } from "@/components/settings/panel-section";

type Runner = {
  id: string;
  adapter: AdapterId;
};

type Props = {
  adapters: readonly AdapterSupport[];
  diagnostics: SupervisorDiagnosticsStatus | null;
  runners: Runner[];
};

export async function AdapterSupportPanel({
  adapters,
  diagnostics,
  runners,
}: Props): Promise<ReactElement> {
  const t = await getTranslations("settings");
  const adapterDiagnosticById = new Map(
    diagnostics?.kind === "ready"
      ? diagnostics.diagnostics.adapters.map((adapter) => [adapter.id, adapter])
      : [],
  );

  return (
    <PanelSection title={t("adapterSupport")}>
      <div className="grid gap-2">
        {adapters.map((adapter) => {
          const usedBy = runners
            .filter((runner) => runner.adapter === adapter.id)
            .map((runner) => runner.id);
          const diagnostic = adapterDiagnosticById.get(adapter.id);
          const binaryState =
            diagnostics?.kind === "unavailable"
              ? `${t("diagnosticsUnavailable")}: ${diagnostics.reason}`
              : diagnostic
                ? diagnostic.available
                  ? t("available")
                  : t("unavailable")
                : t("unknown");

          return (
            <article
              key={adapter.id}
              className="rounded-[8px] border border-line bg-canvas px-4 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="m-0 text-[14px] font-semibold text-ink">
                    {adapter.id}
                  </h3>
                  <p className="m-0 mt-1 font-mono text-[11px] leading-[1.45] text-mute">
                    {t("capability")}: {adapter.capabilityAgent}
                  </p>
                </div>
                <span className="rounded-full border border-line px-2 py-1 text-[11px] font-semibold text-mute">
                  {binaryState}
                </span>
              </div>
              <dl className="mt-3 grid gap-2 font-mono text-[11px] leading-[1.45]">
                <div>
                  <dt className="text-mute">{t("binary")}</dt>
                  <dd className="m-0 text-ink">
                    {diagnostic?.binary ?? adapter.id}
                  </dd>
                </div>
                <div>
                  <dt className="text-mute">{t("providers")}</dt>
                  <dd className="m-0 text-ink">
                    {adapter.providerKinds.join(", ")}
                  </dd>
                </div>
                <div>
                  <dt className="text-mute">{t("permissionPolicies")}</dt>
                  <dd className="m-0 text-ink">
                    {adapter.permissionPolicies.join(", ")}
                  </dd>
                </div>
                <div>
                  <dt className="text-mute">{t("runners")}</dt>
                  <dd className="m-0 text-ink">
                    {usedBy.length > 0 ? usedBy.join(", ") : "-"}
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
    </PanelSection>
  );
}
