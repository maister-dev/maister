import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";
import { requireActiveSession } from "@/lib/authz";
import { wakeAcceptedTaskLaunch } from "@/lib/tasks/launch-wake";
import { getDb } from "@/lib/db/client";
import {
  privateErrorResponse,
  privateJson,
  readPrivateJson,
} from "@/lib/api/private-json";
import { submitManualSpecialistAssignment } from "@/lib/specialist-assignments/manual-intake";
import { getVisibleSpecialistAssignment } from "@/lib/specialist-assignments/store";
import { assignmentPageQuery } from "@/lib/specialist-assignments/http";
import { listAccessibleSpecialistAssignments } from "@/lib/specialist-assignments/pages";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    assertInteractiveLaunchOrigin(request);
    const principal = await interactiveTaskLaunchPrincipal();
    const receipt = await submitManualSpecialistAssignment(
      getDb(),
      user.id,
      await readPrivateJson(request),
      principal,
    );

    if (receipt.projectAdmission?.kind === "accepted")
      wakeAcceptedTaskLaunch(getDb(), receipt.projectAdmission.receipt);
    const assignment = await getVisibleSpecialistAssignment(
      getDb(),
      user.id,
      receipt.assignment.id,
    );

    return privateJson(assignment, receipt.duplicate ? 200 : 201);
  } catch (error) {
    return privateErrorResponse(error, "POST /api/specialist-assignments");
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    return privateJson(
      await listAccessibleSpecialistAssignments(
        getDb(),
        user.id,
        assignmentPageQuery(request),
      ),
    );
  } catch (error) {
    return privateErrorResponse(error, "GET /api/specialist-assignments");
  }
}
