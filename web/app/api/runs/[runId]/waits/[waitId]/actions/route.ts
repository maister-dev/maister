import { privateJson } from "@/lib/api/private-json";
import { requireProjectActionForUser } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";
import { readWaitCommand, waitHttpError } from "@/lib/waits/http";
import { operateWait, operatorWaitBody } from "@/lib/waits/operator";
import { readWaitForSession } from "@/lib/waits/session";

const endpoint = "/api/runs/{runId}/waits/{waitId}/actions";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string; waitId: string }> },
) {
  if (request.headers.has("authorization"))
    return privateJson(
      { code: "UNAUTHORIZED", message: "Session authorization required" },
      403,
    );

  try {
    assertInteractiveLaunchOrigin(request);
    const { runId, waitId } = await context.params;
    const { wait, access } = await readWaitForSession(runId, waitId);

    await requireProjectActionForUser(
      access.user.id,
      wait.projectId,
      "operateWait",
    );
    const { key, body } = await readWaitCommand(request, operatorWaitBody);
    const result = await operateWait(
      getDb(),
      { runId, waitId, projectId: wait.projectId },
      { userId: access.user.id, key },
      body,
    );

    return privateJson(result.body, result.status);
  } catch (error: unknown) {
    return waitHttpError(error, endpoint);
  }
}
