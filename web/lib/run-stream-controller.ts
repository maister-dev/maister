export type RunStreamLifecycleKind =
  | "connecting"
  | "live"
  | "reconnecting"
  | "disconnected"
  | "closed";

export interface RunStreamLifecycle {
  kind: RunStreamLifecycleKind;
  retryAttempt: number;
}

export type RunStreamLifecycleEvent =
  | "opened"
  | "unexpected_close"
  | "retrying"
  | "manual_reconnect"
  | "terminal";

export const initialRunStreamLifecycle: RunStreamLifecycle = {
  kind: "connecting",
  retryAttempt: 0,
};

const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_RECONNECT_DELAY_MS = 500;

export function reconnectDelayMs(
  retryAttempt: number,
  lifecycleKind?: RunStreamLifecycleKind,
): number | null {
  if (
    lifecycleKind === "closed" ||
    lifecycleKind === "disconnected" ||
    retryAttempt >= MAX_RETRY_ATTEMPTS
  ) {
    return null;
  }

  return INITIAL_RECONNECT_DELAY_MS * 2 ** retryAttempt;
}

export function buildRunStreamUrl(
  origin: string,
  runId: string,
  lastEventId: number | null,
  replay: boolean,
): string {
  const url = new URL(`/api/runs/${encodeURIComponent(runId)}/stream`, origin);

  if (lastEventId !== null) {
    url.searchParams.set("lastEventId", String(lastEventId));
  }
  if (!replay) {
    url.searchParams.set("replay", "0");
  }

  return url.toString();
}

export function advanceRunStreamLifecycle(
  lifecycle: RunStreamLifecycle,
  event: RunStreamLifecycleEvent,
): RunStreamLifecycle {
  if (event === "terminal") {
    return { kind: "closed", retryAttempt: 0 };
  }
  if (event === "opened") {
    return { kind: "live", retryAttempt: 0 };
  }
  if (event === "manual_reconnect") {
    return { kind: "connecting", retryAttempt: 0 };
  }
  if (event === "retrying") {
    return { kind: "connecting", retryAttempt: lifecycle.retryAttempt };
  }
  if (lifecycle.retryAttempt >= MAX_RETRY_ATTEMPTS) {
    return { kind: "disconnected", retryAttempt: lifecycle.retryAttempt };
  }

  return {
    kind: "reconnecting",
    retryAttempt: lifecycle.retryAttempt + 1,
  };
}
