import { privateJson, privateErrorResponse } from "@/lib/api/private-json";
import { platformCompletionPatchSchema } from "@/lib/auto-promotion/completion-policy";
import { setPlatformCompletion } from "@/lib/auto-promotion/completion-settings";
import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

export async function PATCH(request: Request) {
  if (request.headers.has("authorization"))
    return privateJson(
      { code: "UNAUTHORIZED", message: "Session authorization required" },
      403,
    );

  try {
    const actor = await requireGlobalRole("admin");

    assertInteractiveLaunchOrigin(request);
    const patch = platformCompletionPatchSchema.safeParse(
      await readBoundedJson(request, 4096),
    );

    if (!patch.success)
      return privateJson(
        { code: "CONFIG", message: "Invalid completion settings" },
        422,
      );

    return privateJson(
      await setPlatformCompletion(getDb(), actor.id, patch.data),
    );
  } catch (error: unknown) {
    return privateErrorResponse(error, "/api/admin/autonomous-completion");
  }
}
