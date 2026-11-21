import "server-only";

import {
  listHumanVaultLocations,
  parseHumanVaultSelection,
} from "@/lib/agent-memory-vault/human-catalog";
import { vaultErrorResponse } from "@/lib/agent-memory-vault/http";
import { privateJson } from "@/lib/api/private-json";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";

export async function GET(request: Request) {
  try {
    const user = await requireActiveSession();
    const selection = parseHumanVaultSelection(
      new URL(request.url).searchParams,
    );

    return privateJson(
      await listHumanVaultLocations(getDb(), user.id, selection),
    );
  } catch (error) {
    return vaultErrorResponse(error, "list human vault locations");
  }
}
