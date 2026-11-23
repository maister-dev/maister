import type { ReactElement } from "react";
import type { KnowledgePageQuery } from "@/lib/brain/knowledge-page-query";
import type { MemoryPromotionTarget } from "@/components/agents/agent-memory-promotion";

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { AgentMemoryControl } from "@/components/agents/agent-memory-control";
import { LegacyMemoryReader } from "@/components/agents/legacy-memory-reader";
import {
  KnowledgeHeader,
  knowledgePanelClass,
} from "@/components/brain/knowledge-view";
import {
  getHumanVaultLocation,
  listHumanVaultLocations,
  listHumanVaultOwners,
  parseHumanVaultSelection,
} from "@/lib/agent-memory-vault/human-catalog";
import { requireActiveSession } from "@/lib/authz";
import { knowledgePageParams } from "@/lib/brain/knowledge-page-query";
import { knowledgeOwnerChoices } from "@/lib/brain/knowledge-ui";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";

export default async function AgentMemoryPage({
  searchParams,
}: {
  searchParams: Promise<KnowledgePageQuery>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const t = await getTranslations("knowledge");
  const params = knowledgePageParams(await searchParams);
  const selection = new URLSearchParams();

  for (const key of ["projectId", "companyId", "agentId", "cursor"]) {
    const value = params.get(key);

    if (value !== null) selection.set(key, value);
  }
  const owner = params.get("owner");

  if (owner?.startsWith("project:")) selection.set("projectId", owner.slice(8));
  if (owner?.startsWith("installation:"))
    selection.set("companyId", owner.slice(13));
  const locationId = params.get("locationId");
  const db = getDb();
  const catalogHref = () => `/knowledge/memory?${selection}`;
  const catalog = parseHumanVaultSelection(selection);
  const [page, catalogOwners] = await Promise.all([
    listHumanVaultLocations(db, user.id, catalog),
    listHumanVaultOwners(db, user.id, catalog.agentId),
  ]);
  const location = locationId
    ? await getHumanVaultLocation(db, user.id, locationId).catch(
        (error: unknown) => {
          if (
            isMaisterError(error) &&
            ["CONFIG", "PRECONDITION"].includes(error.code)
          )
            notFound();
          throw error;
        },
      )
    : null;
  const browserLocation =
    location?.ownerKind === "project" && location.projectSlug
      ? {
          kind: "project" as const,
          slug: location.projectSlug,
          projectId: location.owner.id,
        }
      : location?.ownerKind === "installation"
        ? {
            kind: "installation" as const,
            companyId: location.owner.id,
            bindingId: location.bindingId,
          }
        : null;
  const projectAgentHref = location?.projectSlug
    ? `/projects/${encodeURIComponent(location.projectSlug)}/agents/${encodeURIComponent(location.agentId)}`
    : null;
  const settingsHref =
    location?.ownerKind === "installation"
      ? `/settings/specialists?binding=${encodeURIComponent(location.bindingId)}`
      : projectAgentHref
        ? `${projectAgentHref}?tab=settings`
        : null;
  const nextSelection = new URLSearchParams(selection);
  const promotionTargets: MemoryPromotionTarget[] = [];

  if (location?.allowedActions.includes("edit")) {
    const owners = await knowledgeOwnerChoices(
      db,
      { kind: "user", userId: user.id },
      "knowledge:propose",
    );

    for (const { owner, projectName } of owners) {
      const ownerId =
        owner.kind === "project" ? owner.projectId : owner.companyId;
      const label = projectName ?? t("company");

      promotionTargets.push({
        kind: "knowledge",
        ownerKind: owner.kind,
        ownerId,
        label,
      });
      if (
        owner.kind === "project" &&
        (location.ownerKind === "installation" || location.owner.id === ownerId)
      )
        promotionTargets.push({
          kind: "brain",
          ownerKind: "project",
          ownerId,
          label,
        });
    }
  }

  if (page.nextCursor) nextSelection.set("cursor", page.nextCursor);

  return (
    <>
      <KnowledgeHeader title={t("agentMemory")} />
      <p className="mb-4 text-sm text-mute">{t("personalMemoryLocation")}</p>
      {!location ? (
        <form className="mb-4 flex flex-wrap items-end gap-2" method="get">
          {catalog.agentId ? (
            <input name="agentId" type="hidden" value={catalog.agentId} />
          ) : null}
          <label className="grid text-sm">
            {t("owner")}
            <select
              className="rounded-lg border border-line bg-paper p-2"
              defaultValue={
                catalog.projectId
                  ? `project:${catalog.projectId}`
                  : catalog.companyId
                    ? `installation:${catalog.companyId}`
                    : ""
              }
              name="owner"
            >
              <option value="">{t("allAccessible")}</option>
              {catalogOwners.map(({ kind, owner_id, owner_label }) => (
                <option
                  key={`${kind}:${owner_id}`}
                  value={`${kind}:${owner_id}`}
                >
                  {kind === "installation" ? t("company") : owner_label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="rounded-lg border border-line px-3 py-2 text-sm"
            type="submit"
          >
            {t("searchAction")}
          </button>
        </form>
      ) : null}
      {location && browserLocation ? (
        <section className="space-y-4">
          <nav className="flex flex-wrap gap-4 text-sm">
            <Link className="underline" href={catalogHref()}>
              {t("backToVaults")}
            </Link>
            {settingsHref && location.allowedActions.includes("settings") ? (
              <Link className="underline" href={settingsHref}>
                {t("vaultSettings")}
              </Link>
            ) : null}
          </nav>
          <div className={knowledgePanelClass}>
            <h2 className="font-semibold">{location.agentName}</h2>
            <p>
              {location.ownerKind === "installation"
                ? t("installationVault")
                : location.owner.label}
            </p>
            <p role="status">{t(`vaultState.${location.state}`)}</p>
            {projectAgentHref &&
            location.allowedActions.includes("legacy_read") ? (
              <LegacyMemoryReader endpoint={`/api${projectAgentHref}/memory`} />
            ) : null}
          </div>
          {location.allowedActions.includes("view") ? (
            <AgentMemoryControl
              agentId={location.agentId}
              canEdit={location.allowedActions.includes("edit")}
              canRedact={user.role === "admin"}
              location={browserLocation}
              navigation={{ locationId: location.locationId }}
              promotionTargets={promotionTargets}
            />
          ) : null}
        </section>
      ) : page.items.length ? (
        <ul className="divide-y divide-line rounded-xl border border-line bg-paper">
          {page.items.map((item) => {
            const selected = new URLSearchParams(selection);

            selected.set("locationId", item.locationId);

            return (
              <li
                key={item.locationId}
                className="flex flex-wrap items-center justify-between gap-2 p-4"
              >
                <div>
                  <Link
                    className="font-semibold underline"
                    href={`/knowledge/memory?${selected}`}
                  >
                    {item.agentName}
                  </Link>
                  <div className="text-xs text-mute">{item.agentId}</div>
                </div>
                <p className="text-sm">
                  {item.ownerKind === "installation"
                    ? t("installationVault")
                    : item.owner.label}
                </p>
                <p className="text-sm text-mute">
                  {t(`vaultState.${item.state}`)}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={knowledgePanelClass} role="status">
          {t("noVaults")}
        </p>
      )}
      {!location && page.nextCursor ? (
        <Link
          className="mt-4 inline-block underline"
          href={`/knowledge/memory?${nextSelection}`}
        >
          {t("next")}
        </Link>
      ) : null}
    </>
  );
}
