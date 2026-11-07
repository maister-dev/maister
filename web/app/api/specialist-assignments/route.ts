import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import {
  knowledgeErrorResponse,
  knowledgeJson,
  readKnowledgeJson,
} from "@/lib/brain/knowledge-http";
import { submitProjectManualAssignment } from "@/lib/specialist-assignments/project-manual-intake";
import { manualSpecialistAssignmentRequestSchema } from "@/lib/specialist-assignments/intake-types";
import { MaisterError } from "@/lib/errors";
import { submitCompanyManualAssignment } from "@/lib/specialist-assignments/company-manual-intake";
import { getSpecialistAssignment } from "@/lib/specialist-assignments/store";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const parsed = manualSpecialistAssignmentRequestSchema.safeParse(
      await readKnowledgeJson(request),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "Specialist submission requires an explicit owner, bounded original request and idempotency key",
      );
    const receipt =
      parsed.data.owner.kind === "project"
        ? await submitProjectManualAssignment(getDb(), user.id, parsed.data)
        : await submitCompanyManualAssignment(getDb(), user.id, parsed.data);
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
