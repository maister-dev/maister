import type {
  RestartEntry,
  RestartIntent,
  RestartJournal,
  RestartPermit,
  ServiceObservation,
} from "./restart-journal.ts";

type Authorization =
  | Readonly<{ decision: "allowed"; permit: RestartPermit }>
  | Readonly<{ decision: "refused" }>;

export type RestartDriver = Readonly<{
  inspect(): Promise<ServiceObservation>;
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
  return {
    async execute(
      intent: RestartIntent,
      before: ServiceObservation,
    ): Promise<RestartEntry> {
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

      journal.consumePermit(intent, authorization.permit);
      if (Date.parse(authorization.permit.expiresAt) <= Date.now())
        return journal.finish(intent, {
          acknowledgement: "uncertain",
          after: null,
        });

      const acknowledgement = await driver.restart();

      if (acknowledgement === "uncertain")
        return journal.finish(intent, { acknowledgement, after: null });

      const after = await driver.inspect();

      return journal.finish(intent, { acknowledgement, after });
    },
  };
}
