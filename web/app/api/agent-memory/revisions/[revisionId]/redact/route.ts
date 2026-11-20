import "server-only";

import {
  readVaultJson,
  vaultErrorResponse,
} from "@/lib/agent-memory-vault/http";
import {
  parseMemoryRedaction,
  redactMemoryRevision,
} from "@/lib/agent-memory-vault/redaction";
import { privateJson } from "@/lib/api/private-json";
import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { decodeRouteParam } from "@/lib/route-params";

export async function POST(
  request: Request,
  context: { params: Promise<{ revisionId: string }> },
) {
  try {
    const user = await requireGlobalRole("admin");
    const revisionId = decodeRouteParam(
      (await context.params).revisionId,
      "revisionId",
    );

    return privateJson(
      await redactMemoryRevision(
        getDb(),
        user.id,
        revisionId,
        parseMemoryRedaction(await readVaultJson(request)),
      ),
    );
  } catch (error) {
    return vaultErrorResponse(error, "admin agent vault redaction");
  }
}
