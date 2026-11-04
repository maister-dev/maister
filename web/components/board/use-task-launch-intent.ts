"use client";

import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";
import type { TaskLaunchConflictReference } from "@/lib/tasks/launch-conflict";
import type { NodeEnforcementRefusal } from "@/lib/flows/enforcement-refusal";

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import { TASK_LAUNCH_STATES } from "@/lib/tasks/launch-types";
import { taskLaunchConflictReferenceSchema } from "@/lib/tasks/launch-conflict";
import { nodeEnforcementRefusalSchema } from "@/lib/flows/enforcement-refusal";

type LaunchAttempt = Readonly<{ endpoint: string; key: string; body: string }>;
type StoredLaunch = Readonly<{
  attempt: LaunchAttempt | null;
  receipt: TaskLaunchReceipt | null;
  mutationToken?: string | null;
  conflict?: TaskLaunchConflictReference | null;
}>;
type LaunchClientState = StoredLaunch &
  Readonly<{
    busy: boolean;
    uncertain: boolean;
    errorReason: string | null;
    enforcementRefusal?: NodeEnforcementRefusal | null;
  }>;
type TaskLaunchIntentController = LaunchClientState &
  Readonly<{
    submit: (endpoint: string, body: object) => Promise<void>;
    retryRequest: () => Promise<void>;
    refresh: () => Promise<void>;
    observe: (receipt: TaskLaunchReceipt) => void;
    clearCompleted: () => void;
    inspectConflict: () => Promise<void>;
  }>;

const INITIAL_STATE: LaunchClientState = {
  attempt: null,
  receipt: null,
  busy: false,
  uncertain: false,
  errorReason: null,
  conflict: null,
};

function responseConflict(value: unknown): TaskLaunchConflictReference | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("details" in value) ||
    !value.details ||
    typeof value.details !== "object" ||
    !("existing" in value.details)
  )
    return null;
  const parsed = taskLaunchConflictReferenceSchema.safeParse(
    value.details.existing,
  );

  return parsed.success ? parsed.data : null;
}

function readReceipt(value: unknown, taskId: string): TaskLaunchReceipt {
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("intentId" in value) ||
    typeof value.intentId !== "string" ||
    !("taskId" in value) ||
    value.taskId !== taskId ||
    !("stateVersion" in value) ||
    typeof value.stateVersion !== "number" ||
    !("state" in value) ||
    !TASK_LAUNCH_STATES.some((state) => state === value.state) ||
    !("basis" in value) ||
    !["manual", "automatic", "execution_child"].includes(String(value.basis)) ||
    !("taskRevision" in value) ||
    typeof value.taskRevision !== "number" ||
    !("acceptedAt" in value) ||
    typeof value.acceptedAt !== "string" ||
    !Number.isFinite(Date.parse(value.acceptedAt)) ||
    !("snapshot" in value) ||
    !value.snapshot ||
    typeof value.snapshot !== "object" ||
    !("runnerIds" in value.snapshot) ||
    !Array.isArray(value.snapshot.runnerIds) ||
    !value.snapshot.runnerIds.every((id: unknown) => typeof id === "string") ||
    !("targetBranch" in value.snapshot) ||
    typeof value.snapshot.targetBranch !== "string" ||
    !("autoPromote" in value.snapshot) ||
    typeof value.snapshot.autoPromote !== "boolean"
  )
    throw new Error("Task launch response is invalid");
  if (
    "sessions" in value.snapshot &&
    value.snapshot.sessions !== undefined &&
    (!Array.isArray(value.snapshot.sessions) ||
      !value.snapshot.sessions.every(
        (session: unknown) =>
          session !== null &&
          typeof session === "object" &&
          "sessionName" in session &&
          typeof session.sessionName === "string" &&
          "runnerId" in session &&
          typeof session.runnerId === "string" &&
          "model" in session &&
          typeof session.model === "string",
      ))
  )
    throw new Error("Task launch runner identity is invalid");

  return value as TaskLaunchReceipt;
}

function responseReason(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "details" in value &&
    value.details &&
    typeof value.details === "object" &&
    "reason" in value.details &&
    typeof value.details.reason === "string"
  )
    return value.details.reason;

  return "launch_technical_precondition";
}

function responseEnforcementRefusal(
  value: unknown,
): NodeEnforcementRefusal | null {
  if (!value || typeof value !== "object" || !("details" in value)) return null;
  const parsed = nodeEnforcementRefusalSchema.safeParse(value.details);

  return parsed.success ? parsed.data : null;
}

function storedLaunchState(
  taskId: string,
  storageKey: string,
): LaunchClientState {
  try {
    const saved = sessionStorage.getItem(storageKey);

    if (!saved) return INITIAL_STATE;
    const stored = JSON.parse(saved) as StoredLaunch;
    const receipt = stored.receipt ? readReceipt(stored.receipt, taskId) : null;
    const attempt = stored.attempt;

    if (
      attempt &&
      (typeof attempt.endpoint !== "string" ||
        !/^\/api\/task-launch-intents(?:\/concurrent|\/[^/?#]+\/(?:cancel|replace))?$/.test(
          attempt.endpoint,
        ) ||
        typeof attempt.key !== "string" ||
        typeof attempt.body !== "string")
    )
      throw new Error("Stored task launch request is invalid");

    const conflict = stored.conflict
      ? taskLaunchConflictReferenceSchema.parse(stored.conflict)
      : null;

    return {
      ...INITIAL_STATE,
      attempt,
      receipt,
      conflict,
      uncertain: attempt !== null,
    };
  } catch {
    return { ...INITIAL_STATE, errorReason: "launch_storage_unavailable" };
  }
}

type LaunchClientStore = Readonly<{
  getSnapshot: () => LaunchClientState;
  subscribe: (listener: () => void) => () => void;
  update: (next: LaunchClientState) => void;
  beginMutation: (next: LaunchClientState) => string | null;
  publishMutation: (token: string, next: LaunchClientState) => void;
  isMutationCurrent: (token: string | null) => boolean;
  mutationToken: () => string | null;
}>;

function storedMutationToken(storageKey: string): string | null {
  const raw = sessionStorage.getItem(storageKey);

  if (!raw) return null;
  const saved = JSON.parse(raw) as StoredLaunch;

  if (
    saved.mutationToken !== undefined &&
    saved.mutationToken !== null &&
    typeof saved.mutationToken !== "string"
  )
    throw new Error("Stored task launch mutation is invalid");

  return saved.mutationToken ?? null;
}

/** Every asynchronous writer is fenced by a persisted mutation token across component lifetimes. */
function createLaunchClientStore(
  taskId: string,
  storageKey: string,
): LaunchClientStore {
  let snapshot: LaunchClientState | null = null;
  let mutationToken: string | null = null;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const reload = (): void => {
    snapshot = storedLaunchState(taskId, storageKey);
    try {
      mutationToken = storedMutationToken(storageKey);
    } catch {
      snapshot = {
        ...snapshot,
        busy: false,
        errorReason: "launch_storage_unavailable",
      };
    }
  };
  const sync = (): void => {
    reload();
    notify();
  };
  const current = (token: string | null): boolean => {
    try {
      if (mutationToken === token && storedMutationToken(storageKey) === token)
        return true;
      sync();
    } catch {
      snapshot = {
        ...(snapshot ?? INITIAL_STATE),
        busy: false,
        errorReason: "launch_storage_unavailable",
      };
      notify();
    }

    return false;
  };
  const publish = (next: LaunchClientState, token: string | null): boolean => {
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          attempt: next.attempt,
          receipt: next.receipt,
          mutationToken: token,
          conflict: next.conflict,
        } satisfies StoredLaunch),
      );
      snapshot = next;
      mutationToken = token;
      notify();

      return true;
    } catch {
      snapshot = {
        ...next,
        busy: false,
        errorReason: "launch_storage_unavailable",
      };
      notify();

      return false;
    }
  };

  return {
    getSnapshot: () => {
      if (typeof window === "undefined") return INITIAL_STATE;
      if (snapshot === null) reload();

      return snapshot ?? INITIAL_STATE;
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    mutationToken: () => mutationToken,
    isMutationCurrent: current,
    beginMutation: (next) => {
      if (!current(mutationToken)) return null;
      const token = crypto.randomUUID();

      return publish(next, token) ? token : null;
    },
    publishMutation: (token, next) => {
      if (current(token)) publish(next, token);
    },
    update: (next) => {
      if (!current(mutationToken)) return;
      const stored = storedLaunchState(taskId, storageKey);
      const prior = stored.receipt;

      if (
        prior &&
        next.receipt &&
        (prior.intentId !== next.receipt.intentId ||
          prior.stateVersion > next.receipt.stateVersion)
      ) {
        sync();

        return;
      }
      publish(next, mutationToken);
    },
  };
}

/** One browser request keeps its key and serialized settings until the server gives a definitive outcome. */
export function useTaskLaunchIntent(
  taskId: string,
  lane: "ordinary" | "concurrent",
): TaskLaunchIntentController {
  const storageKey = `maister.task-launch:${taskId}:${lane}`;
  const store = useMemo(
    () => createLaunchClientStore(taskId, storageKey),
    [taskId, storageKey],
  );
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => INITIAL_STATE,
  );
  const inFlight = useRef(false);
  const update = store.update;

  const observe = useCallback(
    (receipt: TaskLaunchReceipt): void => {
      const old = store.getSnapshot().receipt;

      if (
        old &&
        (old.intentId !== receipt.intentId ||
          old.stateVersion > receipt.stateVersion)
      )
        return;
      if (store.getSnapshot().attempt || store.getSnapshot().busy) return;
      update({ ...store.getSnapshot(), receipt });
    },
    [store, update],
  );

  const perform = useCallback(
    async (attempt: LaunchAttempt): Promise<void> => {
      if (
        inFlight.current ||
        store.getSnapshot().errorReason === "launch_storage_unavailable"
      )
        return;
      inFlight.current = true;
      const token = store.beginMutation({
        ...store.getSnapshot(),
        attempt,
        busy: true,
        uncertain: false,
        errorReason: null,
        conflict: null,
      });

      if (!token) {
        inFlight.current = false;

        return;
      }
      try {
        const response = await fetch(attempt.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": attempt.key,
          },
          body: attempt.body,
        });
        const payload: unknown = await response.json();

        if (!response.ok) {
          if (response.status >= 500)
            throw new Error("Task launch outcome is unknown");
          store.publishMutation(token, {
            ...store.getSnapshot(),
            attempt: null,
            busy: false,
            uncertain: false,
            errorReason: responseReason(payload),
            enforcementRefusal: responseEnforcementRefusal(payload),
            conflict: responseConflict(payload),
          });

          return;
        }
        const receipt = readReceipt(payload, taskId);

        store.publishMutation(token, {
          attempt: null,
          receipt,
          busy: false,
          uncertain: false,
          errorReason: null,
          conflict: null,
        });
      } catch {
        store.publishMutation(token, {
          ...store.getSnapshot(),
          attempt,
          busy: false,
          uncertain: true,
          errorReason: "launch_response_unknown",
        });
      } finally {
        inFlight.current = false;
      }
    },
    [store, taskId, update],
  );

  const submit = useCallback(
    async (endpoint: string, body: object): Promise<void> => {
      if (store.getSnapshot().attempt || inFlight.current) return;
      await perform({
        endpoint,
        key: crypto.randomUUID(),
        body: JSON.stringify(body),
      });
    },
    [perform, store],
  );
  const retryRequest = useCallback(async (): Promise<void> => {
    const attempt = store.getSnapshot().attempt;

    if (attempt) await perform(attempt);
  }, [perform, store]);
  const refresh = useCallback(async (): Promise<void> => {
    const receipt = store.getSnapshot().receipt;

    if (!receipt || inFlight.current) return;
    const token = store.mutationToken();
    const stillCurrent = (): boolean =>
      store.isMutationCurrent(token) &&
      store.getSnapshot().receipt?.intentId === receipt.intentId;

    try {
      const response = await fetch(
        `/api/task-launch-intents/${encodeURIComponent(receipt.intentId)}`,
        { cache: "no-store" },
      );
      const payload: unknown = await response.json();

      if (!stillCurrent()) return;
      if (!response.ok) {
        update({
          ...store.getSnapshot(),
          errorReason: responseReason(payload),
        });

        return;
      }
      observe(readReceipt(payload, taskId));
    } catch {
      if (stillCurrent())
        update({
          ...store.getSnapshot(),
          errorReason: "launch_status_unavailable",
        });
    }
  }, [observe, store, taskId, update]);
  const clearCompleted = useCallback((): void => {
    if (store.getSnapshot().attempt || store.getSnapshot().busy) return;
    const receipt = store.getSnapshot().receipt;

    if (receipt && !["cancelled", "failed", "settled"].includes(receipt.state))
      return;
    store.beginMutation(INITIAL_STATE);
  }, [store, update]);

  const inspectConflict = useCallback(async (): Promise<void> => {
    const conflict = store.getSnapshot().conflict;
    const token = store.mutationToken();

    if (!conflict?.intentId || inFlight.current) return;
    try {
      const response = await fetch(
        `/api/task-launch-intents/${encodeURIComponent(conflict.intentId)}`,
        { cache: "no-store" },
      );
      const payload: unknown = await response.json();

      if (!store.isMutationCurrent(token)) return;
      if (!response.ok) {
        update({
          ...store.getSnapshot(),
          errorReason: responseReason(payload),
        });

        return;
      }
      observe(readReceipt(payload, taskId));
    } catch {
      if (store.isMutationCurrent(token))
        update({
          ...store.getSnapshot(),
          errorReason: "launch_status_unavailable",
        });
    }
  }, [observe, store, taskId, update]);

  return {
    ...state,
    submit,
    retryRequest,
    refresh,
    observe,
    clearCompleted,
    inspectConflict,
  };
}
