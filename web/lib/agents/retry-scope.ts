import "server-only";

import type { agentRetryIntents } from "@/lib/db/schema";
import type { ProjectAgentRetryRecipe } from "./retry-types";

import { retryRefusal } from "./retry-guards";
import { parseAgentRetryRecipe } from "./retry-snapshot";

export type ProjectAgentRetryIntent = typeof agentRetryIntents.$inferSelect & {
  projectId: string;
  companyId: null;
  recipe: ProjectAgentRetryRecipe;
};

/** A company recipe cannot enter a legacy project allocator, permission gate or cleanup path. */
export function assertProjectAgentRetryIntent(
  intent: typeof agentRetryIntents.$inferSelect,
): asserts intent is ProjectAgentRetryIntent {
  const recipe = parseAgentRetryRecipe(intent.recipe);

  if (
    intent.companyId !== null ||
    intent.projectId === null ||
    recipe.version === 3
  )
    throw retryRefusal("company_retry_runtime_unavailable");
  if (
    recipe.projectId !== intent.projectId ||
    recipe.agentId !== intent.sourceAgentId
  )
    throw retryRefusal("retry_context_changed");
}
