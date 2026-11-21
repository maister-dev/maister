export type CiCheck = {
  name: string;
  headSha: string;
  ref: string;
  issuer: string;
  attempt: bigint;
  state: "success" | "failure" | "cancelled" | "pending" | "invalid";
};

type CiTarget = Pick<CiCheck, "headSha" | "ref" | "issuer"> & {
  checks: readonly string[];
};

type CiObservation = Readonly<{
  complete: boolean;
  checks: readonly CiCheck[];
}>;

type CiResolution = {
  outcome: "success" | "failure" | "cancelled";
  nonPassingChecks: readonly string[];
};

/** Every required check must have a current success before a publication can pass. */
export function evaluateCiObservation(
  target: CiTarget,
  observation: CiObservation,
): CiResolution | null {
  if (!observation.complete || target.checks.length === 0) return null;

  const required = new Set(target.checks);
  const current = new Map<string, CiCheck>();

  for (const check of observation.checks) {
    if (
      !required.has(check.name) ||
      check.headSha !== target.headSha ||
      check.ref !== target.ref ||
      check.issuer !== target.issuer
    )
      continue;
    const prior = current.get(check.name);

    if (!prior || prior.attempt < check.attempt) current.set(check.name, check);
    else if (prior.attempt === check.attempt && prior.state !== check.state)
      current.set(check.name, { ...check, state: "invalid" });
  }

  const failed = target.checks.filter(
    (name) => current.get(name)?.state === "failure",
  );

  if (failed.length) return { outcome: "failure", nonPassingChecks: failed };
  const cancelled = target.checks.filter(
    (name) => current.get(name)?.state === "cancelled",
  );

  if (cancelled.length)
    return { outcome: "cancelled", nonPassingChecks: cancelled };
  if (target.checks.every((name) => current.get(name)?.state === "success"))
    return { outcome: "success", nonPassingChecks: [] };

  return null;
}
