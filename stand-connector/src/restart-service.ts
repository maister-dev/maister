import type {
  RestartEntry,
  RestartIntent,
  RestartJournal,
  RestartPermit,
  ServiceObservation,
} from "./restart-journal.ts";
import { RestartJournalError } from "./restart-journal.ts";

export type Authorization =
  | Readonly<{ decision: "allowed"; permit: RestartPermit }>
  | Readonly<{ decision: "refused" }>;

export type RestartDriver = Readonly<{
  inspect(): Promise<ServiceObservation>;
  requireQuiescent?(): Promise<void>;
  authorize(intent: RestartIntent): Promise<Authorization>;
  restart(): Promise<"received" | "uncertain">;
}>;

export type RestartService = Readonly<{
  execute(
    intent: RestartIntent,
    before: ServiceObservation,
  ): Promise<RestartEntry>;
}>;

/** Execute only the newly admitted intent. Every duplicate observes the original journal entry. */
export function createRestartService(
  journal: RestartJournal,
  driver: RestartDriver,
): RestartService {
  async function effect(
    intent: RestartIntent,
    permit: RestartPermit,
  ): Promise<RestartEntry> {
    journal.consumePermit(intent, permit);
    if (Date.parse(permit.expiresAt) <= Date.now())
      return journal.finish(intent, {
        acknowledgement: "uncertain",
        after: null,
      });
    const acknowledgement = await driver.restart();

    if (acknowledgement === "uncertain")
      return journal.finish(intent, { acknowledgement, after: null });
    const after = await driver.inspect();

    return journal.finish(intent, { acknowledgement, after });
  }

  async function executeSuccessor(
    intent: RestartIntent,
    before: ServiceObservation,
  ): Promise<RestartEntry> {
    if (journal.read(intent.operationId))
      return journal.admit(intent, before).entry;
    if (!driver.requireQuiescent)
      throw new RestartJournalError("resource_conflict");
    const authorization = await driver.authorize(intent);

    if (
      authorization.decision !== "allowed" ||
      authorization.permit.predecessorId !== intent.predecessorId
    )
      throw new RestartJournalError("resource_conflict");
    await driver.requireQuiescent();
    const admitted = journal.admit(intent, before, authorization.permit);

    if (!admitted.created) return admitted.entry;
    const current = await driver.inspect();

    if (
      current.state !== before.state ||
      current.invocationId !== before.invocationId
    )
      return journal.refuse(intent, "before_state_changed");

    return effect(intent, authorization.permit);
  }

  return {
    async execute(
      intent: RestartIntent,
      before: ServiceObservation,
    ): Promise<RestartEntry> {
      if (intent.predecessorId) return executeSuccessor(intent, before);
      const admitted = journal.admit(intent, before);

      if (!admitted.created) return admitted.entry;
      const current = await driver.inspect();

      if (
        current.state === "unknown" ||
        current.state !== before.state ||
        current.invocationId !== before.invocationId
      )
        return journal.refuse(intent, "before_state_changed");

      const authorization = await driver.authorize(intent);

      if (authorization.decision === "refused")
        return journal.refuse(intent, "authority_refused");

      return effect(intent, authorization.permit);
    },
  };
}
