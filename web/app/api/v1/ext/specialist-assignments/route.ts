import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { knowledgeJson, readKnowledgeJson } from "@/lib/brain/knowledge-http";
import { wakeAcceptedTaskLaunch } from "@/lib/tasks/launch-wake";
import { getDb } from "@/lib/db/client";
import { handlePersonalAssignmentExt } from "@/lib/specialist-assignments/external";
import { submitManualSpecialistAssignment } from "@/lib/specialist-assignments/manual-intake";
import { getSpecialistAssignment } from "@/lib/specialist-assignments/store";

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handlePersonalAssignmentExt(
    request,
    "assignments:submit",
    "POST /api/v1/ext/specialist-assignments",
    async (userId) => {
      const receipt = await submitManualSpecialistAssignment(
        getDb(),
        userId,
        await readKnowledgeJson(request),
      );

      if (receipt.projectAdmission?.kind === "accepted")
        wakeAcceptedTaskLaunch(getDb(), receipt.projectAdmission.receipt);
      const assignment = await getSpecialistAssignment(
        getDb(),
        userId,
        receipt.assignment.id,
      );

      return knowledgeJson(assignment, receipt.duplicate ? 200 : 201);
    },
  );
}
