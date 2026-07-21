export type LockOpQueue = {
  run<T>(op: () => Promise<T>): Promise<T>;
};

// Same-session editor-lock ops (acquire / refresh / release) travel as separate
// HTTP requests, and the server applies them in COMPLETION order — a release
// handler finishing after a later acquire silently clears the fresh lock while
// the client still believes heldByMe=true (every write then 409s
// edit_lock_not_held until a full reload). Chaining each op behind the previous
// one's settlement makes issue order = server order. A rejected op surfaces to
// its caller but never wedges the chain.
export function createLockOpQueue(): LockOpQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run<T>(op: () => Promise<T>): Promise<T> {
      const next = tail.then(op, op);

      tail = next.catch(() => undefined);

      return next;
    },
  };
}
