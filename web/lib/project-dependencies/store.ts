import type { getDb } from "@/lib/db/client";
import type { ProjectDependencyInput } from "./types";

export type { ProjectDependencyInput } from "./types";

import { randomUUID } from "node:crypto";

import {
  projectDependencyAttempts,
  projectDependencyDeclarations,
} from "@/lib/db/schema";

type Transaction = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

export async function enqueueProjectDependencies(
  tx: Transaction,
  input: {
    projectId: string;
    actorUserId: string;
    declarations: ProjectDependencyInput[];
  },
): Promise<void> {
  if (!input.declarations.length) return;
  const heads = input.declarations.map((declaration) => ({
    ...declaration,
    id: randomUUID(),
    projectId: input.projectId,
    generation: 1,
  }));
  await tx.insert(projectDependencyDeclarations).values(heads);
  await tx.insert(projectDependencyAttempts).values(
    heads.map((head) => ({
      projectId: head.projectId,
      declarationId: head.id,
      actorUserId: input.actorUserId,
      generation: head.generation,
      attemptNo: 1,
      desired: head.desired,
    })),
  );
}
