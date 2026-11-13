"use server";

import { z } from "zod";

import { createCompanySpecialistBinding } from "@/lib/agents/company-bindings";
import {
  companyBindingCreateSchema,
  companySpecialistIdSchema,
} from "@/lib/agents/company-binding-types";
import { createCompanyFlowBinding } from "@/lib/agents/company-flow-bindings";
import { companyFlowBindingCreateSchema } from "@/lib/agents/company-flow-binding-types";
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
