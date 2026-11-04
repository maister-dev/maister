import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { AgentTriggerBindingSnapshot } from "./trigger-attempt-types";

import { sql } from "drizzle-orm";

import {
  decodeCompanyBindingHead,
  loadCompanyBindingRevision,
} from "./company-bindings";
import {
  lockCompanyFlowBindingConfiguration,
  loadCompanyFlowBindingRevision,
} from "./company-flow-bindings";
import { parseAgentTriggerBindingSnapshot } from "./trigger-attempt-types";

import { MaisterError } from "@/lib/errors";

export type TriggerScheduleCapture = Readonly<{
  id: string;
  agentId: string;
  projectId: string | null;
  companyId: string | null;
  companySpecialistBindingId: string | null;
  companyFlowBindingId: string | null;
  companyConfigRevision: number | null;
  triggerType: "cron" | "event" | "mention";
  cronExpr: string | null;
  timezone: string | null;
  eventMatch: Readonly<{ kinds: string[] }> | null;
}>;

/** Capture current accepted configuration identities under their owning company; the invocation request stays separate v1. */
export async function captureTriggerBindingSnapshot(
  tx: SqlTransaction,
  source: TriggerScheduleCapture,
): Promise<AgentTriggerBindingSnapshot> {
  const base = {
    scheduleId: source.id,
    triggerType: source.triggerType,
    cronExpr: source.cronExpr,
    timezone: source.timezone,
    eventKinds: source.eventMatch?.kinds ?? [],
  };

  if (source.projectId !== null && source.companyId === null) {
    if (
      source.companySpecialistBindingId !== null ||
      source.companyFlowBindingId !== null ||
      source.companyConfigRevision !== null
    )
      throw new MaisterError(
        "CONFIG",
        "Project invocation metadata cannot include company configuration references",
      );

    return parseAgentTriggerBindingSnapshot({ version: 1, ...base });
  }
  if (
    source.projectId !== null ||
    source.companyId === null ||
    source.companySpecialistBindingId === null ||
    source.companyConfigRevision === null
  )
    throw new MaisterError(
      "CONFIG",
      "The agent schedule does not have an explicit coherent company or project owner",
    );
  let coordinatorFlowBinding: {
    id: string;
    revision: number;
    snapshotSha256: string;
  } | null = null;

  if (source.companyFlowBindingId !== null) {
    const flowHead = await lockCompanyFlowBindingConfiguration(
      tx,
      source.companyFlowBindingId,
    );

    if (flowHead.companyId !== source.companyId)
      throw new MaisterError(
        "CONFLICT",
        "The schedule coordinator belongs to a different company",
      );
    const flow = await loadCompanyFlowBindingRevision(
      tx,
      flowHead,
      flowHead.revision,
    );

    coordinatorFlowBinding = {
      id: flowHead.id,
      revision: flowHead.revision,
      snapshotSha256: flow.snapshotDigest,
    };
  }
  const roleHead = decodeCompanyBindingHead(
    (
      await tx.execute(
        sql`SELECT * FROM company_specialist_bindings WHERE id=${source.companySpecialistBindingId} FOR SHARE`,
      )
    ).rows[0],
  );

  if (
    roleHead.companyId !== source.companyId ||
    roleHead.agentId !== source.agentId
  )
    throw new MaisterError(
      "CONFLICT",
      "The schedule professional role belongs to a different owner or specialist identity",
    );
  const role = await loadCompanyBindingRevision(
    tx,
    roleHead,
    roleHead.revision,
  );

  return parseAgentTriggerBindingSnapshot({
    version: 2,
    ...base,
    owner: { kind: "company", companyId: source.companyId },
    sourceRevision: source.companyConfigRevision,
    specialistBinding: {
      id: roleHead.id,
      revision: roleHead.revision,
      snapshotSha256: role.snapshotDigest,
    },
    coordinatorFlowBinding,
  });
}
