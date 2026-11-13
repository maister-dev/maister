import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { companyFlowBindingCreateSchema } from "@/lib/agents/company-flow-binding-types";
import { createCompanyFlowBinding } from "@/lib/agents/company-flow-bindings";
import { requireActiveSession } from "@/lib/authz";
import {
  knowledgeErrorResponse,
  knowledgeJson,
  readKnowledgeJson,
} from "@/lib/brain/knowledge-http";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const { id } = await requireActiveSession();

    assertInteractiveLaunchOrigin(request);
    const parsed = companyFlowBindingCreateSchema.safeParse(
      await readKnowledgeJson(request),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "The company Flow binding request is invalid",
      );
    const result = await createCompanyFlowBinding(getDb(), id, parsed.data);

    return knowledgeJson(
      {
        id: result.binding.id,
        revision: result.binding.revision,
        owner: result.binding.owner,
        enabled: result.binding.configuration.enabled,
      },
      result.duplicate ? 200 : 201,
    );
  } catch (error) {
    return knowledgeErrorResponse(error, "POST /api/company/flow-bindings");
  }
}
