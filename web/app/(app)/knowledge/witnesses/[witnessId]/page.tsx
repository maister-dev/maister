import type { ReactElement } from "react";

import {
  KnowledgeUnavailable,
  KnowledgeWitnessView,
} from "@/components/brain/knowledge-view";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getKnowledgeWitness } from "@/lib/brain/knowledge-witnesses";
import { knowledgeReferenceView } from "@/lib/brain/knowledge-ui";

export default async function KnowledgeWitnessPage({
  params,
}: {
  params: Promise<{ witnessId: string }>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const { witnessId } = await params;

  const view = await knowledgeReferenceView(() =>
    getKnowledgeWitness(getDb(), { kind: "user", userId: user.id }, witnessId),
  );

  if (view.state === "unavailable") return <KnowledgeUnavailable />;

  return <KnowledgeWitnessView witness={view.value} />;
}
