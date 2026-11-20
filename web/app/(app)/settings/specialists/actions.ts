"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";

import { updateCompanySpecialistBinding } from "@/lib/agents/company-binding-mutations";
import { createCompanySpecialistBinding } from "@/lib/agents/company-bindings";
import {
  companyBindingCreateSchema,
  companyBindingUpdateSchema,
  companySpecialistIdSchema,
} from "@/lib/agents/company-binding-types";
import { createCompanyFlowBinding } from "@/lib/agents/company-flow-bindings";
import { companyFlowBindingCreateSchema } from "@/lib/agents/company-flow-binding-types";
import {
  createCompanyCronSchedule,
  disableCompanyStandInspection,
} from "@/lib/agents/company-schedules";
import { companyCronScheduleInputSchema } from "@/lib/agents/company-schedule-types";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError, type MaisterErrorCode } from "@/lib/errors";

type Receipt = Readonly<{ ok: true } | { ok: false; code: MaisterErrorCode }>;

const specialistRequest = z
  .object({
    agentId: companySpecialistIdSchema,
    binding: companyBindingCreateSchema,
  })
  .strict();

export async function createSpecialistBinding(
  value: unknown,
): Promise<Receipt> {
  const { id } = await requireActiveSession();
  const parsed = specialistRequest.safeParse(value);

  if (!parsed.success) return { ok: false, code: "CONFIG" };
  try {
    await createCompanySpecialistBinding(
      getDb(),
      id,
      parsed.data.agentId,
      parsed.data.binding,
    );

    return { ok: true };
  } catch (error) {
    if (isMaisterError(error)) return { ok: false, code: error.code };
    throw error;
  }
}

const specialistUpdate = z.strictObject({
  agentId: companySpecialistIdSchema,
  bindingId: z.uuid(),
  binding: companyBindingUpdateSchema,
});

export async function updateSpecialistBinding(
  value: unknown,
): Promise<Receipt> {
  const { id } = await requireActiveSession();
  const parsed = specialistUpdate.safeParse(value);

  if (!parsed.success) return { ok: false, code: "CONFIG" };

  try {
    const { agentId, bindingId, binding } = parsed.data;

    await updateCompanySpecialistBinding(
      getDb(),
      id,
      agentId,
      bindingId,
      binding,
    );

    return { ok: true };
  } catch (error) {
    if (isMaisterError(error)) return { ok: false, code: error.code };
    throw error;
  }
}

export async function createCoordinatorBinding(
  value: unknown,
): Promise<Receipt> {
  const { id } = await requireActiveSession();
  const parsed = companyFlowBindingCreateSchema.safeParse(value);

  if (!parsed.success) return { ok: false, code: "CONFIG" };
  try {
    await createCompanyFlowBinding(getDb(), id, parsed.data);

    return { ok: true };
  } catch (error) {
    if (isMaisterError(error)) return { ok: false, code: error.code };
    throw error;
  }
}

export async function createStandInspectionSchedule(
  value: unknown,
): Promise<Receipt> {
  const { id } = await requireActiveSession();
  const parsed = companyCronScheduleInputSchema.safeParse(value);

  if (!parsed.success || !parsed.data.standInspection)
    return { ok: false, code: "CONFIG" };
  try {
    await createCompanyCronSchedule(getDb(), id, parsed.data);

    revalidatePath("/settings/specialists");

    return { ok: true };
  } catch (error) {
    if (isMaisterError(error)) return { ok: false, code: error.code };
    throw error;
  }
}

const disableInspectionInput = z
  .object({
    companyId: z.string().min(1).max(128),
    scheduleId: z.uuid(),
    revision: z.number().int().positive(),
  })
  .strict();

export async function disableStandInspectionSchedule(
  value: unknown,
): Promise<Receipt> {
  const { id } = await requireActiveSession();
  const parsed = disableInspectionInput.safeParse(value);

  if (!parsed.success) return { ok: false, code: "CONFIG" };
  try {
    const { companyId, scheduleId, revision } = parsed.data;

    await disableCompanyStandInspection(
      getDb(),
      id,
      companyId,
      scheduleId,
      revision,
    );
    revalidatePath("/settings/specialists");

    return { ok: true };
  } catch (error) {
    if (isMaisterError(error)) return { ok: false, code: error.code };
    throw error;
  }
}
