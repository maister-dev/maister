export type ApplicationLifecycle = Readonly<{
  quiesce: () => void;
  drain: () => Promise<void>;
}>;

// Next bundles instrumentation separately from the production server entrypoint.
// The shared process key retains callbacks bound to the actual runtime modules.
const KEY = Symbol.for("maister.application-lifecycle.v1");

type LifecycleGlobal = typeof globalThis & { [KEY]?: ApplicationLifecycle };
const READY_KEY = Symbol.for("maister.application-ready.v1");

type ReadyGlobal = typeof globalThis & {
  [READY_KEY]?: {
    resolve: (lifecycle: ApplicationLifecycle) => void;
    reject: (error: unknown) => void;
  };
};
const STOPPING_KEY = Symbol.for("maister.application-stopping.v1");

type StoppingGlobal = typeof globalThis & { [STOPPING_KEY]?: boolean };

export function quiesceApplication(): void {
  (globalThis as StoppingGlobal)[STOPPING_KEY] = true;
  applicationLifecycle()?.quiesce();
}

export function isApplicationStopping(): boolean {
  return (globalThis as StoppingGlobal)[STOPPING_KEY] === true;
}

export function registerApplicationLifecycle(
  lifecycle: ApplicationLifecycle,
): void {
  (globalThis as LifecycleGlobal)[KEY] = lifecycle;
  (globalThis as ReadyGlobal)[READY_KEY]?.resolve(lifecycle);
}

export function failApplicationStartup(error: unknown): void {
  (globalThis as ReadyGlobal)[READY_KEY]?.reject(error);
}

/** Next custom-server prepare starts instrumentation without awaiting its
 * completion. Admission waits for the actual application activation event. */
export function waitForApplicationLifecycle(
  timeoutMs: number,
): Promise<ApplicationLifecycle> {
  const current = applicationLifecycle();

  if (current) return Promise.resolve(current);
  let timer: ReturnType<typeof setTimeout>;

  return new Promise<ApplicationLifecycle>((resolve, reject) => {
    (globalThis as ReadyGlobal)[READY_KEY] = { resolve, reject };
    timer = setTimeout(
      () => reject(new Error("application instrumentation startup timed out")),
      timeoutMs,
    );
  }).finally(() => {
    clearTimeout(timer);
    delete (globalThis as ReadyGlobal)[READY_KEY];
  });
}

export function applicationLifecycle(): ApplicationLifecycle | undefined {
  return (globalThis as LifecycleGlobal)[KEY];
}
