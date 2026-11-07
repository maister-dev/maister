import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import {
  knowledgeErrorResponse,
  knowledgeJson,
  readKnowledgeJson,
} from "@/lib/brain/knowledge-http";
import { submitCompanyManualAssignment } from "@/lib/specialist-assignments/company-manual-intake";
import { getSpecialistAssignment } from "@/lib/specialist-assignments/store";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const receipt = await submitCompanyManualAssignment(
      getDb(),
      user.id,
      await readKnowledgeJson(request),
    );
    const assignment = await getSpecialistAssignment(
      getDb(),
      user.id,
      receipt.assignment.id,
    );

    return knowledgeJson(assignment, receipt.duplicate ? 200 : 201);
  } catch (error) {
    return knowledgeErrorResponse(error, "POST /api/specialist-assignments");
  }
}
