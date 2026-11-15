// ADR-208: one multi-unit duration format for every timing surface; units are
// localized by the caller. Missing ≠ 0.
export function formatDurationMs(
  ms: number | null,
  units: { h: string; min: string; s: string },
): string {
  if (ms === null) return "—";

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  if (hours > 0) return `${hours} ${units.h} ${pad(minutes)} ${units.min}`;
  if (minutes > 0) {
    return seconds > 0
      ? `${minutes} ${units.min} ${pad(seconds)} ${units.s}`
      : `${minutes} ${units.min}`;
  }

  return `${seconds} ${units.s}`;
}
