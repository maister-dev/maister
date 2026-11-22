import "server-only";

import { requireActiveSession } from "@/lib/authz";
import {
  knowledgeErrorResponse,
  knowledgeJson,
} from "@/lib/brain/knowledge-http";
import {
  listKnowledgeRevisions,
  parseKnowledgeRevisionPage,
} from "@/lib/brain/knowledge-revisions";
import { knowledgeRecordSelector } from "@/lib/brain/knowledge-url";
import { getDb } from "@/lib/db/client";

export async function GET(
  request: Request,
  route: { params: Promise<{ recordId: string }> },
) {
  try {
    const user = await requireActiveSession();
    const { recordId } = knowledgeRecordSelector(
      (await route.params).recordId,
      null,
    );

    return knowledgeJson(
      await listKnowledgeRevisions(
        getDb(),
        { kind: "user", userId: user.id },
        recordId,
        parseKnowledgeRevisionPage(new URL(request.url).searchParams),
      ),
    );
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "GET /api/knowledge/[recordId]/revisions",
    );
  }
}
