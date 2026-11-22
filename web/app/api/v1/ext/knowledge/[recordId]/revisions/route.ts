import "server-only";

import { privateJson } from "@/lib/api/private-json";
import {
  listKnowledgeRevisions,
  parseKnowledgeRevisionPage,
} from "@/lib/brain/knowledge-revisions";
import { knowledgeRecordSelector } from "@/lib/brain/knowledge-url";
import { getDb } from "@/lib/db/client";
import { handlePersonalKnowledge } from "@/lib/tokens/personal-knowledge";

export async function GET(
  request: Request,
  route: { params: Promise<{ recordId: string }> },
) {
  return handlePersonalKnowledge(
    request,
    "knowledge:read",
    "GET /api/v1/ext/knowledge/{recordId}/revisions",
    async ({ tokenId, userId }) => {
      const { recordId } = knowledgeRecordSelector(
        (await route.params).recordId,
        null,
      );

      return privateJson(
        await listKnowledgeRevisions(
          getDb(),
          { kind: "personal_read", tokenId, userId },
          recordId,
          parseKnowledgeRevisionPage(new URL(request.url).searchParams),
        ),
      );
    },
  );
}
