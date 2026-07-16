import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import { listMethodologies } from "@/lib/evaluations/methods-registry";
import { evalErrorResponse } from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-admin-eval-methodologies",
  level: process.env.LOG_LEVEL ?? "info",
});

// GET /api/admin/evaluations/methodologies — every projected method revision
// with derived health, package trust, and validation errors (manageEvaluation
// config, global admin). Never exposes installed_path or prompt/schema bodies.
export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const methodologies = await listMethodologies();

    return NextResponse.json({ methodologies });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
