import "server-only";

// Serialize project registration so concurrent POST /api/projects calls cannot
// race on the same derived clone target (the TOCTOU between the pathExists
// pre-check and the clone+cleanup). MAIster is a single-host control plane and
// registration is admin-only + infrequent, so a process-wide async lock is
// sufficient — no temp-dir/rename dance needed (ADR-025).
//
// `then(fn, fn)` runs the next critical section whether the previous one
// resolved or rejected, so one failed registration never wedges the queue.
let chain: Promise<unknown> = Promise.resolve();

export function withRegistrationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);

  chain = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}
