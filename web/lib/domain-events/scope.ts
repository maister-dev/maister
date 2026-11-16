import type { DomainEventRow, ProjectDomainEventRow } from "@/lib/db/schema";

/** Project consumers must never infer a project for a company-owned fact. */
export function isProjectDomainEvent(
  event: DomainEventRow,
): event is ProjectDomainEventRow {
  return typeof event.projectId === "string" && event.companyId == null;
}
