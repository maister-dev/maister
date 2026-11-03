import type { Owner } from "@/lib/company/types";

import { ownerSchema } from "@/lib/company/types";
import { MaisterError } from "@/lib/errors-core";

export type KnowledgeOwnerChoice = Readonly<{
  value: string;
  owner: Owner;
  projectName: string | null;
}>;

export function knowledgeOwnerValue(owner: Owner): string {
  return owner.kind === "company"
    ? `c:${owner.companyId}`
    : `p:${owner.projectId}`;
}

export function knowledgeOwnerSelection(
  value: string | undefined,
): Owner | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = ownerSchema.safeParse(
    value.startsWith("c:")
      ? { kind: "company", companyId: value.slice(2) }
      : value.startsWith("p:")
        ? { kind: "project", projectId: value.slice(2) }
        : null,
  );

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Select a valid knowledge owner");

  return parsed.data;
}
