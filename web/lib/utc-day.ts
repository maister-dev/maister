// Whole-UTC-day arithmetic, shared by every surface that filters by calendar
// day (ADR-177 D1). The `/runs` ledger and the Observatory period MUST agree on
// these bounds or a drill-down count can never equal the list it opens.
//
// Deliberately NOT `server-only`: the period resolver is pure and is read by
// client components that build hrefs.

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

export function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

/** `YYYY-MM-DD` → that day's 00:00Z (the inclusive lower bound). */
export function dateStart(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** `YYYY-MM-DD` → the NEXT day's 00:00Z (the exclusive upper bound). */
export function nextDateStart(value: string): Date {
  return addUtcDays(dateStart(value), 1);
}

/** The `YYYY-MM-DD` spelling of an instant's own UTC day. */
export function toUtcDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}
