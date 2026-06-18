import type { AdapterSupport } from "@/lib/acp-runners/schema";
import type { ReactElement } from "react";
import type { SupervisorDiagnosticsStatus } from "@/lib/supervisor-client";

import { getTranslations } from "next-intl/server";

import { adapterSetupHint } from "@/lib/acp-runners/setup-hints";
import { PanelSection } from "@/components/settings/panel-section";

type Props = {
  adapters: readonly AdapterSupport[];
  diagnostics: SupervisorDiagnosticsStatus | null;
};

export async function AdapterSupportPanel({
  adapters,
  diagnostics,
}: Props): Promise<ReactElement> {
  const t = await getTranslations("settings");
  const adapterDiagnosticById = new Map(
    diagnostics?.kind === "ready"
      ? diagnostics.diagnostics.adapters.map((adapter) => [adapter.id, adapter])
      : [],
  );
  const diagnosticsUnavailable = diagnostics?.kind === "unavailable";

  return (
    <PanelSection title={t("adapterSupport")}>
      <div className="grid gap-2 md:grid-cols-2">
        {adapters.map((adapter) => {
          const diagnostic = adapterDiagnosticById.get(adapter.id);
          const isAvailable = diagnostic?.available === true;
          const tone = isAvailable
            ? "bg-good"
            : diagnostic
              ? "bg-attention"
              : "bg-mute";
          const stateLabel = diagnosticsUnavailable
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
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    aria-label={stateLabel}
                    className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${tone}`}
                    role="img"
                    title={stateLabel}
                  />
                  <h3 className="m-0 truncate text-[14px] font-semibold text-ink">
                    {adapter.id}
                  </h3>
                </div>
                <span className="shrink-0 font-mono text-[10.5px] text-mute">
                  {adapter.capabilityAgent}
                </span>
              </div>

              {!isAvailable ? (
                <p className="m-0 mt-2 text-[11.5px] leading-[1.5] text-mute">
                  {t(adapterSetupHint(adapter.id))}
                </p>
              ) : null}

              <details className="mt-2">
                <summary className="cursor-pointer list-none font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute hover:text-ink-2">
                  {t("adapterDetails")}
                </summary>
                <dl className="mt-2 grid gap-2 font-mono text-[11px] leading-[1.45]">
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
                </dl>
              </details>
            </article>
          );
        })}
      </div>
    </PanelSection>
  );
}
