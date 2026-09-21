import {
  addUtcDays,
  dateStart,
  nextDateStart,
  startOfUtcDay,
  toUtcDateString,
} from "@/lib/utc-day";

// ADR-177 D1. The Observatory period is a half-open interval of WHOLE UTC days.
// Day alignment is what makes an overview cell's count equal the `/runs` list it
// links to: that ledger filters by `dateStart`/`nextDateStart`, so a rolling
// `now - N days` bound could never agree with it.

export const OBSERVATORY_PERIOD_PRESETS = [7, 30, 90] as const;

export type ObservatoryPeriodPreset =
  (typeof OBSERVATORY_PERIOD_PRESETS)[number];

export const DEFAULT_OBSERVATORY_WINDOW_DAYS = 30;
export const MAX_OBSERVATORY_WINDOW_DAYS = 365;

export interface ObservatoryPeriod {
  /** Inclusive lower bound, always 00:00Z. */
  since: Date;
  /** Exclusive upper bound, always 00:00Z. */
  until: Date;
  /** The preset the bar should highlight, or null for a custom/odd window. */
  preset: ObservatoryPeriodPreset | null;
  /** Effective span in whole days (`(until - since) / 1 day`). */
  windowDays: number;
  /** Effective custom bounds, present only for a custom range. */
  from?: string;
  to?: string;
  /** True when the requested span exceeded the 365-day cap. */
  clamped: boolean;
}

export interface ObservatoryPeriodInput {
  now: Date;
  windowDays?: string;
  from?: string;
  to?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRESET_SET: ReadonlySet<number> = new Set(OBSERVATORY_PERIOD_PRESETS);

function isPreset(value: number): value is ObservatoryPeriodPreset {
  return PRESET_SET.has(value);
}

// A real calendar date, not merely a well-shaped string: `2026-02-30` parses in
// JS (it rolls to March 2) and would silently widen the window.
function validDate(value: string | undefined): string | undefined {
  if (!value || !DATE_RE.test(value)) return undefined;

  const parsed = new Date(`${value}T00:00:00.000Z`);

  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

function clampWindowDays(value: string | undefined): number {
  if (!value) return DEFAULT_OBSERVATORY_WINDOW_DAYS;

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) return DEFAULT_OBSERVATORY_WINDOW_DAYS;

  return Math.min(MAX_OBSERVATORY_WINDOW_DAYS, Math.max(1, parsed));
}

function spanDays(since: Date, until: Date): number {
  return Math.round(
    (until.getTime() - since.getTime()) / (24 * 60 * 60 * 1000),
  );
}

function presetPeriod(now: Date, windowDaysRaw: string | undefined) {
  const windowDays = clampWindowDays(windowDaysRaw);
  const until = addUtcDays(startOfUtcDay(now), 1);

  return {
    since: addUtcDays(until, -windowDays),
    until,
    preset: isPreset(windowDays) ? windowDays : null,
    windowDays,
    clamped: false,
  } satisfies ObservatoryPeriod;
}

/**
 * The `[since, until)` bounds a read model should use.
 *
 * Filters carrying both bounds (every page read does) are used verbatim; a
 * caller that supplies neither — the read models' own `filters = {}` default,
 * and most test call sites — gets the documented D1 default, day-aligned like
 * every other window rather than rolling off `now`.
 */
export function observatoryPeriodBounds(
  filters: { since?: Date; until?: Date },
  now: Date,
): { since: Date; until: Date } {
  if (filters.since && filters.until) {
    return { since: filters.since, until: filters.until };
  }

  const fallback = resolveObservatoryPeriod({ now });

  return {
    since: filters.since ?? fallback.since,
    until: filters.until ?? fallback.until,
  };
}

export function resolveObservatoryPeriod(
  input: ObservatoryPeriodInput,
): ObservatoryPeriod {
  const from = validDate(input.from);
  const to = validDate(input.to);

  // Owner decision (ADR-177, resolved question 3): a half-present, unparsable
  // or inverted range is NOT an error — it is dropped and the preset applies.
  if (!from || !to || from > to)
    return presetPeriod(input.now, input.windowDays);

  const until = nextDateStart(to);
  const requestedSince = dateStart(from);
  const clamped = spanDays(requestedSince, until) > MAX_OBSERVATORY_WINDOW_DAYS;
  const since = clamped
    ? addUtcDays(until, -MAX_OBSERVATORY_WINDOW_DAYS)
    : requestedSince;

  return {
    since,
    until,
    preset: null,
    windowDays: spanDays(since, until),
    // The bar renders the EFFECTIVE bounds, never the requested ones.
    from: clamped ? toUtcDateString(since) : from,
    to,
    clamped,
  };
}
