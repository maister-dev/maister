import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";
import { requireActiveSession } from "@/lib/authz";
import { wakeAcceptedTaskLaunch } from "@/lib/tasks/launch-wake";
import { getDb } from "@/lib/db/client";
import {
  knowledgeErrorResponse,
  knowledgeJson,
  readKnowledgeJson,
} from "@/lib/brain/knowledge-http";
import { submitManualSpecialistAssignment } from "@/lib/specialist-assignments/manual-intake";
import { getSpecialistAssignment } from "@/lib/specialist-assignments/store";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    assertInteractiveLaunchOrigin(request);
    const principal = await interactiveTaskLaunchPrincipal();
    const receipt = await submitManualSpecialistAssignment(
      getDb(),
      user.id,
      await readKnowledgeJson(request),
      principal,
    );

    if (receipt.projectAdmission?.kind === "accepted")
      wakeAcceptedTaskLaunch(getDb(), receipt.projectAdmission.receipt);
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
