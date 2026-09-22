// Shared by the execution-host and scheduler-clock operator views so the same
// instant and the same elapsed span never render two different ways on two
// pages an operator reads side by side.
export function formatInstant(
  value: string | null,
  missing: string,
  locale: string,
): string {
  return value
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(value))
    : missing;
}

export function formatDuration(value: number | null, missing: string): string {
  if (value === null) return missing;

  const rounded = Math.round(value);

  if (rounded < 1_000) return `${rounded}ms`;

  const seconds = Math.floor(rounded / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;

  return [
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    remainder > 0 || (hours === 0 && minutes === 0) ? `${remainder}s` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}
