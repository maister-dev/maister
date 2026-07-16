import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import {
  createPanelBodySchema,
  toJudgePanelDto,
} from "@/lib/evaluations/config-schemas";
import { createPanel, listPanels } from "@/lib/evaluations/config";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-admin-eval-panels",
  level: process.env.LOG_LEVEL ?? "info",
});

// GET /api/admin/evaluations/judge-panels — list panels (manageEvaluationConfig).
export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const panels = (await listPanels()).map(toJudgePanelDto);

    return NextResponse.json({ panels });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}

// POST /api/admin/evaluations/judge-panels — create a panel.
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireGlobalRole("admin");
    const parsed = createPanelBodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const panel = await createPanel({
      name: parsed.data.name,
      roleBindings: parsed.data.roleBindings,
      policy: parsed.data.policy,
      createdByUserId: user.id,
    });

    return NextResponse.json(
      { panel: toJudgePanelDto(panel) },
      { status: 201 },
    );
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
