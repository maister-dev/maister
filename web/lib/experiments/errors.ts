import { MaisterError } from "@/lib/errors-core";

export class ExperimentNotFoundError extends MaisterError {
  constructor(experimentId: string) {
    super("PRECONDITION", `experiment not found: ${experimentId}`, {
      details: { resource: "experiment", experimentId },
    });
    this.name = "ExperimentNotFoundError";
    Object.setPrototypeOf(this, ExperimentNotFoundError.prototype);
  }
}
