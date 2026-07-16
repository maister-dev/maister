import type {
  JudgePanelRow,
  MethodologyRow,
  ProfileRow,
} from "@/components/settings/evaluations/types";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { EvaluationsSettings } from "@/components/settings/evaluations/evaluations-settings";
import { requireGlobalRole } from "@/lib/authz";
import { listPanels, listProfiles } from "@/lib/evaluations/config";
import { listMethodologies } from "@/lib/evaluations/methods-registry";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settingsEvaluations");

  return { title: t("title") };
}

export default async function EvaluationsSettingsPage(): Promise<ReactElement> {
  await requireGlobalRole("admin");

  const t = await getTranslations("settingsEvaluations");
  const [methodologyRows, panelRows, profileRows] = await Promise.all([
    listMethodologies(),
    listPanels(),
    listProfiles(),
  ]);

  const methodologies: MethodologyRow[] = methodologyRows.map((m) => ({
    id: m.id,
    qualifiedId: m.qualifiedId,
    packageName: m.packageName,
    versionLabel: m.versionLabel,
    activation: m.activation,
    health: m.health,
    validationErrors: m.validationErrors ?? null,
    trustStatus: m.trustStatus,
  }));

  const panels: JudgePanelRow[] = panelRows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    revision: row.revision as number,
    roleBindings: (row.roleBindings ?? []) as JudgePanelRow["roleBindings"],
    policy: row.policy as JudgePanelRow["policy"],
    enabled: row.enabled as boolean,
  }));

  const profiles: ProfileRow[] = profileRows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    revision: row.revision as number,
    methodRevisionId: row.methodRevisionId as string,
    panelId: row.panelId as string,
    enabled: row.enabled as boolean,
  }));

  return (
    <div className="w-full px-6 py-8">
      <div className="mb-2">
        <Link
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-mute hover:text-ink"
          href="/settings"
        >
          <ArrowLeftIcon aria-hidden="true" className="h-3.5 w-3.5" />
          {t("backToSettings")}
        </Link>
      </div>
      <h1 className="m-0 text-[20px] font-semibold text-ink">{t("title")}</h1>
      <p className="mb-6 mt-1 max-w-[70ch] text-[13px] leading-[1.55] text-mute">
        {t("intro")}
      </p>

      <EvaluationsSettings
        methodologies={methodologies}
        panels={panels}
        profiles={profiles}
      />
    </div>
  );
}
