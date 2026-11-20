import type { ReactElement } from "react";

import { sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AgentMemoryControl } from "@/components/agents/agent-memory-control";
import { BindingReviewForm } from "@/components/specialist-assignments/binding-review-form";
import {
  DisableStandInspection,
  StandInspectionScheduleForm,
} from "@/components/specialist-assignments/stand-inspection-schedule-form";
import { listCompanySpecialists } from "@/lib/agents/company-binding-list";
import { getCompanySpecialistBindingRevision } from "@/lib/agents/company-bindings";
import { getCompanyFlowBindingRevision } from "@/lib/agents/company-flow-bindings";
import { requireActiveSession } from "@/lib/authz";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { installationCompany } from "@/lib/company/grants";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";

export default async function SpecialistsSettings({
  searchParams,
}: {
  searchParams: Promise<{
    binding?: string;
    revision?: string;
    kind?: string;
    tab?: string;
    edit?: string;
  }>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const t = await getTranslations("specialistAssignments");

  const query = await searchParams;
  const { page, flows, snapshot, companyId, canManage, kind, selected } =
    await readSettings(user.id, query);
  const installation =
    selected?.installationGrant && selected.detachedAt === null
      ? selected
      : null;
  const canGrantInstallation = canManage && user.role === "admin";
  const installationCandidate =
    canGrantInstallation &&
    selected?.detachedAt === null &&
    selected.workspace === "none" &&
    selected.coordinatorFlowRevisionId === null
      ? selected
      : null;

  const inspectors = canManage
    ? page.items.filter(
        (item) =>
          item.enabled &&
          !item.installationGrant &&
          item.kind === "operational" &&
          item.targetClasses.includes("stand") &&
          item.grantActions.includes("targets:read") &&
          !item.grantActions.includes("targets:restart") &&
          item.coordinatorFlowRevisionId === null,
      )
    : [];
  const schedules = canManage
    ? await readInspectionSchedules(user.id, companyId)
    : [];
  const components = inspectors.length
    ? await readInspectionComponents(user.id, companyId)
    : [];

  return (
    <section className="mx-auto w-full max-w-4xl space-y-5">
      <h1 className="text-2xl font-semibold">{t("settingsTitle")}</h1>
      <div className="grid gap-3 rounded-xl border border-line bg-paper p-5 text-sm sm:grid-cols-2">
        <ul className="space-y-2">
          {page.items.map((item) => (
            <li key={item.bindingId}>
              <a
                className="underline"
                href={`?binding=${encodeURIComponent(item.bindingId)}`}
              >
                {item.name}
              </a>
              <span className="ml-2 text-mute">
                {t("revision")} {item.configRevision}
              </span>
            </li>
          ))}
        </ul>
        <ul className="space-y-2">
          {flows.map((flow) => (
            <li key={flow.id}>
              <a
                className="underline"
                href={`?kind=coordinator&binding=${encodeURIComponent(flow.id)}`}
              >
                {flow.flow_ref_id}
              </a>
              <span className="ml-2 text-mute">
                {t("revision")} {flow.revision}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {selected && (installation || installationCandidate) ? (
        <nav aria-label={t("installationGrant")} className="flex gap-4 text-sm">
          <a
            className="underline"
            href={`?binding=${encodeURIComponent(selected.bindingId)}`}
          >
            {t("configuration")}
          </a>
          {installation?.installationGrant?.memoryEnabled ? (
            <a
              className="underline"
              href={`?binding=${encodeURIComponent(installation.bindingId)}&tab=memory`}
            >
              {t("installationMemory")}
            </a>
          ) : null}
          {installationCandidate ? (
            <a
              className="underline"
              href={`?binding=${encodeURIComponent(installationCandidate.bindingId)}&edit=installation`}
            >
              {t("editInstallationBinding")}
            </a>
          ) : null}
        </nav>
      ) : null}
      {installation &&
      query.tab === "memory" &&
      installation.installationGrant?.memoryEnabled ? (
        <AgentMemoryControl
          agentId={installation.id}
          canEdit={user.role === "admin"}
          canRedact={user.role === "admin"}
          location={{
            kind: "installation",
            companyId,
            bindingId: installation.bindingId,
          }}
        />
      ) : null}
      {installationCandidate && query.edit === "installation" ? (
        <BindingReviewForm
          key={installationCandidate.configRevision}
          canGrantInstallation
          bindingKind="specialist"
          companyId={companyId}
          editing={{
            agentId: installationCandidate.id,
            bindingId: installationCandidate.bindingId,
            revision: installationCandidate.configRevision,
            grant: installationCandidate.installationGrant,
          }}
          example={{
            packageInstallId: installationCandidate.packageInstallId,
            packageRevision: installationCandidate.packageRevision,
            definitionSha256: installationCandidate.definitionSha256,
            enabled: installationCandidate.enabled,
            configuration: installationCandidate.configuration,
            grantActions: installationCandidate.grantActions,
            runnerId: installationCandidate.runnerId,
            executionPolicy: installationCandidate.executionPolicy,
            coordinatorFlowRevisionId: null,
          }}
        />
      ) : null}
      {snapshot && !query.tab && !query.edit ? (
        <div className="space-y-3 rounded-xl border border-line bg-paper p-5">
          <h2 className="font-semibold">{t("configuration")}</h2>
          <form className="flex flex-wrap items-end gap-2">
            <input name="binding" type="hidden" value={snapshot.bindingId} />
            <input name="kind" type="hidden" value={kind ?? "specialist"} />
            <label className="text-sm">
              {t("revision")}
              <input
                required
                className="ml-2 w-24 rounded border border-line px-2 py-1"
                defaultValue={snapshot.revision}
                max={2147483647}
                min={1}
                name="revision"
                type="number"
              />
            </label>
            <button
              className="rounded border border-line px-3 py-1 text-sm"
              type="submit"
            >
              {t("inspectRevision")}
            </button>
          </form>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
            {JSON.stringify(snapshot, null, 2)}
          </pre>
        </div>
      ) : null}
      {schedules.length ? (
        <section className="space-y-3 rounded-xl border border-line bg-paper p-5">
          <h2 className="font-semibold">{t("activeInspectionSchedules")}</h2>
          <ul className="space-y-2">
            {schedules.map((schedule) => (
              <li
                key={schedule.id}
                className="flex flex-wrap items-center justify-between gap-3 text-sm"
              >
                <span>
                  {schedule.component_id} · {schedule.cron_expr} ·{" "}
                  {schedule.timezone}
                </span>
                <DisableStandInspection
                  companyId={companyId}
                  revision={schedule.revision}
                  scheduleId={schedule.id}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {components.length ? (
        <StandInspectionScheduleForm
          companyId={companyId}
          components={components}
          inspectors={inspectors.map(({ bindingId, name }) => ({
            id: bindingId,
            name,
          }))}
        />
      ) : null}
      {canManage ? (
        <div className="grid gap-4 md:grid-cols-2">
          <BindingReviewForm
            bindingKind="specialist"
            canGrantInstallation={canGrantInstallation}
            companyId={companyId}
            example={{
              packageInstallId: "",
              packageRevision: "",
              definitionSha256: "",
              coordinatorFlowRevisionId: null,
              enabled: false,
              configuration: {},
              grantActions: [],
              runnerId: null,
            }}
          />
          <BindingReviewForm
            bindingKind="coordinator"
            companyId={companyId}
            example={{
              specialistBindingId: "",
              specialistRevision: 1,
              flowRevisionId: "",
              manifestSha256: "",
              execution: { workspace: "none", completion: "result" },
              roleMappings: {},
              enabled: false,
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

async function readSettings(
  userId: string,
  searchParams: {
    binding?: string;
    revision?: string;
    kind?: string;
    tab?: string;
    edit?: string;
  },
) {
  const db = getDb();

  try {
    const page = await listCompanySpecialists(db, userId, { limit: 50 });
    const { binding, revision, kind } = searchParams;
    const selected = page.items.find(({ bindingId }) => bindingId === binding);
    const [companyId, flows, canManage] = await db.transaction(async (tx) => {
      const owner = await installationCompany(tx);

      await authorizeCompanyUserAction(tx, userId, owner, "specialists:read");
      const configured = await tx.execute<{
        id: string;
        flow_ref_id: string;
        revision: number;
      }>(sql`
        SELECT id,flow_ref_id,revision FROM company_flow_bindings WHERE company_id=${owner}
        ORDER BY flow_ref_id,id LIMIT 50
      `);

      try {
        await authorizeCompanyUserAction(
          tx,
          userId,
          owner,
          "specialists:manage",
        );

        return [owner, configured.rows, true] as const;
      } catch (error) {
        if (isMaisterError(error) && error.code === "UNAUTHORIZED")
          return [owner, configured.rows, false] as const;
        throw error;
      }
    });
    const chosen =
      kind === "coordinator" && flows.find(({ id }) => id === binding);
    const snapshot = chosen
      ? await getCompanyFlowBindingRevision(
          db,
          userId,
          chosen.id,
          revision ? Number(revision) : chosen.revision,
        )
      : selected
        ? await getCompanySpecialistBindingRevision(
            db,
            userId,
            selected.id,
            selected.bindingId,
            revision ? Number(revision) : selected.configRevision,
          )
        : null;

    return { page, flows, snapshot, companyId, canManage, kind, selected };
  } catch (error) {
    if (
      isMaisterError(error) &&
      ["CONFIG", "UNAUTHORIZED", "PRECONDITION"].includes(error.code)
    )
      notFound();
    throw error;
  }
}

async function readInspectionComponents(userId: string, companyId: string) {
  const db = getDb();

  try {
    return await db.transaction(async (tx) => {
      await authorizeCompanyUserAction(tx, userId, companyId, "targets:read");

      return (
        await tx.execute<{ targetId: string; componentId: string }>(sql`
        SELECT target.id AS "targetId",part.component_id AS "componentId"
        FROM stand_targets target JOIN stand_components part
          ON part.target_id=target.id AND part.config_revision=target.config_revision
        WHERE target.company_id=${companyId} AND target.enabled AND part.config->'actions' ? 'inspect'
        ORDER BY target.id,part.component_id LIMIT 100
      `)
      ).rows;
    });
  } catch (error) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED") return [];
    throw error;
  }
}

async function readInspectionSchedules(userId: string, companyId: string) {
  try {
    return await getDb().transaction(async (tx) => {
      await authorizeCompanyUserAction(tx, userId, companyId, "targets:read");

      return (
        await tx.execute<{
          id: string;
          component_id: string;
          cron_expr: string;
          timezone: string;
          revision: number;
        }>(sql`
        SELECT id,stand_inspection->>'componentId' AS component_id,cron_expr,timezone,company_config_revision AS revision
        FROM agent_schedules WHERE company_id=${companyId} AND enabled AND stand_inspection IS NOT NULL
        ORDER BY next_fire_at,id LIMIT 100
      `)
      ).rows;
    });
  } catch (error) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED") return [];
    throw error;
  }
}
