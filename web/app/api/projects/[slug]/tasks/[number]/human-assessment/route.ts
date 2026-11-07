import { NextResponse } from "next/server";
import { z } from "zod";

import { requireTaskQualificationAccess } from "@/lib/tasks/qualification-http";
import {
  getHumanTaskAssessmentDraft,
  recordHumanTaskAssessment,
} from "@/lib/tasks/human-assessment";
import { humanAssessmentErrorResponse } from "@/lib/tasks/human-assessment-http";
import {
  assertInteractiveLaunchOrigin,
  readTaskLaunchBody,
} from "@/lib/tasks/launch-http";
import { MaisterError } from "@/lib/errors";

type Route = { params: Promise<{ slug: string; number: string }> };
const querySchema = z
  .object({
    search: z.string().max(100).optional(),
    repository: z.literal("1").optional(),
  })
  .strict();

export async function GET(
  request: Request,
  route: Route,
): Promise<NextResponse> {
  try {
    const { slug, number } = await route.params;
    const access = await requireTaskQualificationAccess(slug, number);
    const query = new URL(request.url).searchParams;
    const parsed = querySchema.safeParse(Object.fromEntries(query));

    if (
      !parsed.success ||
      [...query.keys()].some((key) => query.getAll(key).length !== 1)
    )
      throw new MaisterError("CONFIG", "Invalid assessment evidence query");
    const draft = await getHumanTaskAssessmentDraft(access.db, access, {
      search: parsed.data.search,
      repository: parsed.data.repository === "1",
    });

    return NextResponse.json(draft, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return humanAssessmentErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  route: Route,
): Promise<NextResponse> {
  try {
    const { slug, number } = await route.params;
    const access = await requireTaskQualificationAccess(slug, number);

    assertInteractiveLaunchOrigin(request);
    const body = await readTaskLaunchBody(request);
    // The service preserves precise schema issue paths for the form.
    const receipt = await recordHumanTaskAssessment(access.db, access, body);

    return NextResponse.json(receipt, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return humanAssessmentErrorResponse(error);
  }
}
