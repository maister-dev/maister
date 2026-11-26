const DEFAULT_NEEDS_INPUT_IDLE_TTL_HOURS = 24;

export function needsInputIdleTtlHours(): number {
  const parsed = Number.parseInt(
    process.env.MAISTER_NEEDSINPUTIDLE_TTL_HOURS ?? "",
    10,
  );

  return Number.isFinite(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_NEEDS_INPUT_IDLE_TTL_HOURS;
}
