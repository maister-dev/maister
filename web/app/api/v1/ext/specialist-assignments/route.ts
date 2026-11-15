import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { privateJson, readPrivateJson } from "@/lib/api/private-json";
import { wakeAcceptedTaskLaunch } from "@/lib/tasks/launch-wake";
import { getDb } from "@/lib/db/client";
import { handlePersonalAssignmentExt } from "@/lib/specialist-assignments/external";
import { submitManualSpecialistAssignment } from "@/lib/specialist-assignments/manual-intake";
import { getVisibleSpecialistAssignment } from "@/lib/specialist-assignments/store";
import { assignmentPageQuery } from "@/lib/specialist-assignments/http";
import { listAccessibleSpecialistAssignments } from "@/lib/specialist-assignments/pages";

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handlePersonalAssignmentExt(
    request,
    "assignments:submit",
    "POST /api/v1/ext/specialist-assignments",
    async (userId) => {
      const receipt = await submitManualSpecialistAssignment(
        getDb(),
        userId,
        await readPrivateJson(request),
      );

      if (receipt.projectAdmission?.kind === "accepted")
        wakeAcceptedTaskLaunch(getDb(), receipt.projectAdmission.receipt);
      const assignment = await getVisibleSpecialistAssignment(
        getDb(),
        userId,
        receipt.assignment.id,
      );

      return privateJson(assignment, receipt.duplicate ? 200 : 201);
    },
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handlePersonalAssignmentExt(
    request,
    "assignments:read",
    "GET /api/v1/ext/specialist-assignments",
    async (userId) =>
      privateJson(
        await listAccessibleSpecialistAssignments(
          getDb(),
          userId,
          assignmentPageQuery(request),
        ),
      ),
  );
}
