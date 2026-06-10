import "server-only";

export const RETRY_SCHEDULE_MS = [
  60_000, 300_000, 900_000, 3_600_000, 14_400_000, 43_200_000, 86_400_000,
] as const;

export const DEFAULT_MAX_ATTEMPTS = 8 as const;

export const JITTER_RATIO = 0.2 as const;

export type WebhookErrorKind = "timeout" | "network" | "http" | "config";

export type DeliveryClassification =
  | { outcome: "delivered" }
  | { outcome: "dead"; reason: "gone" | "max_attempts" }
  | { outcome: "retry"; errorKind: WebhookErrorKind; delayMs: number };

export function baseDelayMs(attemptCount: number): number {
  const index = Math.min(
    Math.max(attemptCount, 1) - 1,
    RETRY_SCHEDULE_MS.length - 1,
  );

  return RETRY_SCHEDULE_MS[index];
}

export function applyJitter(
  ms: number,
  rng: () => number = Math.random,
): number {
  // Centered ±JITTER_RATIO band (rng 0→1-ratio, 0.5→1.0x, 1→1+ratio). Centering
  // on 1.0 keeps the endpoints exact — the naive `ms * ((1-ratio) + rng()*2*ratio)`
  // rounds rng=1 to 1.2000000000000002 in IEEE-754; this form keeps rng=1 → 1.2x.
  return ms * (1 + (rng() - 0.5) * 2 * JITTER_RATIO);
}

export interface ClassifyResultInput {
  attemptCount: number;
  maxAttempts: number;
  httpStatus?: number;
  errorKind?: WebhookErrorKind;
  rng?: () => number;
}

export function classifyResult(
  input: ClassifyResultInput,
): DeliveryClassification {
  const { attemptCount, maxAttempts, httpStatus, errorKind, rng } = input;

  if (httpStatus != null && httpStatus >= 200 && httpStatus <= 299) {
    return { outcome: "delivered" };
  }

  if (httpStatus === 410) {
    return { outcome: "dead", reason: "gone" };
  }

  if (attemptCount >= maxAttempts) {
    return { outcome: "dead", reason: "max_attempts" };
  }

  const resolvedKind: WebhookErrorKind =
    httpStatus != null ? "http" : (errorKind ?? "network");

  return {
    outcome: "retry",
    errorKind: resolvedKind,
    delayMs: applyJitter(baseDelayMs(attemptCount), rng ?? Math.random),
  };
}
